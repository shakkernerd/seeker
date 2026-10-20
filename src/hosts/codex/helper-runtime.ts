import type { EventOwner } from "../../events.ts";
import type { NativeEventState } from "./event-state.ts";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { privateDirectory, readPrivateFile } from "./config.ts";
import type { CodexDesktopLifecycle } from "./desktop.ts";
import type { DesktopProfile } from "./desktop-owner.ts";
import { HelperRpc, HelperRpcError, type HelperConnection, type HelperEvents } from "./helper-rpc.ts";
import { ConnectorError, identifier, onlyKeys, record } from "./protocol.ts";

export interface PreparedHelper {
  readonly rpc: HelperConnection;
  readonly threadId: string;
  start(prompt: string, signal: AbortSignal): Promise<string>;
}
export interface DesktopHelperRuntime {
  readEventState?(owner: EventOwner, signal: AbortSignal): Promise<NativeEventState>;
  prepare(events: HelperEvents, signal: AbortSignal, current: () => boolean): Promise<PreparedHelper>;
  reset(): Promise<void>;
  close(): Promise<void>;
}
interface HelperState { version: 1; threadId: string; turns: number; previousWorkspace?: string }
export type ConnectHelper = (profile: DesktopProfile, pipePath: string, workspace: string, signal: AbortSignal) => HelperConnection | Promise<HelperConnection>;

/** Shared by the service lifecycle and the connector's owned-root admission. */
export function parseHelperState(contents: string): HelperState {
  const value = record(JSON.parse(contents)); onlyKeys(value, ["version", "threadId", "turns", "previousWorkspace"]);
  if (value.version !== 1 || !Number.isSafeInteger(value.turns) || (value.turns as number) < 0 || (value.turns as number) > 16) throw unavailable("The helper lifecycle record needs reconciliation.");
  if (value.previousWorkspace !== undefined && (typeof value.previousWorkspace !== "string" || !value.previousWorkspace.startsWith("/") || !value.previousWorkspace.endsWith("/codex-helper"))) throw unavailable("The relocated helper workspace needs reconciliation.");
  return { version: 1, threadId: identifier(value.threadId), turns: value.turns as number, ...(typeof value.previousWorkspace === "string" ? { previousWorkspace: value.previousWorkspace } : {}) };
}

/** The installed CLI entrypoint keeps its real binary resolution and signal forwarding role. */
export function codexLauncher(): string {
  const selected = (process.env.PATH ?? "").split(":").filter((entry) => entry.startsWith("/")).map((entry) => join(entry, "codex")).find((entry) => {
    try { accessSync(entry, constants.X_OK); return true; } catch { return false; }
  });
  if (!selected) throw unavailable("Install the official Codex npm CLI and make codex available on Seeker's PATH.");
  const path = realpathSync(selected), root = dirname(dirname(path));
  const pkg = record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
  const bin = typeof pkg.bin === "string" ? pkg.bin : record(pkg.bin).codex;
  if (pkg.name !== "@openai/codex" || typeof bin !== "string" || realpathSync(resolve(root, bin)) !== path || !path.endsWith(".js")) throw unavailable("Seeker requires the unmodified official Codex npm CLI entrypoint.");
  return path;
}

export function connectDesktopHelper(profile: DesktopProfile, pipePath: string, workspace: string): HelperConnection {
  const node = join(profile.appPath, "Contents/Resources/cua_node/bin/node");
  const settings = [
    'features.plugins=false', 'features.apps=false',
    'features.tool_call_mcp_elicitation=true', 'model_reasoning_effort="low"',
    'features.multi_agent=false', 'features.multi_agent_v2=false', 'features.shell_tool=false',
    'features.shell_snapshot=false', 'features.shell_snapshot_v2=false',
    'features.browser_use=false', 'features.computer_use=false', 'features.image_generation=false', 'features.view_image=false',
    'features.memories=false', 'features.skill_search=false', 'features.hooks=false',
    'features.goals=false', 'features.sleep_tool=false', 'features.tool_suggest=false',
    'features.workspace_dependencies=false', 'features.skill_mcp_dependency_install=false',
    'tools.update_plan.enabled=false', 'tools.experimental_request_user_input.enabled=false',
    'web_search="disabled"', 'check_for_update_on_startup=false',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "USER", "PATH", "LANG", "LC_ALL", "TMPDIR"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.CODEX_HOME = profile.codexHome;
  env.CODEX_SQLITE_HOME = profile.sqliteHome;
  env.CODEX_APP_TOOLS_PIPE_PATH = pipePath;
  env.CODEX_MCP_NODE_PATH = node;
  return new HelperRpc(node, [codexLauncher(), "app-server", "--listen", "stdio://", ...settings.flatMap((value) => ["-c", value])], workspace, env);
}

function isolatedServers(effective: unknown, profile: DesktopProfile): Record<string, unknown> {
  const servers = effective === undefined ? {} : record(effective);
  // Native config overlays merge tables. Refuse a name collision rather than
  // inheriting a user's command, environment, headers, or approval defaults.
  if (Object.hasOwn(servers, "codex_app")) throw unavailable("The helper's native tool server conflicts with a configured codex_app server.");
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(servers).map(([name, value]) => {
    const server = record(value);
    // Disabled entries still need a valid transport when an earlier CLI layer
    // is replaced. Do not forward arguments, environments, headers or auth.
    const transport = typeof server.command === "string" ? { command: server.command } : typeof server.url === "string" ? { url: server.url } : undefined;
    if (!transport) throw unavailable("A configured native tool server has an unrecognized transport.");
    return [name, { ...transport, enabled: false }];
  }));
  const bundled = join(profile.appPath, "Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools");
  result.codex_app = {
    enabled: true, command: join(bundled, "scripts/launch_codex_app_tools_mcp"), args: [join(bundled, "server.mjs")], cwd: bundled,
    env_vars: ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "HOME", "PATH"],
    enabled_tools: ["send_message_to_thread"], default_tools_approval_mode: "prompt",
    tools: { send_message_to_thread: { approval_mode: "prompt" } }, startup_timeout_sec: 10, tool_timeout_sec: 10,
  };
  return result;
}

