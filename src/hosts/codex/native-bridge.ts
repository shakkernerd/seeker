import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { privateDirectory } from "./config.ts";
import type { ThreadState } from "../../contracts.ts";
import type { CodexNativeClient, NativeSendArguments, NativeSendOutcome } from "./native.ts";
import { ConnectorError, identifier, maxWireBytes, onlyKeys, parseInvocation, record, type NativeInvocation } from "./protocol.ts";

/** The bridge request a connector answers; a connector from an earlier release has no `protocol` and only answers older requests. */
export const bridgeProtocol = 2;
export interface BridgeEndpoint { socketPath: string; credential: string; protocol?: number }
export type NativeSender = (origin: NativeInvocation, args: NativeSendArguments, signal: AbortSignal, current: () => boolean) => Promise<NativeSendOutcome>;
const unavailable = () => new ConnectorError("desktop_connector_unavailable", "The qualified Desktop connector's native bridge is unavailable.", 503);
const outcomes = ["accepted", "refused", "uncertain"];

export function parseBridgeEndpoint(value: unknown): BridgeEndpoint {
  const item = record(value); onlyKeys(item, ["socketPath", "credential", "protocol"]);
  if (typeof item.socketPath !== "string" || !/^\.h[a-f0-9]{8}$/.test(item.socketPath.slice(item.socketPath.lastIndexOf("/") + 1)) || typeof item.credential !== "string" || !/^[a-f0-9]{64}$/.test(item.credential)) throw unavailable();
  if (item.protocol !== undefined && (!Number.isSafeInteger(item.protocol) || (item.protocol as number) < 1)) throw unavailable();
  return { socketPath: item.socketPath, credential: item.credential, ...(item.protocol === undefined ? {} : { protocol: item.protocol as number }) };
}

/**
 * Only the already qualified Desktop child can reach the native tool socket, so
 * the connector answers one authenticated send request per connection on the
 * service's behalf. Nothing here starts a process or a model turn.
 */
export async function listenNativeBridge(dataDir: string, native: Pick<CodexNativeClient, "send" | "threadState">) {
  const directory = privateDirectory(dataDir);
  const endpoint: BridgeEndpoint = { socketPath: join(directory, `.h${randomBytes(4).toString("hex")}`), credential: randomBytes(32).toString("hex"), protocol: bridgeProtocol };
  const sockets = new Set<Socket>(), sends = new Set<Promise<unknown>>();
  let closed = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "", handled = false;
    const timer = setTimeout(() => socket.destroy(), 2_000); timer.unref();
    const write = (value: unknown) => { if (!socket.destroyed) { socket.write(`${JSON.stringify(value)}\n`); socket.end(); } };
    socket.setEncoding("utf8"); socket.on("error", () => socket.destroy()); socket.once("close", () => { clearTimeout(timer); sockets.delete(socket); });
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) { if (Buffer.byteLength(buffer) > maxWireBytes) socket.destroy(); return; }
      handled = true; clearTimeout(timer);
      try {
        if (closed) throw unavailable();
        const message = record(JSON.parse(buffer.slice(0, end)));
        onlyKeys(message, ["credential", "nativeSend", "threadState"]);
        if (message.credential !== endpoint.credential) throw unavailable();
        if (message.threadState !== undefined) {
          if (message.nativeSend !== undefined) throw unavailable();
          const read = record(message.threadState); onlyKeys(read, ["origin", "threadId"]);
          const origin = parseInvocation(read.origin), threadId = identifier(read.threadId);
          if (sends.size >= 4) throw unavailable();
          const reading = native.threadState(origin, threadId, AbortSignal.timeout(4_000))
            .then((state) => write({ threadState: state }), () => { socket.destroy(); });
          sends.add(reading); void reading.finally(() => sends.delete(reading));
          return;
        }
        const request = record(message.nativeSend); onlyKeys(request, ["origin", "arguments"]);
        const origin = parseInvocation(request.origin), args = record(request.arguments); onlyKeys(args, ["threadId", "prompt"]);
        if (typeof args.prompt !== "string" || !args.prompt || Buffer.byteLength(args.prompt) > 16_384) throw unavailable();
        if (sends.size >= 4) throw unavailable();
        // The service already chose the target; the stamp is what the host receives as provenance.
        const sending = native.send(origin, { threadId: identifier(args.threadId), prompt: args.prompt }, AbortSignal.timeout(8_000))
          .then((outcome) => write({ nativeSend: outcome }), () => write({ nativeSend: { status: "uncertain", code: "native_send_failed" } }));
        sends.add(sending); void sending.finally(() => sends.delete(sending));
      } catch { socket.destroy(); }
    });
  });
  // Node removes its bound pathname automatically on close. Bind a private
  // staging address and expose a separate hard link, as the service listener does.
  const staging = join(directory, `.b${randomBytes(4).toString("hex")}`);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(staging, resolve); });
  let inode: ReturnType<typeof lstatSync>;
  try { chmodSync(staging, 0o600); inode = lstatSync(staging); linkSync(staging, endpoint.socketPath); }
  catch (error) { await new Promise<void>((resolve) => server.close(() => resolve())); throw error; }
  let closing: Promise<void> | undefined;
  return { endpoint, close: () => closing ??= (async () => {
    closed = true;
    await Promise.allSettled([...sends]);
    for (const socket of sockets) socket.destroy();
    let bound: ReturnType<typeof lstatSync> | undefined;
    try { bound = lstatSync(staging); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!bound || bound.dev !== inode.dev || bound.ino !== inode.ino) {
      server.unref();
      throw new ConnectorError("desktop_bridge_cleanup_failed", "The bridge's bound socket address changed; preserve its replacement.", 503);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const current = lstatSync(endpoint.socketPath);
      if (current.dev === inode.dev && current.ino === inode.ino) unlinkSync(endpoint.socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  })() };
}

/** The service's side: one latest-turn read of a task through the connector; nothing is sent to anyone. */
export async function threadStateBridge(endpoint: BridgeEndpoint, dataDir: string, origin: NativeInvocation, threadId: string, signal: AbortSignal): Promise<ThreadState> {
  const parsed = parseBridgeEndpoint(endpoint);
  if (dirname(parsed.socketPath) !== privateDirectory(dataDir)) throw unavailable();
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(parsed.socketPath); } catch { throw unavailable(); }
  if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw unavailable();
  const socket = createConnection(parsed.socketPath);
  return new Promise((resolve, reject) => {
    let buffer = "", settled = false;
    const finish = (value?: ThreadState) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); socket.destroy();
      if (value) resolve(value); else reject(unavailable());
    };
    const abort = () => finish(), timer = setTimeout(abort, 5_000); timer.unref();
    socket.setEncoding("utf8"); socket.once("error", abort); socket.once("close", abort);
    socket.on("data", (chunk: string) => {
      buffer += chunk; if (Buffer.byteLength(buffer) > 2_048) return abort();
      const end = buffer.indexOf("\n"); if (end < 0) return;
      try {
        const message = record(JSON.parse(buffer.slice(0, end))); onlyKeys(message, ["threadState"]);
        const state = record(message.threadState); onlyKeys(state, ["taskId", "turnId", "status"]);
        if (state.taskId !== threadId || !["inProgress", "completed", "interrupted", "failed"].includes(String(state.status))) throw unavailable();
        finish({ taskId: identifier(state.taskId), turnId: identifier(state.turnId), status: state.status as ThreadState["status"] });
      } catch { abort(); }
    });
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => { if (signal.aborted) abort(); else socket.write(`${JSON.stringify({ credential: parsed.credential, threadState: { origin, threadId } })}\n`); });
    if (signal.aborted) abort();
  });
}

