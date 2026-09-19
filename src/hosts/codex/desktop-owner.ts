import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { ConnectorError } from "./protocol.ts";

export interface DesktopProcess {
  pid: number;
  parentPid: number;
  startedAt: string;
  executable: string;
}

export interface DesktopProfile {
  appPath: string;
  appVersion: string;
  appBuild: string;
  userDataPath: string;
  codexHome: string;
  sqliteHome?: string;
}

export interface DesktopOwner {
  profile: DesktopProfile;
  app: DesktopProcess;
  server: DesktopProcess;
}

interface Bundle { appPath: string; appVersion: string; appBuild: string; executable: string }
interface Inspection { app: DesktopProcess; server?: DesktopProcess; userDataPath?: string; codexHome?: string; sqliteHome?: string }
const nodeSuffix = "/Contents/Resources/cua_node/bin/node";
const startPattern = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

function failure(code: string, message: string): ConnectorError { return new ConnectorError(code, message, 503); }
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw failure("desktop_probe_aborted", "Desktop ownership inspection was cancelled.");
}
function requireMac(): void {
  if (process.platform !== "darwin") throw failure("desktop_platform_unsupported", "Native Desktop recovery is qualified only on macOS.");
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw failure("invalid_desktop_owner", "Invalid Desktop ownership metadata.");
  return value as Record<string, unknown>;
}
function absolutePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || !posix.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value !== value.trim() || value === "/") throw failure("invalid_desktop_path", "Desktop ownership requires an absolute, normalized path.");
  return value;
}
function path(value: unknown): string {
  const result = absolutePath(value);
  if (posix.normalize(result) !== result) throw failure("invalid_desktop_path", "Desktop ownership requires an absolute, normalized path.");
  return result;
}
function version(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9][a-zA-Z0-9.+_-]{0,63}$/.test(value)) throw failure("invalid_desktop_owner", "Desktop build identity is missing or invalid.");
  return value;
}
function parseProfile(value: unknown): DesktopProfile {
  const item = object(value, ["appPath", "appVersion", "appBuild", "userDataPath", "codexHome", "sqliteHome"]);
  const appPath = path(item.appPath);
  if (!appPath.endsWith(".app")) throw failure("invalid_desktop_owner", "Desktop must identify its exact application bundle.");
  return { appPath, appVersion: version(item.appVersion), appBuild: version(item.appBuild), userDataPath: path(item.userDataPath), codexHome: path(item.codexHome), ...(item.sqliteHome === undefined ? {} : { sqliteHome: path(item.sqliteHome) }) };
}
function parseProcess(value: unknown, fromOs = false): DesktopProcess {
  const item = object(value, ["pid", "parentPid", "startedAt", "executable"]);
  if (!Number.isSafeInteger(item.pid) || (item.pid as number) <= 1 || (item.pid as number) > 0x7fffffff || !Number.isSafeInteger(item.parentPid) || (item.parentPid as number) < 0 || (item.parentPid as number) > 0x7fffffff || item.pid === item.parentPid || typeof item.startedAt !== "string" || !startPattern.test(item.startedAt) || !Number.isFinite(Date.parse(item.startedAt))) throw failure("invalid_desktop_owner", "Desktop process identity is missing or invalid.");
  return { pid: item.pid as number, parentPid: item.parentPid as number, startedAt: item.startedAt, executable: fromOs ? absolutePath(item.executable) : path(item.executable) };
}

/** Validates private IPC metadata; it does not attest that these processes are still alive. */
export function parseDesktopOwner(value: unknown): DesktopOwner {
  const item = object(value, ["profile", "app", "server"]);
  const profile = parseProfile(item.profile), app = parseProcess(item.app), server = parseProcess(item.server);
  if (dirname(app.executable) !== join(profile.appPath, "Contents", "MacOS") || server.executable !== serverPath(profile.appPath) || server.parentPid !== app.pid || app.parentPid === server.pid || app.pid === server.pid) throw failure("invalid_desktop_owner", "Desktop process ancestry does not match its registered bundle.");
  return { profile, app, server };
}

export function sameDesktopProcess(a: DesktopProcess, b: DesktopProcess): boolean {
  return a.pid === b.pid && a.parentPid === b.parentPid && a.startedAt === b.startedAt && a.executable === b.executable;
}

