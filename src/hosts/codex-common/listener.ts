import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, lstatSync, unlinkSync, type Stats } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { privateDirectory } from "../codex/config.ts";
import { ConnectorError } from "../codex/protocol.ts";

const present = (path: string): Stats | undefined => { try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };

/** One private socket inode, with cleanup that cannot unlink a replacement listener. */
export async function listenPrivate(path: string, handle: (request: Request) => Promise<Response>) {
  const directory = privateDirectory(dirname(path)), previous = present(path);
  if (Buffer.byteLength(path) > 103) throw new ConnectorError("socket_path_too_long", "Choose a shorter Seeker data directory.");
  if (previous) {
    if (!previous.isSocket() || previous.uid !== process.getuid?.()) throw new ConnectorError("socket_conflict", "The private socket path contains unrelated data.");
    const stale = await new Promise<boolean>((resolve, reject) => {
      const socket = createConnection(path), timer = setTimeout(() => { socket.destroy(); reject(new ConnectorError("socket_busy", "The existing native socket could not be reconciled.")); }, 500);
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
      socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); socket.destroy(); if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(true); else reject(error); });
    });
    if (!stale) throw new ConnectorError("socket_busy", "Another Seeker host listener already owns this directory.");
    const current = present(path);
    if (current && (current.dev !== previous.dev || current.ino !== previous.ino)) throw new ConnectorError("socket_conflict", "The private socket changed during recovery.");
    if (current) unlinkSync(path);
  }
  const staging = join(directory, `.s${randomBytes(6).toString("base64url")}`);
  if (present(staging)) throw new ConnectorError("socket_conflict", "The temporary socket address is already in use.");
  const server = Bun.serve({ unix: staging, maxRequestBodySize: 65_536, fetch(request, native) { native.timeout(request, 30); return handle(request); } });
  let owned: Stats | undefined, closing: Promise<void> | undefined;
  const remove = () => { const current = present(path); if (owned && current?.dev === owned.dev && current.ino === owned.ino) unlinkSync(path); };
  try { chmodSync(staging, 0o600); owned = lstatSync(staging); linkSync(staging, path); unlinkSync(staging); }
  catch (error) { await server.stop(true); remove(); throw error; }
  return { close: () => closing ??= (async () => { await server.stop(true); remove(); })() };
}
