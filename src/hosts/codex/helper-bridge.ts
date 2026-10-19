import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { privateDirectory } from "./config.ts";
import type { DesktopOwner } from "./desktop-owner.ts";
import { connectDesktopHelper } from "./helper-runtime.ts";
import { HelperRpc, type HelperConnection } from "./helper-rpc.ts";
import { ConnectorError, maxWireBytes, onlyKeys, record } from "./protocol.ts";

export interface HelperEndpoint { socketPath: string; credential: string }
const unavailable = () => new ConnectorError("desktop_helper_unavailable", "The qualified Desktop connector's helper is unavailable.", 503);

export function parseHelperEndpoint(value: unknown): HelperEndpoint {
  const item = record(value); onlyKeys(item, ["socketPath", "credential"]);
  if (typeof item.socketPath !== "string" || !/^\.h[a-f0-9]{16}\.sock$/.test(item.socketPath.slice(item.socketPath.lastIndexOf("/") + 1)) || typeof item.credential !== "string" || !/^[a-f0-9]{64}$/.test(item.credential)) throw unavailable();
  return { socketPath: item.socketPath, credential: item.credential };
}

/** Only the already qualified Desktop child creates native helper processes. */
export async function listenHelperBridge(dataDir: string, owner: DesktopOwner, pipePath: string, connect = connectDesktopHelper) {
  const directory = privateDirectory(dataDir), workspace = join(directory, "codex-helper");
  mkdirSync(workspace, { recursive: true, mode: 0o700 }); privateDirectory(workspace);
  const endpoint = { socketPath: join(directory, `.h${randomBytes(8).toString("hex")}.sock`), credential: randomBytes(32).toString("hex") };
  const sockets = new Set<Socket>(), settling = new Set<Promise<void>>();
  let active = false, closed = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    let rpc: HelperConnection | undefined, buffer = "", authenticated = false;
    const timer = setTimeout(() => socket.destroy(), 2_000); timer.unref();
    const write = (value: unknown) => {
      const line = JSON.stringify(value);
      if (Buffer.byteLength(line) > maxWireBytes || socket.writableLength > maxWireBytes * 4) { socket.destroy(); return; }
      socket.write(`${line}\n`);
    };
    const close = () => {
      clearTimeout(timer); sockets.delete(socket);
      if (!rpc) return;
      const owned = rpc; rpc = undefined;
      const pending = owned.close().finally(() => { active = false; settling.delete(pending); });
      settling.add(pending); void pending.catch(() => {});
    };
    socket.setEncoding("utf8"); socket.on("error", () => socket.destroy()); socket.once("close", close);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) { if (Buffer.byteLength(buffer) > maxWireBytes) socket.destroy(); return; }
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          if (closed || Buffer.byteLength(line) > maxWireBytes) throw unavailable();
          const message = record(JSON.parse(line));
          if (!authenticated) {
            onlyKeys(message, ["credential"]);
            if (message.credential !== endpoint.credential || active) throw unavailable();
            authenticated = true; clearTimeout(timer);
            rpc = connect(owner.profile, pipePath, workspace); active = true;
            rpc.events = {
              notice: (method, params) => write({ method, params }),
              request: (id, method, params) => write({ id, method, params }),
              lost: () => socket.destroy(),
            };
            write({ ready: true });
            continue;
          }
          if (!rpc?.connected) throw unavailable();
          if (typeof message.method === "string") {
            if (typeof message.id === "string") {
              const id = message.id;
              void rpc.request(message.method, message.params, AbortSignal.timeout(15_000)).then(
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
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint.socketPath, resolve); });
  chmodSync(endpoint.socketPath, 0o600);
  const inode = lstatSync(endpoint.socketPath);
  let closing: Promise<void> | undefined;
  return { endpoint, close: () => closing ??= (async () => {
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([...settling]);
    try {
      const current = lstatSync(endpoint.socketPath);
      if (current.dev === inode.dev && current.ino === inode.ino) unlinkSync(endpoint.socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
