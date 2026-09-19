import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SeekerCore } from "../src/core/seeker.ts";
import { cliConfigPath, cliHostId, readCliConfig } from "../src/hosts/codex-cli/config.ts";
import { prepareCliReload } from "../src/hosts/codex-cli/reload.ts";
import { setupCodexCli } from "../src/hosts/codex-cli/setup.ts";
import { readConnectorConfig, readConnectorCredential } from "../src/hosts/codex/config.ts";
import { setupCodex } from "../src/hosts/codex/setup.ts";
import { seekerTools } from "../src/hosts/codex/tools.ts";
import { localRecipient } from "../src/local/channel.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const taskId = "00000000-0000-7000-8000-000000000001";
const otherTaskId = "00000000-0000-7000-8000-000000000002";
const setups = { cli: setupCodexCli, desktop: setupCodex };
const credentialDigest = (path: string) => createHash("sha256").update(readConnectorCredential(path)).digest("hex");

function projectFixture() {
  // A short, private path also fits the macOS Unix-socket address limit.
  const root = realpathSync(mkdtempSync("/tmp/seeker-setup-")), project = join(root, "work");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(project);
  return { root, project };
}

test.each(["cli", "desktop"] as const)("%s-first setup preserves both hosts and one project MCP section", (firstHost) => {
  const { root, project } = projectFixture(), data = join(root, "data"), pkg = join(root, "package");
  mkdirSync(join(pkg, "bin"), { recursive: true }); mkdirSync(join(pkg, "dist"));
  // Setup checks package entrypoints; this fixture never executes either file.
  writeFileSync(join(pkg, "bin", "seeker-codex"), "controlled package fixture");
  writeFileSync(join(pkg, "dist", "codex-connector.mjs"), "controlled package fixture");
  mkdirSync(join(project, ".codex"));
  const projectConfigPath = join(project, ".codex", "config.toml");
  const existing = 'model = "fixture-model"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n[mcp_servers.other]\ncommand = "retained-server"\nargs = ["--keep"]\nenabled = true\n';
  writeFileSync(projectConfigPath, existing, { mode: 0o640 });
  const store = new SqliteExchangeStore(":memory:"), core = new SeekerCore(store);
  cleanups.push(() => store.close());
  const options = { core, dataDir: data, projectDirectory: project, packageDirectory: pkg, threadId: taskId, recipient: localRecipient };
  const setup = (host: keyof typeof setups) => setups[host]({ ...options, label: `${host} fixture manager` });
  const first = setup(firstHost), firstRegistration = readConnectorConfig(first.configPath);
  const firstConfigBytes = readFileSync(first.configPath, "utf8"), firstCredential = credentialDigest(firstRegistration.credentialFile);
  if (firstHost === "cli") {
    expect(readCliConfig(first.configPath).hostId).toBe(cliHostId);
    expect(existsSync(join(data, "codex-connector.json"))).toBe(false);
    expect(existsSync(join(data, "codex.key"))).toBe(false);
    expect(core.managerBinding("codex-desktop", taskId)).toBeUndefined();
  }

  // Preserve a real operator edit when installing the other native host later.
  const initial = readFileSync(projectConfigPath, "utf8");
  const customized = initial.replace(
    "enabled = true\nrequired = false\nstartup_timeout_sec = 10\ntool_timeout_sec = 15",
    "enabled = false\nrequired = true\nstartup_timeout_sec = 3.5\ntool_timeout_sec = 45",
  );
  expect(customized).not.toBe(initial);
  writeFileSync(projectConfigPath, customized);
  const secondHost = firstHost === "cli" ? "desktop" : "cli", second = setup(secondHost);
  const secondRegistration = readConnectorConfig(second.configPath), secondCredential = credentialDigest(secondRegistration.credentialFile);
  expect(first.configPath).not.toBe(second.configPath);
  expect(firstRegistration.socketPath).not.toBe(secondRegistration.socketPath);
  expect(firstRegistration.credentialFile).not.toBe(secondRegistration.credentialFile);
  expect(firstCredential).not.toBe(secondCredential);
  expect(readFileSync(first.configPath, "utf8")).toBe(firstConfigBytes);
  expect(credentialDigest(firstRegistration.credentialFile)).toBe(firstCredential);
  expect(readCliConfig(cliConfigPath(data)).hostId).toBe(cliHostId);
  expect(readConnectorConfig(join(data, "codex-connector.json")).hostId).toBe("codex-desktop");
  // The same UUID in two host namespaces must retain separate manager bindings.
  for (const configured of [first, second]) {
    expect(core.managerBinding(configured.binding.origin.hostId, taskId)).toEqual(configured.binding);
    expect(lstatSync(configured.configPath).mode & 0o777).toBe(0o600);
  }
  expect(first.binding.id).not.toBe(second.binding.id);
  const installed = readFileSync(projectConfigPath, "utf8");
  expect(installed).toBe(customized);
  expect(installed.match(/^\[mcp_servers\.seeker\]$/gm)).toHaveLength(1);
  expect(installed.startsWith(existing)).toBe(true);
  expect(Bun.TOML.parse(installed)).toMatchObject({
    model: "fixture-model", approval_policy: "on-request", sandbox_mode: "read-only",
    mcp_servers: {
      other: { command: "retained-server", args: ["--keep"], enabled: true },
      seeker: { command: join(pkg, "bin", "seeker-codex"), args: ["--config", join(data, "codex-connector.json"), "--runtime", process.execPath], enabled: false, required: true, startup_timeout_sec: 3.5, tool_timeout_sec: 45 },
    },
  });
  expect(lstatSync(projectConfigPath).mode & 0o777).toBe(0o640);
  setup(firstHost); setup(secondHost);
  expect(readFileSync(projectConfigPath, "utf8")).toBe(installed);
  expect(credentialDigest(firstRegistration.credentialFile)).toBe(firstCredential);
  expect(credentialDigest(secondRegistration.credentialFile)).toBe(secondCredential);
  for (const configured of [first, second]) expect(core.managerBinding(configured.binding.origin.hostId, taskId)).toEqual(configured.binding);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
type Message = { id?: string; method: string; params?: unknown };
type Socket = Bun.ServerWebSocket<undefined>;
type PendingRequest = { socket: Socket; message: Message };
const respond = ({ socket, message }: PendingRequest, result: unknown) => socket.send(JSON.stringify({ id: message.id, result }));

function nativeFixture() {
  const { root, project } = projectFixture(), socketPath = join(root, "native.sock");
  const messages: Message[] = [], closed = deferred<void>();
  const thread = { id: taskId, cwd: project, status: { type: "idle" } };
  const behavior = { request: (_pending: PendingRequest) => {} };
  const server = Bun.serve<undefined>({
    unix: socketPath,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as Message; messages.push(message);
        const pending = { socket, message };
        if (message.method === "initialize") respond(pending, { userAgent: "controlled-cli-setup-fixture" });
        else if (message.method === "thread/read") respond(pending, { thread });
        else if (message.method !== "initialized") behavior.request(pending);
      },
      close() { closed.resolve(); },
    },
  });
  cleanups.push(async () => { await server.stop(true); });
  chmodSync(socketPath, 0o600);
  return { project, socketPath, messages, thread, behavior, closed };
}

