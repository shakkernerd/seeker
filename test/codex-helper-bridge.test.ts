import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { DesktopOwner } from "../src/hosts/codex/desktop-owner.ts";
import { connectHelperBridge, listenHelperBridge, readEventStateBridge } from "../src/hosts/codex/helper-bridge.ts";
import type { HelperConnection } from "../src/hosts/codex/helper-rpc.ts";
import { NativeDesktopHelper } from "../src/hosts/codex/helper-runtime.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner: DesktopOwner = {
  profile: { appPath: "/Applications/Fixture.app", appVersion: "1", appBuild: "1", userDataPath: "/private/profile", codexHome: "/private/codex" },
  app: { pid: 100, parentPid: 1, startedAt: "Mon Oct 19 00:00:00 2026", executable: "/Applications/Fixture.app/Contents/MacOS/Fixture" },
  server: { pid: 101, parentPid: 100, startedAt: "Mon Oct 19 00:00:01 2026", executable: "/Applications/Fixture.app/Contents/Resources/codex" },
};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("bridge did not settle")), 2_000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture() {
  const directory = realpathSync(mkdtempSync("/tmp/seeker-bridge-")), created = deferred<HelperConnection>(), closed = deferred<void>(), approved = deferred<unknown>();
  let creations = 0, closures = 0;
  const bridge = await listenHelperBridge(directory, owner, "/private/native.sock", (profile, pipe, workspace) => {
    creations += 1;
    expect({ profile, pipe, workspace }).toEqual({ profile: owner.profile, pipe: "/private/native.sock", workspace: join(directory, "codex-helper") });
    let connected = true;
    const rpc: HelperConnection = {
      get connected() { return connected; },
      async request(method) {
        if (method === "fixture/error") throw Object.assign(new Error(), { nativeCode: -32600, nativeMessage: "thread not loaded: owned-helper" });
        queueMicrotask(() => { rpc.events?.notice("item/started", { id: "item" }); rpc.events?.request("approval", "mcpServer/elicitation/request", { exact: "arguments" }); });
        return { method };
      },
      notify() {}, respond(id, result) { expect(id).toBe("approval"); approved.resolve(result); }, reject() {},
      async close() { if (connected) { connected = false; closures += 1; closed.resolve(); } },
    };
    created.resolve(rpc); return rpc;
  });
  cleanup.push(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, bridge, created, closed, approved, creations: () => creations, closures: () => closures };
}

test("only the private connector endpoint starts a helper; native requests and receipts stay correlated", async () => {
  const f = await fixture(), endpoint = f.bridge.endpoint;
  expect(statSync(endpoint.socketPath).mode & 0o777).toBe(0o600);
  const wrong = createConnection(endpoint.socketPath), rejected = new Promise<void>((resolve) => wrong.once("close", resolve));
  wrong.on("error", () => {}); wrong.write(JSON.stringify({ credential: "b".repeat(64) }) + "\n");
  await bounded(rejected); expect(f.creations()).toBe(0);
  const remote = await connectHelperBridge(endpoint, f.directory); cleanup.push(() => remote.close());
  const notice = deferred<string>(), approval = deferred<void>();
  remote.events = { notice(method) { notice.resolve(method); }, request(id, method, params) { expect(method).toBe("mcpServer/elicitation/request"); expect(params).toEqual({ exact: "arguments" }); remote.respond(id, { action: "accept" }); approval.resolve(); }, lost() {} };
  expect(await remote.request("initialize", {}, AbortSignal.timeout(1_000))).toEqual({ method: "initialize" });
  expect(await bounded(notice.promise)).toBe("item/started"); await bounded(approval.promise);
  expect(await bounded(f.approved.promise)).toEqual({ action: "accept" }); expect(f.creations()).toBe(1);
  await expect(remote.request("fixture/error", {}, AbortSignal.timeout(1_000))).rejects.toMatchObject({ nativeCode: -32600, nativeMessage: "thread not loaded: owned-helper" });
  await remote.close(); await bounded(f.closed.promise); expect(f.closures()).toBe(1);
  await f.bridge.close(); expect(existsSync(endpoint.socketPath)).toBe(false);
});