/** Pure OS-output parsers are shared with focused ownership tests. No command arguments are retained. */
export function parseDesktopProcesses(output: string, effectiveUid: number): DesktopProcess[] {
  if (!Number.isSafeInteger(effectiveUid) || effectiveUid < 0 || effectiveUid > 0xffffffff) throw failure("desktop_user_unavailable", "The effective OS user could not be identified.");
  const processes: DesktopProcess[] = [], ids = new Set<number>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const user = /^\s*(\d+)(?:\s+|$)/.exec(line);
    if (!user) throw failure("desktop_process_unreadable", "The OS process snapshot has no numeric user identity.");
    // Filter before reading any other fields: foreign rows cannot contribute
    // candidates, duplicate PIDs, or malformed profile metadata.
    if (Number(user[1]) !== effectiveUid) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+((?:\S+\s+){4}\d{4})\s+(.+)$/.exec(line.slice(user[0].length));
    if (!match) throw failure("desktop_process_unreadable", "The OS process snapshot was not recognized.");
    const pid = Number(match[1]), parentPid = Number(match[2]), executable = match[4]!;
    if (ids.has(pid)) throw failure("desktop_process_unreadable", "The OS process snapshot contains duplicate identities.");
    ids.add(pid);
    // Kernel and terminated processes can have names rather than executable paths.
    if (pid <= 1 || !executable.startsWith("/")) continue;
    // Other applications can preserve non-normalized launch paths. Keep that
    // spelling; only exact bundled executables are eligible for adoption below.
    processes.push(parseProcess({ pid, parentPid, startedAt: match[3]!.replace(/\s+/g, " "), executable }, true));
  }
  return processes;
}

export function desktopAppFromRuntime(executable: string): string {
  const runtime = path(executable);
  if (!runtime.endsWith(nodeSuffix)) throw failure("native_host_required", "Capture Desktop ownership from its host-launched bundled runtime.");
  const appPath = runtime.slice(0, -nodeSuffix.length);
  if (!appPath.endsWith(".app")) throw failure("native_host_required", "The connector runtime is not inside a Desktop application bundle.");
  return path(appPath);
}

export function desktopUserDataFromArguments(command: string): string | undefined {
  if (/[\x00-\x1f\x7f]/.test(command)) throw failure("desktop_profile_unreadable", "The framework process selector is malformed.");
  const selectors = [...command.matchAll(/(?:^|\s)--user-data-dir(?==|\s|$)/g)];
  if (selectors.length === 0) return undefined;
  if (selectors.length !== 1) throw failure("desktop_profile_ambiguous", "The framework process has conflicting profile selectors.");
  const match = selectors[0]!, start = match.index! + match[0].length;
  if (command[start] !== "=") throw failure("desktop_profile_unreadable", "The framework profile selector uses an unsupported form.");
  // ps preserves spaces within an argument, but not argv boundaries. Only the
  // native --name=value form with subsequent named switches is qualified here.
  const tail = command.slice(start + 1), end = tail.search(/\s--[a-zA-Z][a-zA-Z0-9-]*(?:=|\s|$)/);
  const selected = (end < 0 ? tail : tail.slice(0, end)).trimEnd();
  return path(selected);
}

export function desktopSqliteFromFiles(output: string): string | undefined {
  const queue = new Set<string>(), state = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^n(.+)\/(queue|state)_\d+\.sqlite$/.exec(line);
    if (match) (match[2] === "queue" ? queue : state).add(path(match[1]));
  }
  if (queue.size > 1 || state.size > 1 || (queue.size && state.size && [...queue][0] !== [...state][0])) throw failure("desktop_storage_ambiguous", "Desktop has conflicting active SQLite directories.");
  return queue.size === 1 && state.size === 1 ? [...queue][0] : undefined;
}

