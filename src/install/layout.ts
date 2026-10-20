import { constants, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fail } from "../core/validation.ts";
import { ensureDataDir } from "../local/config.ts";

export const serviceLabel = "com.seeker.service";
export const installHome = () => join(homedir(), ".seeker");
export function layout(home = installHome()) {
  home = resolve(home);
  // Canonicalize parent aliases (for example macOS /tmp) without accepting a linked home.
  if (present(home)?.isSymbolicLink()) fail("install_path", "The Seeker home must not be a symbolic link.");
  home = join(realpathSync(dirname(home)), basename(home));
  return { home, app: join(home, "app"), runtime: join(home, "runtime", "bun"), bin: join(home, "bin"), logs: join(home, "logs"), identity: join(home, "app", "installation.json"), plist: join(homedir(), "Library", "LaunchAgents", `${serviceLabel}.plist`) };
}
export function present(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export function regular(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) fail("install_path", "Installation files must be regular files owned by your user.");
}
export function atomicWrite(path: string, contents: string, mode = 0o600): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, contents, { mode, flag: "wx" }); renameSync(temporary, path); }
  finally { if (present(temporary)) unlinkSync(temporary); }
}
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const digest = (path: string) => { regular(path); return createHash("sha256").update(readFileSync(path)).digest("hex"); };
export function fileInventory(directory: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name, path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, fileInventory(path, `${name}/`));
    else if (entry.isFile()) result[name] = digest(path);
    else fail("install_path", "The application contains a link or special file; use the built package.");
  }
  return result;
}
/** Exclusive operator mutation; a crashed operation remains explicit, never auto-replayed. */
export function claimInstallation(home: string): () => void {
  ensureDataDir(home);
  const path = join(home, ".installation-lock");
  let fd: number;
  try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch { return fail("install_busy", "Another installation or interrupted operation owns .installation-lock. Reconcile it before continuing."); }
  writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  const owned = lstatSync(path);
  return () => { closeSync(fd); const now = present(path); if (now?.ino === owned.ino && now.dev === owned.dev) unlinkSync(path); };
}
export function privateSubdirectory(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); ensureDataDir(path); }
