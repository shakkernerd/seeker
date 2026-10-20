import { CodexNativeClient } from "./native.ts";
import type { NativeEventState } from "./event-state.ts";
import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { privateDirectory, readPrivateFile } from "./config.ts";
import type { DesktopOwner } from "./desktop-owner.ts";
import { connectDesktopHelper, parseHelperState } from "./helper-runtime.ts";
import { HelperRpc, type HelperConnection } from "./helper-rpc.ts";
import { ConnectorError, identifier, maxWireBytes, onlyKeys, parseInvocation, record, type NativeInvocation } from "./protocol.ts";

export interface HelperEndpoint { socketPath: string; credential: string }
const unavailable = () => new ConnectorError("desktop_helper_unavailable", "The qualified Desktop connector's helper is unavailable.", 503);

export function parseHelperEndpoint(value: unknown): HelperEndpoint {
  const item = record(value); onlyKeys(item, ["socketPath", "credential"]);
  if (typeof item.socketPath !== "string" || !/^\.h[a-f0-9]{8}$/.test(item.socketPath.slice(item.socketPath.lastIndexOf("/") + 1)) || typeof item.credential !== "string" || !/^[a-f0-9]{64}$/.test(item.credential)) throw unavailable();
  return { socketPath: item.socketPath, credential: item.credential };
}

