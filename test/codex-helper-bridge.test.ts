import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
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
