import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeProtocol, listenNativeBridge, nativeSendBridge, parseBridgeEndpoint } from "../src/hosts/codex/native-bridge.ts";
import type { NativeSendArguments, NativeSendOutcome } from "../src/hosts/codex/native.ts";
import type { NativeInvocation } from "../src/hosts/codex/protocol.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const origin: NativeInvocation = { threadId: "owner-task", turnId: "armed-turn", callId: "fresh-call" };
const args: NativeSendArguments = { threadId: "owner-task", prompt: "Seeker recorded a machine background event for this task." };

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "sk-bridge-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const sends: { origin: NativeInvocation; args: NativeSendArguments }[] = [];
  let outcome: NativeSendOutcome | Error = { status: "accepted", threadId: "owner-task" };
  const bridge = await listenNativeBridge(dataDir, { async send(nextOrigin, nextArgs) { sends.push({ origin: nextOrigin, args: nextArgs }); if (outcome instanceof Error) throw outcome; return outcome; } });
  cleanups.push(() => bridge.close().catch(() => {}));
  return { dataDir, bridge, sends, outcome: (value: NativeSendOutcome | Error) => { outcome = value; } };
}

test("the service's send crosses the authenticated bridge and returns the connector's native outcome unchanged", async () => {
  const f = await fixture();
  expect(lstatSync(f.bridge.endpoint.socketPath).mode & 0o077).toBe(0);
  expect(f.bridge.endpoint.protocol).toBe(bridgeProtocol);
  expect(parseBridgeEndpoint(f.bridge.endpoint)).toEqual(f.bridge.endpoint);
  expect(parseBridgeEndpoint({ socketPath: f.bridge.endpoint.socketPath, credential: f.bridge.endpoint.credential }).protocol).toBeUndefined();
  expect(() => parseBridgeEndpoint({ ...f.bridge.endpoint, protocol: "2" })).toThrow();
  // The caller's currency check runs immediately before the request is written; a stale delivery sends nothing.
  await expect(nativeSendBridge(f.bridge.endpoint, f.dataDir, origin, args, new AbortController().signal, () => false)).rejects.toMatchObject({ code: "delivery_not_current" });
  expect(f.sends).toHaveLength(0);
  expect(await nativeSendBridge(f.bridge.endpoint, f.dataDir, origin, args, new AbortController().signal)).toEqual({ status: "accepted", threadId: "owner-task" });
  expect(f.sends).toEqual([{ origin, args }]);
  f.outcome({ status: "refused", code: "native_unavailable" });
  expect(await nativeSendBridge(f.bridge.endpoint, f.dataDir, origin, args, new AbortController().signal)).toEqual({ status: "refused", code: "native_unavailable" });
  f.outcome(new Error("pipe gone"));
  expect(await nativeSendBridge(f.bridge.endpoint, f.dataDir, origin, args, new AbortController().signal)).toEqual({ status: "uncertain", code: "native_send_failed" });
  // A confirmed target other than the one requested is not acceptance of this send.
  f.outcome({ status: "accepted", threadId: "another-task" });
  expect(await nativeSendBridge(f.bridge.endpoint, f.dataDir, origin, args, new AbortController().signal)).toEqual({ status: "uncertain", code: "desktop_bridge_unrecognized" });
});

test("wrong credentials, malformed requests and a closed bridge never reach the native tool", async () => {
  const f = await fixture();
  const forged = { ...f.bridge.endpoint, credential: "b".repeat(64) };
  // The request was written before the bridge dropped it, so the caller cannot claim it was unsent.
  expect(await nativeSendBridge(forged, f.dataDir, origin, args, new AbortController().signal)).toEqual({ status: "uncertain", code: "desktop_bridge_lost" });
  await new Promise<void>((resolve) => {
    const socket = createConnection(f.bridge.endpoint.socketPath);
    socket.once("close", () => resolve());
    socket.once("connect", () => socket.write(`${JSON.stringify({ credential: f.bridge.endpoint.credential, nativeSend: { origin, arguments: { ...args, role: "manager" } } })}\n`));
  });
  expect(f.sends).toHaveLength(0);
  expect(() => parseBridgeEndpoint({ socketPath: "/tmp/.h1234", credential: f.bridge.endpoint.credential })).toThrow();
  await expect(nativeSendBridge(f.bridge.endpoint, join(f.dataDir, "elsewhere"), origin, args, new AbortController().signal)).rejects.toThrow();
  await f.bridge.close();
  await expect(nativeSendBridge(f.bridge.endpoint, f.dataDir, origin, args, new AbortController().signal)).rejects.toThrow();
  expect(f.sends).toHaveLength(0);
});

test("the bridge bounds concurrent sends and settles them before closing", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = await listenNativeBridge(f.dataDir, { async send() { await gate; return { status: "accepted", threadId: "owner-task" }; } });
  cleanups.push(() => slow.close().catch(() => {}));
  const inflight = Array.from({ length: 4 }, () => nativeSendBridge(slow.endpoint, f.dataDir, origin, args, new AbortController().signal));
  await Bun.sleep(20);
  expect(await nativeSendBridge(slow.endpoint, f.dataDir, origin, args, new AbortController().signal)).toEqual({ status: "uncertain", code: "desktop_bridge_lost" });
  const closing = slow.close();
  release();
  expect((await Promise.all(inflight)).every((outcome) => outcome.status === "accepted")).toBe(true);
  await closing;
  expect(() => lstatSync(slow.endpoint.socketPath)).toThrow();
});