/**
 * The service's side: one send over the connector's authenticated bridge. The
 * caller's `current` check runs immediately before the request is written, so
 * a cancellation, owner change or settled reply committed while the socket
 * connected still withholds the send. A failure before the request is written
 * is definitely unsent; a lost answer after it is uncertain, because the
 * connector may have completed the call.
 */
export async function nativeSendBridge(endpoint: BridgeEndpoint, dataDir: string, origin: NativeInvocation, args: NativeSendArguments, signal: AbortSignal, current: () => boolean = () => true): Promise<NativeSendOutcome> {
  const parsed = parseBridgeEndpoint(endpoint);
  if (dirname(parsed.socketPath) !== privateDirectory(dataDir)) throw unavailable();
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(parsed.socketPath); } catch { throw unavailable(); }
  if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw unavailable();
  const socket = createConnection(parsed.socketPath);
  return new Promise((resolve, reject) => {
    let buffer = "", settled = false, written = false, stale = false;
    const finish = (value?: NativeSendOutcome) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); socket.destroy();
      if (value) resolve(value);
      else if (written) resolve({ status: "uncertain", code: "desktop_bridge_lost" });
      else if (stale) reject(new ConnectorError("delivery_not_current", "The delivery is no longer current; nothing was sent.", 409));
      else reject(unavailable());
    };
    const abort = () => finish(), timer = setTimeout(abort, 10_000); timer.unref();
    socket.setEncoding("utf8"); socket.once("error", abort); socket.once("close", abort);
    socket.on("data", (chunk: string) => {
      buffer += chunk; if (Buffer.byteLength(buffer) > 2_048) return abort();
      const end = buffer.indexOf("\n"); if (end < 0) return;
      try {
        const message = record(JSON.parse(buffer.slice(0, end))); onlyKeys(message, ["nativeSend"]);
        const outcome = record(message.nativeSend);
        if (!outcomes.includes(String(outcome.status))) throw unavailable();
        if (outcome.status === "accepted") { onlyKeys(outcome, ["status", "threadId"]); if (outcome.threadId !== args.threadId) throw unavailable(); finish({ status: "accepted", threadId: args.threadId }); return; }
        onlyKeys(outcome, ["status", "code"]);
        finish({ status: outcome.status as "refused" | "uncertain", code: identifier(outcome.code) });
      } catch { finish(written ? { status: "uncertain", code: "desktop_bridge_unrecognized" } : undefined); }
    });
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      if (signal.aborted) return abort();
      // Nothing asynchronous belongs between this currency check and the write.
      if (!current()) { stale = true; return abort(); }
      written = true;
      socket.write(`${JSON.stringify({ credential: parsed.credential, nativeSend: { origin, arguments: args } })}\n`);
    });
    if (signal.aborted) abort();
  });
}