async function command(file: "/bin/ps" | "/usr/bin/plutil" | "/usr/sbin/lsof", args: string[], signal?: AbortSignal): Promise<string> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: 2_000, maxBuffer: 2_097_152, killSignal: "SIGKILL", signal, env: { PATH: "/usr/bin:/bin:/usr/sbin", LANG: "C", LC_ALL: "C", TZ: "UTC" } }, (error, stdout) => {
      if (error) reject(failure(signal?.aborted ? "desktop_probe_aborted" : "desktop_probe_failed", "Desktop ownership metadata could not be read safely."));
      else resolve(stdout);
    });
  });
}
async function directory(value: string, signal?: AbortSignal): Promise<string> {
  checkSignal(signal);
  try {
    const canonical = path(await realpath(path(value)));
    if (!(await stat(canonical)).isDirectory()) throw new Error();
    checkSignal(signal);
    return canonical;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw failure("desktop_path_unavailable", "A registered Desktop directory is unavailable.");
  }
}
async function bundle(appPath: string, signal?: AbortSignal): Promise<Bundle> {
  const canonical = await directory(appPath, signal);
  if (canonical !== appPath || !canonical.endsWith(".app")) throw failure("desktop_bundle_changed", "The registered Desktop bundle path has changed.");
  let info: Record<string, unknown>;
  try { info = JSON.parse(await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(canonical, "Contents", "Info.plist")], signal)); }
  catch (error) { if (error instanceof ConnectorError) throw error; throw failure("desktop_bundle_invalid", "The Desktop bundle metadata is invalid."); }
  if (!info || info.CFBundleIdentifier !== "com.openai.codex" || typeof info.CFBundleExecutable !== "string" || !/^[a-zA-Z0-9 ._-]{1,80}$/.test(info.CFBundleExecutable) || info.CFBundleExecutable === "." || info.CFBundleExecutable === "..") throw failure("desktop_bundle_invalid", "The application is not the registered native Desktop host.");
  const result = { appPath: canonical, appVersion: version(info.CFBundleShortVersionString), appBuild: version(info.CFBundleVersion), executable: join(canonical, "Contents", "MacOS", info.CFBundleExecutable) };
  return result;
}
const serverPath = (appPath: string) => join(appPath, "Contents", "Resources", "codex");
async function processes(signal?: AbortSignal): Promise<DesktopProcess[]> {
  const uid = process.geteuid?.();
  if (uid === undefined) throw failure("desktop_user_unavailable", "The effective OS user could not be identified.");
  // macOS user selection can include setuid processes. The numeric uid column
  // independently verifies effective ownership, without widening selection via -a.
  return parseDesktopProcesses(await command("/bin/ps", ["-u", String(uid), "-xww", "-o", "uid=,pid=,ppid=,lstart=,comm="], signal), uid);
}
function frameworkChildren(snapshot: DesktopProcess[], app: DesktopProcess, appPath: string): DesktopProcess[] {
  const prefix = `${appPath}/Contents/Frameworks/Codex Framework.framework/Versions/`;
  return snapshot.filter((entry) => entry.parentPid === app.pid && entry.executable.startsWith(prefix) && /^[^/]+\/Helpers\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(entry.executable.slice(prefix.length)));
}
function directServer(snapshot: DesktopProcess[], app: DesktopProcess, appPath: string): DesktopProcess | undefined {
  const matches = snapshot.filter((entry) => entry.parentPid === app.pid && entry.executable === serverPath(appPath));
  if (matches.length > 1) throw failure("desktop_owner_ambiguous", "The Desktop application has multiple native app-server owners.");
  return matches[0];
}
function unchanged(before: DesktopProcess[], after: DesktopProcess[]): void {
  const current = new Map(after.map((entry) => [entry.pid, entry]));
  if (before.length !== after.length || before.some((entry) => !current.has(entry.pid) || !sameDesktopProcess(entry, current.get(entry.pid)!))) throw failure("desktop_owner_changed", "Desktop processes changed during ownership inspection. Retry after startup settles.");
}
async function userData(children: DesktopProcess[], signal?: AbortSignal): Promise<string | undefined> {
  if (!children.length) return undefined;
  if (children.length > 128) throw failure("desktop_owner_ambiguous", "Desktop has too many framework processes to qualify safely.");
  const output = await command("/bin/ps", ["-ww", "-p", children.map(({ pid }) => pid).join(","), "-o", "pid=,command="], signal);
  const seen = new Set<number>(), selectors = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(.*)$/.exec(line), pid = Number(match?.[1]);
    if (!match || seen.has(pid) || !children.some((entry) => entry.pid === pid)) throw failure("desktop_profile_unreadable", "The framework process snapshot was not recognized.");
    seen.add(pid);
    const selected = desktopUserDataFromArguments(match[2]!);
    if (selected) selectors.add(await directory(selected, signal));
  }
  if (seen.size !== children.length) throw failure("desktop_owner_changed", "Desktop framework processes changed during inspection.");
  if (selectors.size > 1) throw failure("desktop_profile_ambiguous", "The Desktop application has conflicting active profile directories.");
  return [...selectors][0];
}