/** One bounded native helper history; delivery authority stays in the exchange store. */
export class NativeDesktopHelper implements DesktopHelperRuntime {
  readonly #workspace: string;
  readonly #statePath: string;
  #state?: HelperState;
  #saved?: string;
  #rpc?: HelperConnection;
  #opening?: Promise<HelperConnection>;
  #closed = false;
  readonly #readLifetime = new AbortController();
  readonly #reads = new Set<Promise<NativeEventState>>();
  #generation = 0;
  #resetting?: Promise<void>;

  constructor(private readonly lifecycle: Pick<CodexDesktopLifecycle, "prepare">, dataDir: string, private readonly connect: ConnectHelper, private readonly eventReader?: (owner: EventOwner, signal: AbortSignal) => Promise<NativeEventState>) {
    mkdirSync(join(privateDirectory(dataDir), "codex-helper"), { mode: 0o700, recursive: true });
    this.#workspace = privateDirectory(join(dataDir, "codex-helper"));
    this.#statePath = join(this.#workspace, "session.json");
    if (existsSync(this.#statePath)) {
      this.#saved = readPrivateFile(this.#statePath);
      this.#state = parseHelperState(this.#saved);
    }
  }

  async readEventState(owner: EventOwner, signal: AbortSignal): Promise<NativeEventState> {
    if (this.#closed || !this.eventReader) throw unavailable("The native event metadata reader is unavailable.");
    const reading = this.eventReader(owner, AbortSignal.any([signal, this.#readLifetime.signal]));
    this.#reads.add(reading);
    try { return await reading; }
    finally { this.#reads.delete(reading); }
  }

  async prepare(events: HelperEvents, signal: AbortSignal, current: () => boolean): Promise<PreparedHelper> {
    // Settle the previous owned process before creating a fresh bounded helper.
    // The Desktop may adopt its source thread when a native tool is called; a
    // new CLI must not resume a root whose writer now belongs to that Desktop.
    await this.reset();
    const generation = ++this.#generation;
    const check = () => {
      signal.throwIfAborted();
      if (this.#closed || generation !== this.#generation || !current()) throw unavailable("This helper job is no longer current.");
    };
    check();
    const { owner, pipePath } = await this.lifecycle.prepare(signal, current);
    check();
    const opening = Promise.resolve().then(() => this.connect(owner.profile, pipePath, this.#workspace, signal)).then((connection) => {
      // Adopt even a late, cancelled opening until its close confirms settlement.
      this.#rpc = connection;
      return connection;
    });
    this.#opening = opening;
    let rpc: HelperConnection | undefined;
    try {
      rpc = await opening; check();
    } catch (error) { await this.reset(); throw error; }
    finally { if (this.#opening === opening) this.#opening = undefined; }
    rpc.events = events;
    await rpc.request("initialize", { clientInfo: { name: "seeker_desktop_helper", version: "0.1.0" }, capabilities: { experimentalApi: true } }, signal);
    check(); rpc.notify("initialized", {});
    const config = record(record(await rpc.request("config/read", { cwd: this.#workspace, includeLayers: false }, signal)).config);
    check();
    const servers = isolatedServers(config.mcp_servers, owner.profile);
    const options = { cwd: this.#workspace, approvalPolicy: "on-request", sandbox: "read-only", config: { model_reasoning_effort: "low", mcp_servers: servers } };
    if (this.#state) {
      let saved: Record<string, unknown> | undefined;
      try { saved = record(record(await rpc.request("thread/read", { threadId: this.#state.threadId, includeTurns: false }, signal)).thread); }
      catch (error) {
        if (!(error instanceof HelperRpcError) || error.nativeCode !== -32600 || error.nativeMessage !== `thread not loaded: ${this.#state.threadId}`) throw error;
        check(); this.#save(undefined);
      }
      check();
      if (saved && (saved.id !== this.#state?.threadId || (saved.cwd !== this.#workspace && (this.#state?.previousWorkspace === undefined || saved.cwd !== this.#state.previousWorkspace)) || saved.forkedFromId != null)) throw unavailable("The saved root is not this service's owned helper.");
      if (this.#state && saved) {
        await rpc.request("thread/delete", { threadId: this.#state.threadId }, signal);
        check(); this.#save(undefined);
      }
    }
    const response = record(await rpc.request("thread/start", { ...options, ephemeral: false, environments: [] }, signal));
    check();
    const thread = record(response.thread), threadId = identifier(thread.id);
    if (thread.cwd !== this.#workspace || (this.#state && threadId !== this.#state.threadId)) throw unavailable("The native helper has a different identity or workspace.");
    if (!this.#state) this.#save({ version: 1, threadId, turns: 0 });
    // MCP startup is qualified before any model turn, so an unavailable Desktop
    // does not produce repeated model turns merely to poll for its return.
    const inventory = record(await rpc.request("mcpServerStatus/list", { threadId, limit: 100 }, signal));
    const rows = inventory.data;
    if (!Array.isArray(rows) || inventory.nextCursor != null) throw unavailable("The native helper did not expose an isolated tool inventory.");
    const names = new Set<string>();
    for (const value of rows) {
      const entry = record(value), name = identifier(entry.name);
      if (names.has(name) || !Object.hasOwn(servers, name) || (name !== "codex_app" && (entry.runtimeStatus !== "disabled" || Object.keys(record(entry.tools)).length !== 0))) throw unavailable("The native helper exposed an unexpected tool server.");
      names.add(name);
    }
    const server = record(rows.find((value) => record(value).name === "codex_app")), tools = record(server.tools);
    if (server.name !== "codex_app" || server.runtimeStatus !== "connected" || Object.keys(tools).length !== 1 || !Object.hasOwn(tools, "send_message_to_thread")) throw unavailable("The original Desktop's isolated native input tool is unavailable.");
    const schema = record(record(tools.send_message_to_thread).inputSchema), properties = record(schema.properties);
    if (schema.type !== "object" || record(properties.threadId).type !== "string" || record(properties.prompt).type !== "string" || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((field) => field !== "threadId" && field !== "prompt")))) throw unavailable("The native input tool has an incompatible schema.");
    check();
    return {
      rpc, threadId,
      start: async (prompt, turnSignal) => {
        check();
        this.#save({ ...this.#state!, turns: this.#state!.turns + 1 });
        // An explicit empty environment list applies to every fresh helper turn:
        // this model turn has no shell, patch, or local-image environment.
        const result = record(await rpc.request("turn/start", { threadId, input: [{ type: "text", text: prompt }], effort: "low", environments: [] }, turnSignal));
        return identifier(record(result.turn).id);
      },
    };
  }

  reset(): Promise<void> {
    if (this.#resetting) return this.#resetting;
    this.#generation += 1;
    const rpc = this.#rpc, opening = this.#opening;
    const closing = (async () => {
      const opened = await opening?.catch(() => undefined);
      const connections = new Set([rpc, opened].filter((connection) => connection !== undefined));
      const results = await Promise.allSettled([...connections].map((connection) => connection.close()));
      for (const result of results) if (result.status === "rejected") throw result.reason;
      if (this.#rpc === rpc || this.#rpc === opened) this.#rpc = undefined;
    })();
    this.#resetting = closing;
    void closing.finally(() => { if (this.#resetting === closing) this.#resetting = undefined; }).catch(() => {});
    return closing;
  }
  async close(): Promise<void> { this.#closed = true; this.#readLifetime.abort(); await Promise.allSettled([...this.#reads]); await this.reset(); }

  #save(value: HelperState | undefined): void {
    if (this.#closed) throw unavailable("The helper is closed.");
    if (this.#saved !== undefined && readPrivateFile(this.#statePath) !== this.#saved) throw unavailable("The helper lifecycle record changed outside this service.");
    if (!value) { unlinkSync(this.#statePath); this.#state = undefined; this.#saved = undefined; return; }
    const contents = `${JSON.stringify(value)}\n`, temporary = `${this.#statePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
      if (this.#saved === undefined) linkSync(temporary, this.#statePath); else renameSync(temporary, this.#statePath);
      this.#state = value; this.#saved = contents;
    } finally { try { unlinkSync(temporary); } catch { /* A successful rename consumed it. */ } }
  }
}
function unavailable(message: string): ConnectorError { return new ConnectorError("desktop_helper_unavailable", message, 503); }