/** Only the already qualified Desktop child creates native helper processes. */
export async function listenHelperBridge(dataDir: string, owner: DesktopOwner, pipePath: string, connect = connectDesktopHelper, retire = async (rpc: HelperConnection, threadId: string, _turnId: string) => { await rpc.request("thread/archive", { threadId }, AbortSignal.timeout(3_000)); }, readEvent?: (origin: NativeInvocation, signal: AbortSignal) => Promise<NativeEventState>) {
  const directory = privateDirectory(dataDir), workspace = join(directory, "codex-helper");
  mkdirSync(workspace, { recursive: true, mode: 0o700 }); privateDirectory(workspace);
  const ownsRelocatedRoot = (threadId: string, cwd: unknown) => {
    const saved = parseHelperState(readPrivateFile(join(workspace, "session.json")));
    return saved.threadId === threadId && saved.previousWorkspace !== undefined && saved.previousWorkspace === cwd;
  };
  const endpoint = { socketPath: join(directory, `.h${randomBytes(4).toString("hex")}`), credential: randomBytes(32).toString("hex") };
  const sockets = new Set<Socket>(), settling = new Set<Promise<void>>();
  const sessions = new Map<Socket, () => Promise<void>>();
  const cleanupErrors = new Map<Socket, unknown>();
  let active = false, closed = false, readers = 0;
  const native = new CodexNativeClient(pipePath);
  const readState = readEvent ?? ((origin: NativeInvocation, signal: AbortSignal) => native.eventState(origin, signal));
  const server = createServer((socket) => {
    sockets.add(socket);
    let rpc: HelperConnection | undefined, buffer = "", authenticated = false, stopping = false;
    let helperId: string | undefined, helperTurn: string | undefined, helperWorkspace: string | undefined;
    let closing: Promise<void> | undefined, reading: Promise<void> | undefined, retirement: Promise<void> | undefined;
    const readAbort = new AbortController();
    const timer = setTimeout(() => socket.destroy(), 2_000); timer.unref();
    const write = (value: unknown) => {
      const line = JSON.stringify(value);
      if (Buffer.byteLength(line) > maxWireBytes || socket.writableLength > maxWireBytes * 4) { socket.destroy(); return; }
      socket.write(`${line}\n`);
    };
    const settle = (): Promise<void> => {
      if (closing) return closing;
      stopping = true; clearTimeout(timer); readAbort.abort();
      const owned = rpc;
      const pending = (async () => {
        await reading?.catch(() => {});
        // Archive at most once. A failed archive is never repaired by merely
        // observing child exit or by rechecking this session's close result.
        retirement ??= (async () => {
          if (owned && helperId && helperTurn) {
            if (!owned.connected) throw unavailable();
            await retire(owned, helperId, helperTurn);
          }
        })();
        let retirementError: unknown;
        try { await retirement; } catch (error) { retirementError = error; }
        await owned?.close();
        if (retirementError) throw retirementError;
        if (owned) { active = false; rpc = undefined; }
        cleanupErrors.delete(socket);
        if (!socket.destroyed && !socket.writableEnded) { write({ method: "seeker/settled", params: true }); socket.end(); }
      })();
      closing = pending; settling.add(pending);
      void pending.finally(() => settling.delete(pending)).catch((error) => {
        cleanupErrors.set(socket, error);
        if (closing === pending) closing = undefined;
        // Keep the original teardown available for an explicit same-connection
        // recheck. No normal RPC or replacement helper is admitted meanwhile.
        if (!socket.destroyed && !socket.writableEnded) write({ method: "seeker/settled", params: false });
      });
      return pending;
    };
    sessions.set(socket, settle);
    const close = () => { sockets.delete(socket); void settle().then(() => sessions.delete(socket), () => {}); };
    socket.setEncoding("utf8"); socket.on("error", () => socket.destroy()); socket.once("close", close); socket.once("end", () => { void settle().catch(() => {}); });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) { if (Buffer.byteLength(buffer) > maxWireBytes) socket.destroy(); return; }
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          if (closed || Buffer.byteLength(line) > maxWireBytes) throw unavailable();
          const message = record(JSON.parse(line));
          if (stopping) {
            if (authenticated && message.method === "seeker/close") { void settle().catch(() => {}); continue; }
            throw unavailable();
          }
          if (!authenticated) {
            onlyKeys(message, ["credential", "eventOrigin"]);
            if (message.credential !== endpoint.credential) throw unavailable();
            authenticated = true; clearTimeout(timer);
            if (message.eventOrigin !== undefined) {
              if (readers >= 4) throw unavailable();
              const origin = parseInvocation(message.eventOrigin);
              stopping = true; readers += 1;
              reading = readState(origin, AbortSignal.any([readAbort.signal, AbortSignal.timeout(2_000)]))
                .then((state) => { if (!socket.destroyed) { write({ eventState: state }); socket.end(); } })
                .finally(() => { readers -= 1; }).catch(() => { socket.destroy(); });
              continue;
            }
            if (active) throw unavailable();
            rpc = connect(owner.profile, pipePath, workspace); active = true;
            rpc.events = {
              notice: (method, params) => {
                if (method === "turn/started") {
                  try { const notice = record(params); if (notice.threadId === helperId) helperTurn = String(record(notice.turn).id); } catch { socket.destroy(); return; }
                }
                write({ method, params });
              },
              request: (id, method, params) => write({ id, method, params }),
              lost: () => { if (!stopping) void settle().catch(() => {}); },
            };
            write({ ready: true });
            continue;
          }
          if (message.method === "seeker/close") { void settle().catch(() => {}); return; }
          if (!rpc?.connected) throw unavailable();
          if (typeof message.method === "string") {
            if (typeof message.id === "string") {
              const id = message.id;
              const connection = rpc, method = message.method;
              void (async () => {
                if (method === "thread/delete") {
                  const target = record(message.params).threadId;
                  if (!helperId || target !== helperId || (helperWorkspace !== workspace && !ownsRelocatedRoot(helperId, helperWorkspace))) throw unavailable();
                }
                if (method === "turn/start" && (record(message.params).threadId !== helperId || helperWorkspace !== workspace)) throw unavailable();
                const result = await connection.request(method, message.params, AbortSignal.timeout(15_000));
                if (method === "thread/read" || method === "thread/start") {
                  const thread = record(record(result).thread);
                  if (thread.forkedFromId != null || typeof thread.id !== "string") throw unavailable();
                  if (method === "thread/read" && thread.id !== record(message.params).threadId) throw unavailable();
                  if (thread.cwd !== workspace && (method !== "thread/read" || !ownsRelocatedRoot(thread.id, thread.cwd))) throw unavailable();
                  helperId = thread.id; helperWorkspace = String(thread.cwd);
                  if (method === "thread/start") helperTurn = undefined;
                } else if (method === "turn/start") helperTurn = String(record(record(result).turn).id);
                else if (method === "thread/delete") { helperId = undefined; helperTurn = undefined; helperWorkspace = undefined; }
                return result;
              })().then(
                (result) => write({ id, result }),
                (error) => write({ id, error: { code: error?.nativeCode ?? -32603, message: error?.nativeMessage ?? "Native helper request failed." } }),
              );
            } else if (message.id === undefined) rpc.notify(message.method, message.params);
            else throw unavailable();
          } else if (typeof message.id === "string" || typeof message.id === "number") {
            if (Object.hasOwn(message, "result")) rpc.respond(message.id, message.result);
            else if (Object.hasOwn(message, "error")) rpc.reject(message.id);
            else throw unavailable();
          } else throw unavailable();
        } catch { socket.destroy(); return; }
      }
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
    // End each authenticated connection through its settlement path, not a raw
    // socket destroy that could let the service reuse a still-running helper.
    const results = await Promise.allSettled([...sessions.values()].map((settle) => settle()));
    // An explicit connector shutdown cannot keep failed observation sockets
    // open indefinitely. Failure remains reported; disconnect is not settlement.
    for (const socket of sockets) socket.destroy();
    let bound: ReturnType<typeof lstatSync> | undefined;
    try { bound = lstatSync(staging); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!bound || bound.dev !== inode.dev || bound.ino !== inode.ino) {
      server.unref();
      throw new ConnectorError("desktop_helper_cleanup_failed", "The helper's bound socket address changed; preserve its replacement.", 503);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([...settling]);
    const failure = results.find((result) => result.status === "rejected");
    try {
      const current = lstatSync(endpoint.socketPath);
      if (current.dev === inode.dev && current.ino === inode.ino) unlinkSync(endpoint.socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (failure?.status === "rejected") throw failure.reason;
    if (cleanupErrors.size) throw cleanupErrors.values().next().value;
  })() };
}

