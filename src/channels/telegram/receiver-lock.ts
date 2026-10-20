import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const conflict = () => new Error("Cannot claim Telegram receiver. Another receiver or unresolved lock exists; see Telegram setup recovery.");
const present = (path: string): Stats | undefined => {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
};
const same = (left: Stats, right: Stats | undefined) => right?.dev === left.dev && right.ino === left.ino;
const privateFile = (stat: Stats) => stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;

/** Kernel-held ownership plus the PID marker understood by older receivers. */
export async function claimReceiver(botId: string, directory = join(homedir(), ".seeker", "telegram-receivers")): Promise<() => Promise<void>> {
  if (!/^[1-9]\d{0,15}$/.test(botId)) throw new Error("Invalid Telegram bot identity");
  const path = join(directory, `${botId}.lock`), guardPath = join(directory, `${botId}.guard`);
  let guard: Database | undefined, owned: Stats | undefined;
  const remove = () => { if (owned && same(owned, present(path))) unlinkSync(path); };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0) throw conflict();

    // Never unlink this inode: SQLite's existing native locking serializes new
    // receivers and releases on crash. No tables or committed data are needed.
    // Do not open/close an extra fd on an existing guard: POSIX record locks are
    // process-wide, so that could release another connection's lock.
    if (!present(guardPath)) {
      try { closeSync(openSync(guardPath, "wx", 0o600)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const guardFile = lstatSync(guardPath);
    if (!privateFile(guardFile)) throw conflict();
    guard = new Database(guardPath, { strict: true });
    guard.exec("BEGIN EXCLUSIVE");
    if (!same(guardFile, present(guardPath))) throw conflict();

    const previous = present(path);
    if (previous) {
      if (!privateFile(previous) || previous.size > 128) throw conflict();
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let pid: unknown;
      try {
        if (!same(previous, fstatSync(fd))) throw conflict();
        pid = (JSON.parse(readFileSync(fd, "utf8")) as { pid?: unknown }).pid;
      } finally { closeSync(fd); }
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) throw conflict();
      try { process.kill(pid, 0); throw conflict(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      // New contenders hold the guard; legacy contenders cannot create their
      // marker until this known-dead owner's marker is removed.
      if (!same(previous, present(path))) throw conflict();
      unlinkSync(path);
    }

    // Publish a complete marker atomically. A crash before publication cannot
    // leave an empty marker that has no safely identifiable legacy owner.
    const staging = join(directory, `${botId}.pending`);
    const pending = present(staging);
    if (pending) {
      if (!privateFile(pending)) throw conflict();
      unlinkSync(staging); // Only new receivers use this path, under the guard.
    }
    const fd = openSync(staging, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      const marker = fstatSync(fd);
      linkSync(staging, path); // Also excludes legacy receivers using open("wx").
      owned = marker;
    } finally { closeSync(fd); unlinkSync(staging); }
  } catch {
    try { remove(); } finally { guard?.close(); }
    throw conflict();
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try { remove(); } finally { guard.close(); }
  };
}