test("connector shutdown closes its helper transport and never creates a replacement", async () => {
  const f = await fixture(), remote = await connectHelperBridge(f.bridge.endpoint, f.directory);
  cleanup.push(() => remote.close());
  const lost = deferred<void>(); remote.events = { notice() {}, request() {}, lost() { lost.resolve(); } };
  await remote.request("initialize", {}, AbortSignal.timeout(1_000));
  await f.bridge.close(); await bounded(lost.promise);
  expect(remote.connected).toBe(false); expect(f.creations()).toBe(1); expect(f.closures()).toBe(1);
  await expect(remote.request("initialize", {}, AbortSignal.timeout(1_000))).rejects.toThrow();
  expect(f.creations()).toBe(1);
});

test("remote close waits for child settlement before releasing the runtime", async () => {
  const directory = realpathSync(mkdtempSync("/tmp/seeker-settle-")), entered = deferred<void>(), release = deferred<void>();
  const bridge = await listenHelperBridge(directory, owner, "/private/native.sock", () => ({
    connected: true, request: async () => ({}), notify() {}, respond() {}, reject() {},
    async close() { entered.resolve(); await release.promise; },
  }));
  const remote = await connectHelperBridge(bridge.endpoint, directory);
  cleanup.push(async () => { release.resolve(); await remote.close(); await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  let settled = false;
  const closing = remote.close().then(() => { settled = true; });
  await bounded(entered.promise); await Bun.sleep(10); expect(settled).toBe(false);
  await expect(connectHelperBridge(bridge.endpoint, directory)).rejects.toThrow();
  release.resolve(); await bounded(closing); expect(settled).toBe(true);
});

test("helper paths fit every data directory accepted by the existing native socket budget", async () => {
  const root = realpathSync(mkdtempSync("/tmp/seeker-path-"));
  const directory = join(root, "x".repeat(103 - Buffer.byteLength(root) - 12));
  const { mkdirSync } = await import("node:fs"); mkdirSync(directory, { mode: 0o700 });
  const bridge = await listenHelperBridge(directory, owner, "/private/native.sock", () => { throw new Error("No helper requested"); });
  cleanup.push(async () => { await bridge.close(); rmSync(root, { recursive: true, force: true }); });
  expect(Buffer.byteLength(join(directory, "codex.sock"))).toBe(103);
  expect(Buffer.byteLength(bridge.endpoint.socketPath)).toBe(103);
});


test("an unconfirmed child cleanup fails the remote close and quarantines the bridge", async () => {
  const directory = realpathSync(mkdtempSync("/tmp/seeker-failed-close-"));
  const bridge = await listenHelperBridge(directory, owner, "/private/native.sock", () => ({
    connected: true, request: async () => ({}), notify() {}, respond() {}, reject() {},
    async close() { throw new Error("fixture settlement failed"); },
  }));
  const remote = await connectHelperBridge(bridge.endpoint, directory);
  cleanup.push(async () => { await remote.close().catch(() => {}); await bridge.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); });
  await expect(remote.close()).rejects.toMatchObject({ code: "desktop_helper_cleanup_failed" });
  await expect(connectHelperBridge(bridge.endpoint, directory)).rejects.toThrow();
  await expect(bridge.close()).rejects.toThrow("fixture settlement failed");
});


test("closing the connector preserves an unrelated replacement at its exposed socket path", async () => {
  const f = await fixture(), path = f.bridge.endpoint.socketPath;
  unlinkSync(path); writeFileSync(path, "unrelated fixture replacement", { mode: 0o600 });
  await f.bridge.close();
  expect(readFileSync(path, "utf8")).toBe("unrelated fixture replacement");
});


test("only a verified helper root is archived by its own server before child settlement", async () => {
  const directory = realpathSync(mkdtempSync("/tmp/seeker-retire-")), order: string[] = [];
  const bridge = await listenHelperBridge(directory, owner, "/private/native.sock", () => ({
    connected: true, async request(method, params) {
      if (method === "thread/start") return { thread: { id: "owned-helper", cwd: join(directory, "codex-helper"), forkedFromId: null } };
      if (method === "thread/read") return { thread: { id: "foreign-helper", cwd: "/private/another-workspace", forkedFromId: null } };
      if (method === "turn/start") return { turn: { id: "owned-turn" } };
      throw new Error("unexpected native method");
    }, notify() {}, respond() {}, reject() {}, async close() { order.push("child-settled"); },
  }), async (_rpc, threadId, turnId) => { order.push("retired:" + threadId + ":" + turnId); });
  const remote = await connectHelperBridge(bridge.endpoint, directory);
  cleanup.push(async () => { await remote.close(); await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  await expect(remote.request("thread/read", { threadId: "foreign-helper" }, AbortSignal.timeout(1_000))).rejects.toThrow();
  expect(order).toEqual([]);
  await remote.request("thread/start", {}, AbortSignal.timeout(1_000));
  await remote.request("turn/start", { threadId: "owned-helper" }, AbortSignal.timeout(1_000));
  await remote.close(); expect(order).toEqual(["retired:owned-helper:owned-turn", "child-settled"]);
});


test("existing connector bridge returns only event metadata without starting or replacing a helper", async () => {
  const directory = realpathSync(mkdtempSync("/tmp/seeker-event-reader-"));
  let created = 0, reads = 0;
  const bridge = await listenHelperBridge(directory, owner, "/private/native.sock", () => { created += 1; throw new Error("A read cannot create a helper"); }, undefined, async (origin) => {
    reads += 1; return { taskId: origin.threadId, turnId: "armed-turn", status: "interrupted" };
  });
  cleanup.push(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  expect(await readEventStateBridge(bridge.endpoint, directory, { threadId: "native-task", turnId: "armed-turn", callId: "armed-call" }, AbortSignal.timeout(1000))).toEqual({ taskId: "native-task", turnId: "armed-turn", status: "interrupted" });
  expect(created).toBe(0); expect(reads).toBe(1);
  await expect(readEventStateBridge({ ...bridge.endpoint, credential: "f".repeat(64) }, directory, { threadId: "native-task", turnId: "armed-turn", callId: "armed-call" }, AbortSignal.timeout(1000))).rejects.toThrow();
  expect(reads).toBe(1);
});


test("a late settlement acknowledgment survives the close deadline without another child", async () => {
  const directory = realpathSync(mkdtempSync("/tmp/seeker-late-settle-")), release = deferred<void>();
  let creations = 0, settled = false;
  const bridge = await listenHelperBridge(directory, owner, "/private/native.sock", () => {
    creations++;
    return { connected: true, request: async () => ({}), notify() {}, respond() { throw new Error("No send permitted"); }, reject() {},
      async close() { await release.promise; settled = true; } };
  });
  const remote = await connectHelperBridge(bridge.endpoint, directory);
  cleanup.push(async () => { release.resolve(); await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  await expect(remote.close()).rejects.toMatchObject({ code: "desktop_helper_cleanup_failed" });
  expect(settled).toBe(false); expect(creations).toBe(1); expect(remote.connected).toBe(false);
  await expect(connectHelperBridge(bridge.endpoint, directory)).rejects.toThrow();
  release.resolve();
  await remote.close();
  expect(settled).toBe(true); expect(creations).toBe(1);
}, 10_000);

test("same-connection cleanup rechecks keep the child fenced and archive only once", async () => {
  const directory = realpathSync(mkdtempSync("/tmp/seeker-recheck-"));
  let childSettled = false, allowClose = false, creations = 0, archives = 0, closes = 0;
  const bridge = await listenHelperBridge(directory, owner, "/private/native.sock", () => {
    creations++;
    return { get connected() { return !childSettled; }, async request(method) {
      if (method === "thread/start") return { thread: { id: "owned", cwd: join(directory, "codex-helper") } };
      if (method === "turn/start") return { turn: { id: "turn" } };
      throw new Error("unexpected request");
    }, notify() {}, respond() { throw new Error("No send permitted"); }, reject() {},
    async close() { closes++; if (!allowClose) throw new Error("child still running"); childSettled = true; } };
  }, async () => { archives++; });
  const remote = await connectHelperBridge(bridge.endpoint, directory);
  cleanup.push(async () => { allowClose = true; await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  await remote.request("thread/start", {}, AbortSignal.timeout(1000));
  await remote.request("turn/start", { threadId: "owned" }, AbortSignal.timeout(1000));
  await expect(remote.close()).rejects.toMatchObject({ code: "desktop_helper_cleanup_failed" });
  await expect(remote.close()).rejects.toMatchObject({ code: "desktop_helper_cleanup_failed" });
  expect(childSettled).toBe(false); expect(creations).toBe(1); expect(closes).toBe(2); expect(archives).toBe(1);
  await expect(connectHelperBridge(bridge.endpoint, directory)).rejects.toThrow();
  allowClose = true; await remote.close();
  expect(childSettled).toBe(true); expect(closes).toBe(3); expect(archives).toBe(1);
  const next = await connectHelperBridge(bridge.endpoint, directory);
  expect(creations).toBe(2); await next.close();
});

test("child settlement cannot erase a failed archive on a cleanup recheck", async () => {
  const directory = realpathSync(mkdtempSync("/tmp/seeker-retire-failed-"));
  let childSettled = false, archives = 0, creations = 0;
  const bridge = await listenHelperBridge(directory, owner, "/private/native.sock", () => {
    creations++;
    return { get connected() { return !childSettled; }, async request(method) {
      if (method === "thread/start") return { thread: { id: "owned", cwd: join(directory, "codex-helper") } };
      return { turn: { id: "turn" } };
    }, notify() {}, respond() {}, reject() {}, async close() { childSettled = true; } };
  }, async () => { archives++; throw new Error("archive unconfirmed"); });
  const remote = await connectHelperBridge(bridge.endpoint, directory);
  cleanup.push(async () => { await bridge.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); });
  await remote.request("thread/start", {}, AbortSignal.timeout(1000));
  await remote.request("turn/start", { threadId: "owned" }, AbortSignal.timeout(1000));
  await expect(remote.close()).rejects.toMatchObject({ code: "desktop_helper_cleanup_failed" });
  expect(childSettled).toBe(true);
  await expect(remote.close()).rejects.toMatchObject({ code: "desktop_helper_cleanup_failed" });
  expect(archives).toBe(1); expect(creations).toBe(1);
  await expect(connectHelperBridge(bridge.endpoint, directory)).rejects.toThrow();
  await expect(bridge.close()).rejects.toThrow("archive unconfirmed");
});

async function relocatedFixture(savedThread: Record<string, unknown> = {}, startedThread: Record<string, unknown> = {}) {
  const directory = realpathSync(mkdtempSync("/tmp/seeker-relocate-")), workspace = join(directory, "codex-helper");
  const previousWorkspace = "/private/old-seeker/codex-helper", statePath = join(workspace, "session.json");
  const saved = { version: 1, threadId: "saved-helper", turns: 1, previousWorkspace };
  mkdirSync(workspace, { mode: 0o700 }); writeFileSync(statePath, JSON.stringify(saved) + "\n", { mode: 0o600 });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const bridge = await listenHelperBridge(directory, owner, "/private/native.sock", () => ({
    connected: true, async request(method, input) {
      const params = input as Record<string, unknown>; calls.push({ method, params });
      if (method === "initialize" || method === "thread/delete") return {};
      if (method === "config/read") return { config: {} };
      if (method === "thread/read") return { thread: { id: "saved-helper", cwd: previousWorkspace, forkedFromId: null, ...savedThread } };
      if (method === "thread/start") return { thread: { id: "new-helper", cwd: workspace, forkedFromId: null, ...startedThread } };
      if (method === "turn/start") return { turn: { id: "new-turn" } };
      if (method === "mcpServerStatus/list") return { data: [{ name: "codex_app", runtimeStatus: "connected", tools: {
        send_message_to_thread: { inputSchema: { type: "object", properties: { threadId: { type: "string" }, prompt: { type: "string" } } } },
      } }], nextCursor: null };
      throw new Error("Unexpected native request: " + method);
    }, notify() {}, respond() { throw new Error("No delivery approval permitted"); }, reject() {}, async close() {},
  }), async () => {});
  const runtime = new NativeDesktopHelper({ prepare: async () => ({ owner, pipePath: "/private/native.sock" }) }, directory,
    (_profile, _pipe, _workspace, signal) => connectHelperBridge(bridge.endpoint, directory, signal));
  cleanup.push(async () => { await runtime.close(); await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, workspace, previousWorkspace, statePath, saved, calls, bridge, runtime,
    prepare: () => runtime.prepare({ notice() {}, request() { throw new Error("No model turn expected"); }, lost() {} }, AbortSignal.timeout(2_000), () => true) };
}

test("a migrated helper is verified and retired through the production bridge before a new root starts", async () => {
  const f = await relocatedFixture(), helper = await f.prepare();
  expect(f.calls.filter(call => call.method.startsWith("thread/"))).toEqual([
    { method: "thread/read", params: { threadId: "saved-helper", includeTurns: false } },
    { method: "thread/delete", params: { threadId: "saved-helper" } },
    { method: "thread/start", params: expect.objectContaining({ cwd: f.workspace }) },
  ]);
  expect(JSON.parse(readFileSync(f.statePath, "utf8"))).toEqual({ version: 1, threadId: "new-helper", turns: 0 });
  expect(await helper.start("fixture input", AbortSignal.timeout(1_000))).toBe("new-turn");
  expect(f.calls.filter(call => call.method === "turn/start")[0]!.params.threadId).toBe("new-helper");
});

test("relocation never admits a mismatched ID, missing or foreign workspace, or forked root", async () => {
  for (const savedThread of [{ id: "foreign-helper" }, { cwd: undefined }, { cwd: "/private/foreign/codex-helper" }, { forkedFromId: "another-root" }]) {
    const f = await relocatedFixture(savedThread);
    await expect(f.prepare()).rejects.toThrow();
    expect(f.calls.filter(call => ["thread/delete", "thread/start", "turn/start"].includes(call.method))).toEqual([]);
    expect(JSON.parse(readFileSync(f.statePath, "utf8"))).toEqual(f.saved);
  }
});

test("the previous workspace permits only the exact saved helper retirement", async () => {
  const f = await relocatedFixture(), remote = await connectHelperBridge(f.bridge.endpoint, f.directory);
  cleanup.push(() => remote.close());
  const request = (method: string, params: Record<string, unknown>) => remote.request(method, params, AbortSignal.timeout(1_000));
  await expect(request("thread/read", { threadId: "foreign-helper" })).rejects.toThrow();
  await request("thread/read", { threadId: "saved-helper" });
  await expect(request("thread/delete", { threadId: "foreign-helper" })).rejects.toThrow();
  await expect(request("turn/start", { threadId: "saved-helper" })).rejects.toThrow();
  expect(f.calls.some(call => call.method === "thread/delete" || call.method === "turn/start")).toBe(false);
  await request("thread/delete", { threadId: "saved-helper" });
  const wrongStart = await relocatedFixture({}, { cwd: f.previousWorkspace });
  await expect(wrongStart.prepare()).rejects.toThrow();
  expect(wrongStart.calls.some(call => call.method === "turn/start")).toBe(false);
});
