import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopOwner } from "../src/hosts/codex/desktop-owner.ts";
import { HelperRpcError, type HelperConnection, type HelperEvents } from "../src/hosts/codex/helper-rpc.ts";
import { NativeDesktopHelper } from "../src/hosts/codex/helper-runtime.ts";

type ObjectValue = Record<string, unknown>;
interface State { version: 1; threadId: string; turns: number }
interface Call { connection: number; method: string; params: ObjectValue }
interface NativePlan {
  servers?: ObjectValue;
  savedThread?: ObjectValue;
  readError?: Error;
  deleteError?: Error;
  inventory?: unknown;
  after?: (method: string) => void;
  close?: () => Promise<void>;
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const events: HelperEvents = { notice: () => {}, request: () => {}, lost: () => {} };
const signal = () => new AbortController().signal;
const inventory = () => ({ data: [{ name: "codex_app", runtimeStatus: "connected", tools: {
  send_message_to_thread: { inputSchema: { type: "object", properties: { threadId: { type: "string" }, prompt: { type: "string" } }, required: ["threadId", "prompt"] } },
} }], nextCursor: null });

function fixture(plans: NativePlan[] = [{}], state?: State) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "seeker-helper-runtime-")));
  const workspace = join(directory, "codex-helper"), statePath = join(workspace, "session.json");
  if (state) { mkdirSync(workspace, { mode: 0o700 }); writeFileSync(statePath, JSON.stringify(state) + "\n", { mode: 0o600 }); }
  const owner: DesktopOwner = {
    profile: { appPath: "/Applications/Fixture.app", appVersion: "1.0.0", appBuild: "1", userDataPath: "/private/fixture/desktop", codexHome: "/private/fixture/codex", sqliteHome: "/private/fixture/sqlite" },
    app: { pid: 101, parentPid: 1, executable: "/Applications/Fixture.app/Contents/MacOS/Fixture", startedAt: "Sat Sep 19 10:00:00 2026" },
    server: { pid: 102, parentPid: 101, executable: "/Applications/Fixture.app/Contents/Resources/codex", startedAt: "Sat Sep 19 10:00:01 2026" },
  };
  const calls: Call[] = [], connections: HelperConnection[] = [], order: string[] = [], runtimes: NativeDesktopHelper[] = [];
  const factory = (profile: DesktopOwner["profile"], pipe: string, cwd: string): HelperConnection => {
    expect({ profile, pipe, cwd }).toEqual({ profile: owner.profile, pipe: "/private/fixture/native.sock", cwd: workspace });
    const connection = connections.length, plan = plans[connection] ?? {};
    let closed = false;
    const rpc: HelperConnection = {
      get connected() { return !closed; },
      request: async (method, input, requestSignal) => {
        requestSignal.throwIfAborted();
        if (closed) throw new Error("request on a closed native process");
        const params = input as ObjectValue;
        calls.push({ connection, method, params }); order.push(connection + ":" + method);
        let result: unknown;
        switch (method) {
          case "initialize": result = {}; break;
          case "config/read": result = { config: { mcp_servers: plan.servers ?? {} } }; break;
          case "thread/read":
            if (plan.readError) throw plan.readError;
            result = { thread: { id: params.threadId, cwd: workspace, forkedFromId: null, ...plan.savedThread } }; break;
          case "thread/delete":
            if (plan.deleteError) throw plan.deleteError;
            result = {}; break;
          case "thread/start": result = { thread: { id: "helper-" + (connection + 1), cwd: workspace } }; break;
          case "thread/resume": result = { thread: { id: params.threadId, cwd: workspace } }; break;
          case "mcpServerStatus/list": result = plan.inventory ?? inventory(); break;
          case "turn/start": result = { turn: { id: "turn-" + (connection + 1) } }; break;
          default: throw new Error("Unexpected native method: " + method);
        }
        plan.after?.(method);
        return result;
      },
      notify: (method) => { order.push(connection + ":" + method); },
      respond: () => { throw new Error("Runtime preparation must not grant a tool call"); },
      reject: () => {},
      close: async () => { if (!closed) { await plan.close?.(); closed = true; order.push(connection + ":closed"); } },
    };
    connections.push(rpc); return rpc;
  };
  const createRuntime = () => {
    const runtime = new NativeDesktopHelper({ prepare: async () => ({ owner, pipePath: "/private/fixture/native.sock" }) }, directory, factory);
    runtimes.push(runtime); return runtime;
  };
  cleanups.push(async () => { try { for (const runtime of runtimes) await runtime.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const runtime = createRuntime();
  return { runtime, createRuntime, workspace, statePath, calls, connections, order,
    state: () => JSON.parse(readFileSync(statePath, "utf8")) as State,
    prepare: (abortSignal = signal()) => runtime.prepare(events, abortSignal, () => true),
  };
}
const requests = (calls: Call[], method: string) => calls.filter((call) => call.method === method);
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

test("empty private data creates a private helper workspace and disables every inherited MCP server before startup", async () => {
  const servers = {
    "other.server": { enabled: true, command: "/fixture/never-start", args: ["private-argument"], env: { FIXTURE_ONLY: "private-value" } },
    ordinary: { url: "https://fixture.invalid/mcp", http_headers: { "X-Fixture": "private-value" }, bearer_token_env_var: "FIXTURE_TOKEN" },
  };
  const reported = { ...inventory(), data: [...inventory().data, { name: "other.server", runtimeStatus: "disabled", tools: {} }, { name: "ordinary", runtimeStatus: "disabled", tools: {} }] };
  const f = fixture([{ servers, inventory: reported }]);
  expect(statSync(f.workspace).mode & 0o777).toBe(0o700); expect(readdirSync(f.workspace)).toEqual([]);
  const helper = await f.prepare();
  expect(requests(f.calls, "config/read")[0]!.params).toEqual({ cwd: f.workspace, includeLayers: false });
  const start = requests(f.calls, "thread/start")[0]!;
  expect(start.params).toMatchObject({ cwd: f.workspace, approvalPolicy: "on-request", sandbox: "read-only", ephemeral: false, environments: [] });
  const overrides = (start.params.config as ObjectValue).mcp_servers as ObjectValue;
  expect(Object.keys(overrides).sort()).toEqual(["codex_app", "ordinary", "other.server"]);
  expect(overrides["other.server"]).toEqual({ command: servers["other.server"].command, enabled: false });
  expect(overrides.ordinary).toEqual({ url: servers.ordinary.url, enabled: false });
  expect(overrides.codex_app).toMatchObject({ enabled: true, enabled_tools: ["send_message_to_thread"], default_tools_approval_mode: "prompt", tools: { send_message_to_thread: { approval_mode: "prompt" } } });
  expect(f.order.indexOf("0:config/read")).toBeLessThan(f.order.indexOf("0:thread/start"));
  expect(servers["other.server"].enabled).toBe(true);
  expect(f.state()).toEqual({ version: 1, threadId: helper.threadId, turns: 0 });
  expect(statSync(f.statePath).mode & 0o777).toBe(0o600);
  expect(requests(f.calls, "turn/start")).toHaveLength(0);
  expect(await helper.start("One exact notification", signal())).toBe("turn-1");
  expect(requests(f.calls, "turn/start")[0]!.params).toEqual({ threadId: helper.threadId, input: [{ type: "text", text: "One exact notification" }], effort: "low", environments: [] });
  expect(f.state().turns).toBe(1);
});

test("a configured codex_app name cannot merge its command or environment into the helper", async () => {
  const f = fixture([{ servers: { codex_app: { command: "/fixture/unrelated", enabled: false, env: { UNRELATED: "private" } } } }]);
  await expect(f.prepare()).rejects.toThrow("conflicts with a configured codex_app server");
  expect(requests(f.calls, "thread/start")).toHaveLength(0); expect(requests(f.calls, "thread/resume")).toHaveLength(0);
  expect(existsSync(f.statePath)).toBe(false);
});

test("active or unknown inherited servers, extra tools, duplicates and pagination fail before model input", async () => {
  const base = inventory();
  const activeServer = { ...base, data: [...base.data, { name: "ordinary", runtimeStatus: "connected", tools: {} }] };
  const unknownServer = { ...base, data: [...base.data, { name: "unexpected", runtimeStatus: "disabled", tools: {} }] };
  const extraTool = inventory(); Object.assign(extraTool.data[0]!.tools, { read_thread: {} });
  const incompatibleSchema = inventory(); incompatibleSchema.data[0]!.tools.send_message_to_thread.inputSchema.required.push("model");
  for (const value of [activeServer, unknownServer, extraTool, { ...base, data: [...base.data, ...base.data] }, { ...base, nextCursor: "more" }, incompatibleSchema]) {
    const f = fixture([{ servers: { ordinary: { command: "/fixture/ordinary-server" } }, inventory: value }]);
    await expect(f.prepare()).rejects.toThrow();
    expect(requests(f.calls, "mcpServerStatus/list")).toHaveLength(1);
    expect(requests(f.calls, "turn/start")).toHaveLength(0);
  }
});

test("each preparation settles its old process and re-enumerates config before a cold resume", async () => {
  const closing = deferred(), settled = deferred();
  const f = fixture([
    { servers: { previous: { command: "/fixture/previous-server" } }, close: async () => { closing.resolve(); await settled.promise; } },
    { servers: { "new.server": { enabled: true, url: "https://fixture.invalid/mcp" } } },
  ]);
  cleanups.push(async () => { settled.resolve(); });
  const first = await f.prepare();
  const next = f.prepare(); await closing.promise;
  try { expect(f.connections).toHaveLength(1); } finally { settled.resolve(); }
  const second = await next;
  expect(f.connections[0]!.connected).toBe(false); expect(second.threadId).toBe(first.threadId);
  expect(f.order.indexOf("0:closed")).toBeLessThan(f.order.indexOf("1:config/read"));
  expect(requests(f.calls, "config/read")).toHaveLength(2);
  const resume = requests(f.calls, "thread/resume")[0]!;
  expect(resume.params).toMatchObject({ threadId: first.threadId, excludeTurns: true, config: { mcp_servers: { "new.server": { enabled: false } } } });
  expect(Object.keys((resume.params.config as ObjectValue).mcp_servers as ObjectValue).sort()).toEqual(["codex_app", "new.server"]);
  await expect(first.start("Stale preparation", signal())).rejects.toThrow("no longer current");
  expect(requests(f.calls, "turn/start")).toHaveLength(0);
});

test("rotation reads and verifies the saved root before deleting only that helper", async () => {
  const f = fixture([{}], { version: 1, threadId: "owned-helper", turns: 16 });
  const prepared = await f.prepare();
  expect(requests(f.calls, "thread/read")[0]!.params).toEqual({ threadId: "owned-helper", includeTurns: false });
  expect(requests(f.calls, "thread/delete").map((call) => call.params)).toEqual([{ threadId: "owned-helper" }]);
  expect(f.order.indexOf("0:thread/read")).toBeLessThan(f.order.indexOf("0:thread/delete"));
  expect(f.order.indexOf("0:thread/delete")).toBeLessThan(f.order.indexOf("0:thread/start"));
  expect(requests(f.calls, "thread/resume")).toHaveLength(0);
  expect(f.state()).toEqual({ version: 1, threadId: prepared.threadId, turns: 0 });
});

test("a different identity, workspace or fork root preserves the lifecycle record and forbids deletion", async () => {
  for (const savedThread of [{ id: "business-manager" }, { cwd: "/private/unrelated-workspace" }, { forkedFromId: "business-manager" }]) {
    const state: State = { version: 1, threadId: "owned-helper", turns: 16 }, f = fixture([{ savedThread }], state);
    const before = readFileSync(f.statePath, "utf8");
    await expect(f.prepare()).rejects.toThrow("not this service's owned helper");
    expect(requests(f.calls, "thread/delete")).toHaveLength(0); expect(requests(f.calls, "thread/start")).toHaveLength(0);
    expect(readFileSync(f.statePath, "utf8")).toBe(before);
  }
});

test("restart after a completed deletion recovers only a native missing-thread result", async () => {
  const aborted = new AbortController();
  const f = fixture([
    { after: (method) => { if (method === "thread/delete") aborted.abort(); } },
    { readError: new HelperRpcError(-32600, "thread not loaded: owned-helper") },
  ], { version: 1, threadId: "owned-helper", turns: 16 });
  await expect(f.prepare(aborted.signal)).rejects.toThrow();
  expect(f.state().threadId).toBe("owned-helper");
  expect(requests(f.calls, "thread/start")).toHaveLength(0);
  await f.runtime.close();
  const recovered = f.createRuntime(), helper = await recovered.prepare(events, signal(), () => true);
  expect(f.state()).toEqual({ version: 1, threadId: helper.threadId, turns: 0 });
  expect(requests(f.calls, "thread/delete")).toHaveLength(1);
  expect(requests(f.calls, "thread/start")).toHaveLength(1);
});

test("other read errors and deletion conflicts preserve the saved helper instead of replacing it", async () => {
  const plans: NativePlan[] = [
    { readError: new HelperRpcError(-32602, "thread not loaded: owned-helper") },
    { readError: new HelperRpcError(-32600, "thread not loaded: different-helper") },
    { readError: new HelperRpcError(-32600, "thread not found: owned-helper") },
    { readError: new HelperRpcError(-32600, "thread is busy: owned-helper") },
    { readError: new Error("thread not loaded: owned-helper") },
    { deleteError: new HelperRpcError(-32600, "thread has an active writer") },
  ];
  for (const plan of plans) {
    const f = fixture([plan], { version: 1, threadId: "owned-helper", turns: 16 });
    const before = readFileSync(f.statePath, "utf8");
    await expect(f.prepare()).rejects.toThrow();
    expect(readFileSync(f.statePath, "utf8")).toBe(before);
    expect(requests(f.calls, "thread/start")).toHaveLength(0); expect(requests(f.calls, "thread/resume")).toHaveLength(0);
    expect(requests(f.calls, "turn/start")).toHaveLength(0);
  }
});

test("cancellation between preparation stages cannot proceed to model input", async () => {
  for (const stage of ["initialize", "config/read", "mcpServerStatus/list"]) {
    const aborted = new AbortController();
    const f = fixture([{ after: (method) => { if (method === stage) aborted.abort(); } }]);
    await expect(f.prepare(aborted.signal)).rejects.toThrow();
    expect(f.calls.at(-1)!.method).toBe(stage); expect(requests(f.calls, "turn/start")).toHaveLength(0);
  }
  const aborted = new AbortController(), f = fixture(), ready = await f.prepare(aborted.signal);
  aborted.abort();
  await expect(ready.start("No longer requested", signal())).rejects.toThrow();
  expect(requests(f.calls, "turn/start")).toHaveLength(0); expect(f.state().turns).toBe(0);
});

test("an externally replaced lifecycle file is preserved before starting a model turn", async () => {
  const f = fixture(), ready = await f.prepare();
  writeFileSync(f.statePath, "externally replaced private lifecycle\n", { mode: 0o600 });
  await expect(ready.start("Must not replace another owner's state", signal())).rejects.toThrow("changed outside this service");
  expect(readFileSync(f.statePath, "utf8")).toBe("externally replaced private lifecycle\n");
  expect(requests(f.calls, "turn/start")).toHaveLength(0);
});
