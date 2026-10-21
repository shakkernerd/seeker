import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeProtocol, listenNativeBridge, nativeSendBridge, parseBridgeEndpoint, threadStateBridge } from "../src/hosts/codex/native-bridge.ts";
import type { ThreadState } from "../src/contracts.ts";
import type { NativeSendArguments, NativeSendOutcome } from "../src/hosts/codex/native.ts";
import type { NativeInvocation } from "../src/hosts/codex/protocol.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const origin: NativeInvocation = { threadId: "owner-task", turnId: "armed-turn", callId: "fresh-call" };
const args: NativeSendArguments = { threadId: "owner-task", prompt: "Seeker recorded a machine background event for this task." };

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "sk-bridge-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const sends: { origin: NativeInvocation; args: NativeSendArguments }[] = [], reads: { origin: NativeInvocation; threadId: string }[] = [];
  let outcome: NativeSendOutcome | Error = { status: "accepted", threadId: "owner-task" };
  let state: ThreadState | Error = { taskId: "lead-task", turnId: "lead-turn", status: "interrupted" };
  const bridge = await listenNativeBridge(dataDir, {
    async send(nextOrigin, nextArgs) { sends.push({ origin: nextOrigin, args: nextArgs }); if (outcome instanceof Error) throw outcome; return outcome; },
    async threadState(nextOrigin, threadId) { reads.push({ origin: nextOrigin, threadId }); if (state instanceof Error) throw state; return state; },
  });
  cleanups.push(() => bridge.close().catch(() => {}));
  return { dataDir, bridge, sends, reads, outcome: (value: NativeSendOutcome | Error) => { outcome = value; }, state: (value: ThreadState | Error) => { state = value; } };
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
  const slow = await listenNativeBridge(f.dataDir, { async send() { await gate; return { status: "accepted", threadId: "owner-task" }; }, async threadState() { throw new Error("unused"); } });
  cleanups.push(() => slow.close().catch(() => {}));
  const inflight = Array.from({ length: 4 }, () => nativeSendBridge(slow.endpoint, f.dataDir, origin, args, new AbortController().signal));
  await Bun.sleep(20);
  // The fifth send is refused before any native call, so the service knows it was not sent.
  expect(await nativeSendBridge(slow.endpoint, f.dataDir, origin, args, new AbortController().signal)).toEqual({ status: "refused", code: "desktop_bridge_busy" });
  const closing = slow.close();
  release();
  expect((await Promise.all(inflight)).every((outcome) => outcome.status === "accepted")).toBe(true);
  await closing;
  expect(() => lstatSync(slow.endpoint.socketPath)).toThrow();
});

test("a thread-state read crosses the bridge with the watcher's stamp and returns only the latest turn's identity", async () => {
  const f = await fixture();
  const reader = { threadId: "manager-task", turnId: "manager-turn", callId: "read-call" };
  expect(await threadStateBridge(f.bridge.endpoint, f.dataDir, reader, "lead-task", new AbortController().signal)).toEqual({ taskId: "lead-task", turnId: "lead-turn", status: "interrupted" });
  expect(f.reads).toEqual([{ origin: reader, threadId: "lead-task" }]);
  // The turn's completion time, when the host gives it, crosses the bridge with the state.
  f.state({ taskId: "lead-task", turnId: "lead-turn", status: "completed", completedAt: 1_792_549_446_000 });
  expect(await threadStateBridge(f.bridge.endpoint, f.dataDir, reader, "lead-task", new AbortController().signal)).toEqual({ taskId: "lead-task", turnId: "lead-turn", status: "completed", completedAt: 1_792_549_446_000 });
  f.state({ taskId: "lead-task", turnId: "lead-turn", status: "interrupted" });
  expect(f.sends).toHaveLength(0);
  // A task the host cannot read is reported as unreadable, which keeps the connector for its sends.
  f.state(Object.assign(new Error("not loaded"), { code: "native_call_failed" }));
  await expect(threadStateBridge(f.bridge.endpoint, f.dataDir, reader, "lead-task", new AbortController().signal)).rejects.toMatchObject({ code: "desktop_thread_unreadable" });
  expect(await nativeSendBridge(f.bridge.endpoint, f.dataDir, origin, args, new AbortController().signal)).toEqual({ status: "accepted", threadId: "owner-task" });
  f.state({ taskId: "other-task", turnId: "t", status: "failed" });
  await expect(threadStateBridge(f.bridge.endpoint, f.dataDir, reader, "lead-task", new AbortController().signal)).rejects.toMatchObject({ code: "desktop_connector_unavailable" });
  // The caller's own cancellation is reported as such, not as a lost connector.
  const early = new AbortController(); early.abort();
  await expect(threadStateBridge(f.bridge.endpoint, f.dataDir, reader, "lead-task", early.signal)).rejects.toMatchObject({ code: "desktop_request_cancelled" });
  await expect(nativeSendBridge(f.bridge.endpoint, f.dataDir, origin, args, early.signal)).rejects.toMatchObject({ code: "desktop_request_cancelled" });
  // One connection carries one operation.
  await new Promise<void>((resolve) => {
    const socket = createConnection(f.bridge.endpoint.socketPath);
    socket.once("close", () => resolve());
    socket.once("connect", () => socket.write(`${JSON.stringify({ credential: f.bridge.endpoint.credential, threadState: { origin: reader, threadId: "lead-task" }, nativeSend: { origin: reader, arguments: args } })}\n`));
  });
  expect(f.reads).toHaveLength(4); expect(f.sends).toHaveLength(1);
});
