import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { DesktopOwner } from "../src/hosts/codex/desktop-owner.ts";
import { connectHelperBridge, listenHelperBridge } from "../src/hosts/codex/helper-bridge.ts";
import type { HelperConnection } from "../src/hosts/codex/helper-rpc.ts";

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
