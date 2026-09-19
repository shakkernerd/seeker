import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { privateDirectory } from "../codex/config.ts";
import { ConnectorError, onlyKeys, record } from "../codex/protocol.ts";

export interface CliProcess { pid: number; parentPid: number; uid: number; startedAt: string; executable: string }
export interface CliOwner {
  process: CliProcess;
  codexHome: string;
  sqliteHome: string;
  cwd: string;
  listen: string;
  socketPath: string;
  executableFile: { dev: number; ino: number; size: number; mtimeMs: number };
}
export interface RegisteredCliOwner { version: 1; owner: CliOwner; remoteControl: "disabled" | "enabled" }

const failure = (code: string, message: string) => new ConnectorError(code, message, 503);
const startPattern = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
function path(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value === "/" || value.length > 4_096 || /[\x00-\x1f\x7f]/.test(value) || value.trim() !== value) throw failure("invalid_cli_owner", "CLI ownership requires exact absolute paths.");
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw failure("invalid_cli_owner", "Invalid CLI process identity.");
  return value as number;
}
export function parseCliProcess(value: unknown): CliProcess {
  const input = record(value); onlyKeys(input, ["pid", "parentPid", "uid", "startedAt", "executable"]);
  if (typeof input.startedAt !== "string" || !startPattern.test(input.startedAt)) throw failure("invalid_cli_owner", "CLI process start identity is missing.");
  const result = { pid: integer(input.pid, 2), parentPid: integer(input.parentPid), uid: integer(input.uid), startedAt: input.startedAt, executable: path(input.executable) };
  if (result.pid === result.parentPid || basename(result.executable) !== "codex" || result.executable.includes(".app/Contents/")) throw failure("native_cli_required", "Use the original standalone Codex CLI app-server.");
  return result;
}
export function parseCliOwner(value: unknown): CliOwner {
  const input = record(value); onlyKeys(input, ["process", "codexHome", "sqliteHome", "cwd", "listen", "socketPath", "executableFile"]);
  const process = parseCliProcess(input.process), codexHome = path(input.codexHome), sqliteHome = path(input.sqliteHome), cwd = path(input.cwd), socketPath = path(input.socketPath);
  if (input.listen !== "unix://" && input.listen !== `unix://${socketPath}`) throw failure("invalid_cli_owner", "Use the exact registered Unix listener.");
  if (input.listen === "unix://" && socketPath !== join(codexHome, "app-server-control", "app-server-control.sock")) throw failure("invalid_cli_owner", "The default CLI listener does not match its registered home.");
  if (Buffer.byteLength(socketPath) > 103 || /[:?#%]/.test(socketPath)) throw failure("invalid_cli_owner", "This Unix socket address is outside the qualified native transport format.");
  const file = record(input.executableFile); onlyKeys(file, ["dev", "ino", "size", "mtimeMs"]);
  if (typeof file.mtimeMs !== "number" || !Number.isFinite(file.mtimeMs) || file.mtimeMs < 0) throw failure("invalid_cli_owner", "CLI executable identity is missing.");
  return { process, codexHome, sqliteHome, cwd, listen: input.listen as string, socketPath, executableFile: { dev: integer(file.dev), ino: integer(file.ino), size: integer(file.size, 1), mtimeMs: file.mtimeMs } };
}
export function parseRegisteredOwner(value: unknown): RegisteredCliOwner {
  const input = record(value); onlyKeys(input, ["version", "owner", "remoteControl"]);
  if (input.version !== 1 || (input.remoteControl !== "disabled" && input.remoteControl !== "enabled")) throw failure("invalid_cli_owner", "The registered CLI launch mode is missing.");
  return { version: 1, owner: parseCliOwner(input.owner), remoteControl: input.remoteControl };
}
export function sameCliProcess(a: CliProcess, b: CliProcess): boolean {
  // A background host can be reparented after its launcher exits.
  return a.pid === b.pid && a.uid === b.uid && a.startedAt === b.startedAt && a.executable === b.executable;
}
export function sameCliProfile(a: CliOwner, b: CliOwner): boolean {
  return a.codexHome === b.codexHome && a.sqliteHome === b.sqliteHome && a.cwd === b.cwd && a.listen === b.listen && a.socketPath === b.socketPath && a.process.executable === b.process.executable && JSON.stringify(a.executableFile) === JSON.stringify(b.executableFile);
}

export type CliOwnerProbe = (file: "/bin/ps" | "/usr/sbin/lsof", args: string[], signal: AbortSignal, missing?: boolean) => Promise<string>;
async function command(file: "/bin/ps" | "/usr/sbin/lsof", args: string[], signal: AbortSignal, missing = false): Promise<string> {
  if (process.platform !== "darwin") throw failure("cli_platform_unsupported", "Native CLI ownership is currently qualified on macOS.");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => execFile(file, args, { encoding: "utf8", timeout: 1_500, maxBuffer: 262_144, killSignal: "SIGKILL", signal, env: { PATH: "/usr/bin:/bin:/usr/sbin", LANG: "C", LC_ALL: "C", TZ: "UTC" } }, (error, stdout, stderr) => {
    if (stderr.trim() || (error && !(missing && error.code === 1 && !stdout.trim()))) reject(failure("cli_probe_failed", "The OS could not verify the registered CLI owner."));
    else resolve(stdout);
  }));
}

export async function readCliProcess(pid: number, signal: AbortSignal, probe: CliOwnerProbe = command): Promise<CliProcess | undefined> {
  const value = await probe("/bin/ps", ["-ww", "-p", String(integer(pid, 2)), "-o", "pid=,ppid=,uid=,lstart=,comm="], signal, true);
  if (!value.trim()) return;
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+((?:\S+\s+){4}\d{4})\s+(.+?)\s*$/.exec(value);
  if (!match) throw failure("cli_probe_failed", "The OS process identity was not recognized.");
  return parseCliProcess({ pid: Number(match[1]), parentPid: Number(match[2]), uid: Number(match[3]), startedAt: match[4]!.replace(/\s+/g, " "), executable: match[5] });
}

/** Parse only the actual native Unix launch forms whose recovery behavior was qualified. */
export function cliListenFromCommand(command: string, executable: string, codexHome: string): { listen: string; socketPath: string } {
  const prefix = `${executable} app-server --listen `;
  if (!command.startsWith(prefix)) throw failure("cli_launch_unsupported", "This CLI launch has custom options that Seeker cannot safely reproduce.");
  const listen = command.slice(prefix.length).trimEnd().replace(/ --remote-control$/, "");
  if (!listen.startsWith("unix://")) throw failure("cli_launch_unsupported", "Connect this manager to its original local Unix app-server.");
  const socketPath = listen === "unix://" ? join(path(codexHome), "app-server-control", "app-server-control.sock") : path(listen.slice(7));
  return { listen, socketPath };
}
function executableFile(executable: string): CliOwner["executableFile"] {
  const file = statSync(executable);
  if (!file.isFile() || !(file.mode & 0o111) || realpathSync(executable) !== executable) throw failure("cli_binary_changed", "The registered native executable is unavailable or changed.");
  return { dev: file.dev, ino: file.ino, size: file.size, mtimeMs: file.mtimeMs };
}
export function verifyCliFiles(owner: CliOwner): void {
  for (const directory of [owner.codexHome, owner.sqliteHome, owner.cwd]) if (realpathSync(directory) !== directory || !statSync(directory).isDirectory()) throw failure("cli_profile_changed", "A registered CLI directory changed.");
  if (JSON.stringify(executableFile(owner.process.executable)) !== JSON.stringify(owner.executableFile)) throw failure("cli_binary_changed", "CLI changed versions; qualify its original manager again before recovery.");
}
export function verifyNativeSocket(socketPath: string): void {
  path(socketPath); privateDirectory(dirname(socketPath));
  const file = lstatSync(socketPath);
  if (!file.isSocket() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) throw failure("unsafe_native_socket", "The native Unix socket must be private and owned by your user.");
}
async function inspect(pid: number, codexHome: string, sqliteHome: string, signal: AbortSignal, readCodeHome?: (server: CliProcess) => string, probe: CliOwnerProbe = command): Promise<CliOwner> {
  const before = await readCliProcess(pid, signal, probe);
  if (!before || before.uid !== process.getuid?.()) throw failure("native_cli_required", "The original CLI process is unavailable.");
  if (readCodeHome && readCodeHome(before) !== codexHome) throw failure("cli_profile_changed", "The running CLI uses a different native Codex home.");
  const [argv, cwdOutput, files] = await Promise.all([
    probe("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], signal),
    probe("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], signal),
    probe("/usr/sbin/lsof", ["-a", "-p", String(pid), "-Fn"], signal),
  ]);
  const cwdNames = cwdOutput.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  if (cwdNames.length !== 1) throw failure("cli_profile_ambiguous", "The native CLI working directory is ambiguous.");
  const endpoints = cliListenFromCommand(argv.trim(), before.executable, codexHome), names = files.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  if (!names.includes(endpoints.socketPath)) throw failure("cli_endpoint_unproven", "The original CLI process does not own this Unix endpoint.");
  const databases = names.filter((name) => /\/state_\d+\.sqlite$/.test(name));
  if (!databases.length || databases.some((name) => dirname(name) !== sqliteHome)) throw failure("cli_profile_ambiguous", "The CLI state directory does not match its native MCP environment.");
  const owner = parseCliOwner({ process: before, codexHome, sqliteHome, cwd: realpathSync(cwdNames[0]!), ...endpoints, executableFile: executableFile(before.executable) });
  verifyCliFiles(owner); verifyNativeSocket(owner.socketPath);
  const after = await readCliProcess(pid, signal, probe);
  if (!after || !sameCliProcess(before, after)) throw failure("cli_owner_changed", "CLI ownership changed during inspection. Retry once startup settles.");
  return owner;
}

/** Genuine MCP ancestry, never Desktop environment-variable presence, chooses the CLI owner. */
export async function captureCliOwner(signal = AbortSignal.timeout(4_000)): Promise<CliOwner> {
  const codexHome = realpathSync(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const sqliteHome = realpathSync(process.env.CODEX_SQLITE_HOME ?? codexHome);
  return inspect(process.ppid, codexHome, sqliteHome, signal);
}
export async function verifyCliOwner(owner: CliOwner, signal: AbortSignal): Promise<void> {
  const current = await inspect(owner.process.pid, owner.codexHome, owner.sqliteHome, signal);
  if (!sameCliProcess(current.process, owner.process) || !sameCliProfile(current, owner)) throw failure("cli_owner_changed", "The live CLI owner differs from its registration.");
}
export async function originalCliGone(owner: CliOwner, signal: AbortSignal): Promise<boolean> {
  // A reused PID is not the recorded process. An unrecognized live process is
  // left alone rather than treated as evidence that starting another is safe.
  const current = await readCliProcess(owner.process.pid, signal);
  return !current || !sameCliProcess(current, owner.process);
}

/** Recovery discovery is separate from genuine MCP ancestry and requires actual native home evidence. */
export async function findRunningCli(previous: CliOwner, signal: AbortSignal, readCodeHome: (server: CliProcess) => string, probe: CliOwnerProbe = command): Promise<CliOwner | undefined> {
  verifyCliFiles(previous);
  if (previous.process.uid !== process.getuid?.()) throw failure("native_cli_required", "The registered CLI belongs to a different OS user.");
  try { verifyNativeSocket(previous.socketPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const socketOwners = async () => {
    // Enumerate open Unix sockets, including an unlinked listener. A missing
    // filesystem entry alone cannot prove that another execution owner is absent.
    const output = await probe("/usr/sbin/lsof", ["-n", "-a", "-U", "-u", String(previous.process.uid), "-Fpn0"], signal, true);
    const owners = new Set<number>(); let pid: number | undefined, descriptor = false;
    for (const raw of output.split("\0")) {
      const field = raw.replace(/^\n+/, "");
      if (!field) continue;
      if (/^p\d+$/.test(field)) { pid = integer(Number(field.slice(1)), 1); descriptor = false; }
      else if (/^f\d+$/.test(field) && pid !== undefined) descriptor = true;
      else if (field.startsWith("n") && pid !== undefined && descriptor) {
        if (field.slice(1) === previous.socketPath) owners.add(pid);
      } else throw failure("cli_probe_failed", "The OS Unix socket ownership snapshot was not recognized.");
    }
    if (owners.size > 1) throw failure("cli_owner_ambiguous", "More than one process holds the registered CLI endpoint.");
    return [...owners][0];
  };
  const pid = await socketOwners();
  if (pid === undefined) return;
  const current = await inspect(pid, previous.codexHome, previous.sqliteHome, signal, readCodeHome, probe);
  if (!sameCliProfile(current, previous)) throw failure("cli_owner_changed", "The running CLI does not match its registered profile.");
  if (await socketOwners() !== pid) throw failure("cli_owner_changed", "CLI endpoint ownership changed during inspection.");
  signal.throwIfAborted();
  return current;
}

/** Native startup locks/probes its same-home Unix endpoint and refuses a live listener. */
export function startRegisteredCli(registration: RegisteredCliOwner): ChildProcess {
  const { owner, remoteControl } = registration; verifyCliFiles(owner);
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: owner.codexHome, CODEX_SQLITE_HOME: owner.sqliteHome };
  // This native startup selector is consumed before MCP launch; capture the
  // effective mode from remoteControl/status/read instead of guessing from argv.
  env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = remoteControl === "disabled" ? "1" : undefined;
  const child = spawn(owner.process.executable, ["app-server", "--listen", owner.listen, ...(remoteControl === "enabled" ? ["--remote-control"] : [])], { cwd: owner.cwd, env, detached: true, stdio: "ignore" });
  child.unref(); return child;
}
export async function captureRestartedCli(pid: number, previous: CliOwner, signal: AbortSignal): Promise<CliOwner> {
  const current = await inspect(pid, previous.codexHome, previous.sqliteHome, signal);
  if (!sameCliProfile(current, previous)) throw failure("cli_owner_changed", "The restarted CLI does not match its registered profile.");
  return current;
}