async function readSqliteHome(server: DesktopProcess, signal?: AbortSignal): Promise<string | undefined> {
  const selected = desktopSqliteFromFiles(await command("/usr/sbin/lsof", ["-a", "-p", String(server.pid), "-Fn"], signal));
  return selected ? await directory(selected, signal) : undefined;
}

/** Called only by a genuine MCP connector; native pipe qualification is a separate prerequisite. */
export async function captureDesktopOwner(signal?: AbortSignal): Promise<DesktopOwner> {
  requireMac(); checkSignal(signal);
  let runtime: string;
  try { runtime = await realpath(process.execPath); }
  catch { throw failure("native_host_required", "The connector's executing runtime cannot be identified."); }
  const appPath = desktopAppFromRuntime(runtime), metadata = await bundle(appPath, signal);
  const before = await processes(signal), server = before.find((entry) => entry.pid === process.ppid);
  const app = server && before.find((entry) => entry.pid === server.parentPid);
  if (!server || !app || server.executable !== serverPath(appPath) || app.executable !== metadata.executable || directServer(before, app, appPath)?.pid !== server.pid) throw failure("native_host_required", "The connector was not launched directly by this Desktop app-server.");
  const children = frameworkChildren(before, app, appPath), userDataPath = await userData(children, signal);
  if (!userDataPath) throw failure("desktop_profile_unavailable", "Desktop has not exposed its active profile directory yet.");
  // MCP forwards CODEX_HOME explicitly; HOME is its ordinary host-provided
  // default. Neither value is read from tool arguments or another process.
  const codexHome = await directory(process.env.CODEX_HOME ?? join(path(process.env.HOME), ".codex"), signal);
  const sqliteHome = await readSqliteHome(server, signal);
  const after = await processes(signal);
  const afterApp = after.find((entry) => entry.pid === app.pid), afterServer = after.find((entry) => entry.pid === server.pid);
  if (!afterApp || !afterServer) throw failure("desktop_owner_changed", "Desktop exited during ownership inspection.");
  unchanged([app, server, ...children], [afterApp, afterServer, ...frameworkChildren(after, afterApp, appPath)]);
  if (process.ppid !== server.pid || directServer(after, app, appPath)?.pid !== server.pid) throw failure("desktop_owner_changed", "The native connector's Desktop owner changed during inspection.");
  return parseDesktopOwner({ profile: { appPath, appVersion: metadata.appVersion, appBuild: metadata.appBuild, userDataPath, codexHome, ...(sqliteHome ? { sqliteHome } : {}) }, app, server });
}

/** Code-home discovery stays inside the stable-process inspection; absent an accessor, no home is asserted. */
export async function inspectDesktop(profile: DesktopProfile, signal?: AbortSignal, codeHome?: (server: DesktopProcess) => string): Promise<Inspection[]> {
  requireMac(); checkSignal(signal);
  const registered = parseProfile(profile), metadata = await bundle(registered.appPath, signal);
  await Promise.all([registered.userDataPath, registered.codexHome, ...(registered.sqliteHome ? [registered.sqliteHome] : [])].map(async (entry) => {
    if (await directory(entry, signal) !== entry) throw failure("desktop_path_changed", "A registered Desktop directory now resolves to a different location.");
  }));
  const before = await processes(signal), apps = before.filter((entry) => entry.executable === metadata.executable);
  const result: Inspection[] = [];
  for (const app of apps) {
    const server = directServer(before, app, registered.appPath), userDataPath = await userData(frameworkChildren(before, app, registered.appPath), signal);
    let codexHome: string | undefined;
    if (server && codeHome) {
      checkSignal(signal);
      let selected: string;
      try { selected = codeHome(server); }
      catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw failure("desktop_profile_unreadable", "The native server's Codex home could not be identified.");
      }
      codexHome = await directory(selected, signal);
    }
    const sqliteHome = server ? await readSqliteHome(server, signal) : undefined;
    result.push({ app, ...(server ? { server } : {}), ...(userDataPath ? { userDataPath } : {}), ...(codexHome ? { codexHome } : {}), ...(sqliteHome ? { sqliteHome } : {}) });
  }
  const after = await processes(signal);
  unchanged(apps, after.filter((entry) => entry.executable === metadata.executable));
  for (const { app, server } of result) {
    const nextServer = directServer(after, app, registered.appPath);
    unchanged(server ? [server] : [], nextServer ? [nextServer] : []);
    unchanged(frameworkChildren(before, app, registered.appPath), frameworkChildren(after, app, registered.appPath));
  }
  return result;
}