test.each(["task", "project", "unloaded task"] as const)("explicit reload rejects target mismatch (%s) before changing native MCP state", async (mismatch) => {
  const f = nativeFixture();
  if (mismatch === "task") f.thread.id = otherTaskId;
  else if (mismatch === "project") f.thread.cwd = join(f.project, "another-project");
  else f.thread.status.type = "notLoaded";
  await expect(prepareCliReload(f.socketPath, taskId, f.project)).rejects.toMatchObject({ code: "wrong_cli_target" });
  await f.closed.promise;
  expect(f.messages.map((message) => message.method)).toEqual(["initialize", "initialized", "thread/read"]);
  expect(f.messages.at(-1)?.params).toEqual({ threadId: taskId, includeTurns: false });
});

test("verified reload waits for this task's connected Seeker runtime and complete inventory without discovery errors", async () => {
  const f = nativeFixture();
  const fullTools = Object.fromEntries(seekerTools.map((tool) => [tool.name, tool]));
  const connected = { name: "seeker", runtimeStatus: "connected", toolsError: null, tools: fullTools };
  const notReady = [
    { ...connected, name: "another-server" },
    { ...connected, tools: Object.fromEntries(seekerTools.slice(0, -1).map((tool) => [tool.name, tool])) },
    { name: "seeker", tools: fullTools },
    { ...connected, runtimeStatus: null },
    { ...connected, runtimeStatus: "starting" },
    { ...connected, toolsError: "Controlled tool discovery failure" },
  ];
  const inventoryRequests = Array.from({ length: notReady.length + 1 }, () => deferred<PendingRequest>());
  let inventories = 0;
  f.behavior.request = (pending) => {
    if (pending.message.method === "config/mcpServer/reload") respond(pending, {});
    else if (pending.message.method === "mcpServerStatus/list") inventoryRequests[inventories++]?.resolve(pending);
  };
  const prepared = await prepareCliReload(f.socketPath, taskId, f.project);
  cleanups.push(() => prepared.close());
  expect(f.messages.map((message) => message.method)).toEqual(["initialize", "initialized", "thread/read"]);
  expect(f.messages.at(-1)?.params).toEqual({ threadId: taskId, includeTurns: false });
  const reloading = prepared.reload();
  const nextInventory = (index: number) => Promise.race([
    inventoryRequests[index]!.promise,
    reloading.then(() => { throw new Error("Reload completed before the target runtime was connected with a complete, error-free Seeker inventory."); }),
  ]);
  for (const [index, status] of notReady.entries()) {
    const pending = await nextInventory(index);
    expect(pending.message.params).toEqual({ threadId: taskId, detail: "toolsAndAuthOnly", limit: 100 });
    respond(pending, { data: [status] });
  }
  const last = await nextInventory(notReady.length);
  expect(last.message.params).toEqual({ threadId: taskId, detail: "toolsAndAuthOnly", limit: 100 });
  respond(last, { data: [connected] });
  await reloading;
  expect(f.messages.find((message) => message.method === "config/mcpServer/reload")?.params).toBeNull();
  expect(f.messages.map((message) => message.method)).toEqual([
    "initialize", "initialized", "thread/read", "config/mcpServer/reload",
    ...inventoryRequests.map(() => "mcpServerStatus/list"),
  ]);
  prepared.close(); await f.closed.promise;
});