/** The service keeps the existing runtime, approval fence and native receipt parser. */
export async function connectHelperBridge(endpoint: HelperEndpoint, dataDir: string, signal?: AbortSignal): Promise<HelperConnection> {
  const parsed = parseHelperEndpoint(endpoint);
  if (dirname(parsed.socketPath) !== privateDirectory(dataDir)) throw unavailable();
  const info = lstatSync(parsed.socketPath);
  if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw unavailable();
  const socket = createConnection(parsed.socketPath);
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    const finish = (error?: Error) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      socket.removeListener("data", data); socket.removeListener("close", gone);
      if (error) { socket.destroy(); reject(error); } else resolve();
    };
    const abort = () => finish(unavailable()), gone = () => finish(unavailable());
    const timer = setTimeout(abort, 2_000); timer.unref();
    const data = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 128) return abort();
      if (!buffer.endsWith("\n")) return;
      try { const result = record(JSON.parse(buffer)); onlyKeys(result, ["ready"]); if (result.ready !== true) throw unavailable(); finish(); }
      catch { abort(); }
    };
    socket.on("error", abort); socket.once("close", gone); socket.on("data", data);
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => { if (signal?.aborted) abort(); else socket.write(`${JSON.stringify({ credential: parsed.credential })}\n`); });
    if (signal?.aborted) abort();
  });
  return new HelperRpc(socket, [], "", {});
}


/** A one-shot metadata operation on the existing authenticated connector bridge. */
export async function readEventStateBridge(endpoint: HelperEndpoint, dataDir: string, origin: NativeInvocation, signal: AbortSignal): Promise<NativeEventState> {
  const parsed = parseHelperEndpoint(endpoint);
  if (dirname(parsed.socketPath) !== privateDirectory(dataDir)) throw unavailable();
  const info = lstatSync(parsed.socketPath);
  if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw unavailable();
  const socket = createConnection(parsed.socketPath);
  return new Promise((resolve, reject) => {
    let buffer = "", settled = false;
    const finish = (value?: NativeEventState) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); socket.destroy();
      if (value) resolve(value); else reject(unavailable());
    };
    const abort = () => finish(), timer = setTimeout(abort, 2_500); timer.unref();
    socket.setEncoding("utf8"); socket.once("error", abort); socket.once("close", abort);
    socket.on("data", (chunk: string) => {
      buffer += chunk; if (Buffer.byteLength(buffer) > 2_048) return abort();
      const end = buffer.indexOf("\n"); if (end < 0) return;
      try {
        const message = record(JSON.parse(buffer.slice(0, end))); onlyKeys(message, ["eventState"]);
        const state = record(message.eventState); onlyKeys(state, ["taskId", "turnId", "status"]);
        if (state.taskId !== origin.threadId || !["inProgress", "completed", "interrupted", "failed"].includes(String(state.status))) throw unavailable();
        finish({ taskId: identifier(state.taskId), turnId: identifier(state.turnId), status: state.status as NativeEventState["status"] });
      } catch { abort(); }
    });
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => { if (signal.aborted) abort(); else socket.write(`${JSON.stringify({ credential: parsed.credential, eventOrigin: origin })}\n`); });
    if (signal.aborted) abort();
  });
}
