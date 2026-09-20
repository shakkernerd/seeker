import { dlopen, ptr } from "bun:ffi";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { DesktopProcess } from "./desktop-owner.ts";
import { ConnectorError } from "./protocol.ts";

const maximumRecordBytes = 2_097_152;
const wanted = ["HOME=", "CODEX_HOME="] as const;
const userDataArgument = "--user-data-dir=";
const invalid = () => new ConnectorError("desktop_selectors_unavailable", "The native host's original profile selectors could not be verified.", 503);

function selectorFromProcessRecord(bytes: Uint8Array, expectedExecutable: string, selector: "codeHome" | "userData" | "toolsPipe"): string | undefined {
  try {
    if (bytes.length < 8 || bytes.length > maximumRecordBytes) throw invalid();
    const argc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
    if (argc < 1 || argc > 65_535) throw invalid();
    let offset = 4;
    const next = () => {
      const start = offset;
      while (offset < bytes.length && bytes[offset] !== 0) offset += 1;
      if (offset === bytes.length) throw invalid();
      return [start, offset++] as const;
    };
    const decoder = new TextDecoder("utf-8", { fatal: true });
    if (decoder.decode(bytes.subarray(...next())) !== expectedExecutable) throw invalid();
    while (offset < bytes.length && bytes[offset] === 0) offset += 1;
    const startsWith = (start: number, end: number, prefix: string) => end - start >= prefix.length && [...prefix].every((value, index) => bytes[start + index] === value.charCodeAt(0));
    let userData: string | undefined;
    for (let index = 0; index < argc; index += 1) {
      const [start, end] = next();
      if (selector !== "userData") continue;
      if (end - start === userDataArgument.length - 1 && startsWith(start, end, userDataArgument.slice(0, -1))) throw invalid();
      if (!startsWith(start, end, userDataArgument)) continue;
      if (userData !== undefined || end - start - userDataArgument.length > 4_096) throw invalid();
      userData = decoder.decode(bytes.subarray(start + userDataArgument.length, end));
    }
    if (selector === "userData") return userData === undefined ? undefined : selectedPath(userData);
    const selected: Record<string, string> = {};
    while (offset < bytes.length && bytes[offset] !== 0) {
      const [start, end] = next();
      const prefixes: readonly string[] = selector === "toolsPipe" ? ["CODEX_APP_TOOLS_PIPE_PATH="] : wanted;
      for (const prefix of prefixes) {
        if (!startsWith(start, end, prefix)) continue;
        const key = prefix.slice(0, -1);
        if (selected[key] !== undefined || end - start - prefix.length > 4_096) throw invalid();
        selected[key] = decoder.decode(bytes.subarray(start + prefix.length, end));
      }
    }
    if (selector === "toolsPipe") {
      const value = selected.CODEX_APP_TOOLS_PIPE_PATH;
      if (!value) throw invalid();
      return selectedPath(value);
    }
    const home = selected.CODEX_HOME ?? (selected.HOME ? join(selected.HOME, ".codex") : undefined);
    if (!home) throw invalid();
    return selectedPath(home);
  } catch { throw invalid(); }
  finally { bytes.fill(0); }
}

function selectedPath(value: string): string {
  if (!isAbsolute(value) || value !== normalize(value) || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value) || value === "/") throw invalid();
  return value;
}

/** Decode only the two home selectors, then erase the complete OS record. */
export function codeHomeFromProcessRecord(bytes: Uint8Array, expectedExecutable: string): string {
  return selectorFromProcessRecord(bytes, expectedExecutable, "codeHome")!;
}

/** Read one actual argv value; spaces and switch-like path text remain data. */
export function userDataFromProcessRecord(bytes: Uint8Array, expectedExecutable: string): string | undefined {
  return selectorFromProcessRecord(bytes, expectedExecutable, "userData");
}

/** Service-only macOS inspection; the Node MCP connector never loads this module. */
function readDesktopSelector(nativeProcess: DesktopProcess, selector: "codeHome" | "userData" | "toolsPipe"): string | undefined {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) || !Number.isSafeInteger(nativeProcess.pid) || nativeProcess.pid <= 1 || nativeProcess.pid > 0x7fffffff) throw invalid();
  const library = dlopen("/usr/lib/libSystem.B.dylib", { sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" } });
  // CTL_KERN / KERN_PROCARGS2: the OS exec record for this verified native PID.
  const mib = new Int32Array([1, 49, nativeProcess.pid]), length = new BigUint64Array([0n]);
  let bytes: Uint8Array | undefined;
  try {
    if (library.symbols.sysctl(ptr(mib), 3, null, ptr(length), null, 0) !== 0 || length[0]! < 8n || length[0]! > BigInt(maximumRecordBytes)) throw invalid();
    bytes = new Uint8Array(Number(length[0]!));
    if (library.symbols.sysctl(ptr(mib), 3, ptr(bytes), ptr(length), null, 0) !== 0 || length[0]! > BigInt(bytes.length)) throw invalid();
    const value = selectorFromProcessRecord(bytes.subarray(0, Number(length[0]!)), nativeProcess.executable, selector);
    if (value === undefined) return;
    if (selector === "toolsPipe") {
      if (!statSync(value).isSocket()) throw invalid();
      return value;
    }
    const directory = realpathSync(value);
    if (!statSync(directory).isDirectory()) throw invalid();
    return directory;
  } catch { throw invalid(); }
  finally { bytes?.fill(0); library.close(); }
}

export function readDesktopCodeHome(server: DesktopProcess): string { return readDesktopSelector(server, "codeHome")!; }
export function readDesktopUserData(child: DesktopProcess): string | undefined { return readDesktopSelector(child, "userData"); }

/** Recover only the native tool socket selector from the verified current server. */
export function toolsPipeFromProcessRecord(bytes: Uint8Array, expectedExecutable: string): string {
  return selectorFromProcessRecord(bytes, expectedExecutable, "toolsPipe")!;
}
export function readDesktopToolsPipe(server: DesktopProcess): string { return readDesktopSelector(server, "toolsPipe")!; }
