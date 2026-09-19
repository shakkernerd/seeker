import { dlopen, ptr } from "bun:ffi";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { DesktopProcess } from "./desktop-owner.ts";
import { ConnectorError } from "./protocol.ts";

const maximumRecordBytes = 2_097_152;
const wanted = ["HOME=", "CODEX_HOME="] as const;
const invalid = () => new ConnectorError("desktop_selectors_unavailable", "The native server's original profile selectors could not be verified.", 503);

/** Decode only the two profile selectors, then erase the complete OS record. */
export function codeHomeFromProcessRecord(bytes: Uint8Array, expectedExecutable: string): string {
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
    for (let index = 0; index < argc; index += 1) next();
    const selected: Record<string, string> = {};
    while (offset < bytes.length && bytes[offset] !== 0) {
      const [start, end] = next();
      for (const prefix of wanted) {
        if (end - start < prefix.length || [...prefix].some((value, index) => bytes[start + index] !== value.charCodeAt(0))) continue;
        const key = prefix.slice(0, -1);
        if (selected[key] !== undefined || end - start - prefix.length > 4_096) throw invalid();
        selected[key] = decoder.decode(bytes.subarray(start + prefix.length, end));
      }
    }
    const home = selected.CODEX_HOME ?? (selected.HOME ? join(selected.HOME, ".codex") : undefined);
    if (!home || !isAbsolute(home) || home !== normalize(home) || home !== home.trim() || /[\x00-\x1f\x7f]/.test(home) || home === "/") throw invalid();
    return home;
  } catch { throw invalid(); }
  finally { bytes.fill(0); }
}

/** Service-only macOS inspection; the Node MCP connector never loads this module. */
export function readDesktopCodeHome(server: DesktopProcess): string {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) || !Number.isSafeInteger(server.pid) || server.pid <= 1 || server.pid > 0x7fffffff) throw invalid();
  const library = dlopen("/usr/lib/libSystem.B.dylib", { sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" } });
  // CTL_KERN / KERN_PROCARGS2: the OS exec record for this verified server PID.
  const mib = new Int32Array([1, 49, server.pid]), length = new BigUint64Array([0n]);
  let bytes: Uint8Array | undefined;
  try {
    if (library.symbols.sysctl(ptr(mib), 3, null, ptr(length), null, 0) !== 0 || length[0]! < 8n || length[0]! > BigInt(maximumRecordBytes)) throw invalid();
    bytes = new Uint8Array(Number(length[0]!));
    if (library.symbols.sysctl(ptr(mib), 3, ptr(bytes), ptr(length), null, 0) !== 0 || length[0]! > BigInt(bytes.length)) throw invalid();
    const home = realpathSync(codeHomeFromProcessRecord(bytes.subarray(0, Number(length[0]!)), server.executable));
    if (!statSync(home).isDirectory()) throw invalid();
    return home;
  } catch { throw invalid(); }
  finally { bytes?.fill(0); library.close(); }
}
