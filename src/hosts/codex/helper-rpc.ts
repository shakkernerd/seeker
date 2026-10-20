import type { Socket } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ConnectorError, maxWireBytes, record } from "./protocol.ts";

export type HelperRequestId = string | number;
export interface HelperEvents {
  notice(method: string, params: unknown): void;
  request(id: HelperRequestId, method: string, params: unknown): void;
  lost(): void;
}
export interface HelperConnection {
  readonly connected: boolean;
  events?: HelperEvents;
  request(method: string, params: unknown, signal: AbortSignal, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  respond(id: HelperRequestId, result: unknown): void;
  reject(id: HelperRequestId): void;
  close(): Promise<void>;
}
export class HelperRpcError extends ConnectorError {
  constructor(readonly nativeCode?: number, readonly nativeMessage?: string) {
    super("desktop_helper_unavailable", "The owned native helper did not complete its request.", 503);
  }
}
interface Pending { finish(error?: Error, value?: unknown): void }

/** The only native server controlled here is Seeker's own stdio helper. */
export class HelperRpc {
  readonly #pending = new Map<string, Pending>();
  readonly #child?: ChildProcessWithoutNullStreams;
  readonly #socket?: Socket;
  readonly #input: NodeJS.WritableStream;
  readonly #output: NodeJS.ReadableStream;
  #sequence = 0;
  #buffer = "";
  #closed = false;
  #closing?: Promise<void>;
  #closeFailed = false;
  #closeNotice?: () => void;
  #exit: Promise<void>;
  #settled = false;
  #remoteSettled = false;
  events?: HelperEvents;

  constructor(executable: string | Socket, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    if (typeof executable === "string") {
      const child = spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      this.#child = child; this.#input = child.stdin; this.#output = child.stdout;
      child.stderr.resume();
      child.stderr.on("error", () => this.#lost());
      child.once("error", () => this.#lost()); child.once("exit", () => this.#lost());
      this.#exit = new Promise((resolve) => child.once("close", () => { this.#settled = true; this.#lost(); resolve(); }));
    } else {
      this.#socket = executable; this.#input = executable; this.#output = executable;
      this.#exit = new Promise((resolve) => executable.once("close", () => { this.#settled = true; this.#lost(); resolve(); }));
    }
    this.#output.setEncoding("utf8");
    this.#output.on("data", (chunk: string) => this.#read(chunk));
    this.#input.on("error", () => this.#lost());
    this.#output.on("error", () => this.#lost());
  }

  get connected(): boolean { return !this.#closed && this.#input.writable && !(this.#input as { destroyed?: boolean }).destroyed; }

  async request(method: string, params: unknown, signal: AbortSignal, timeoutMs = 10_000): Promise<unknown> {
    if (!this.connected || signal.aborted) throw unavailable();
    if (this.#pending.size >= 32) throw unavailable();
    const id = `seeker-helper-${++this.#sequence}`;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(unavailable());
      const timer = setTimeout(abort, timeoutMs); timer.unref();
      this.#pending.set(id, { finish }); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try { this.#write({ id, method, params }); } catch { finish(unavailable()); }
    });
  }

  notify(method: string, params: unknown): void { this.#write({ method, params }); }

  /** Synchronous, one-request response: callers fence immediately before this write. */
  respond(id: HelperRequestId, result: unknown): void { this.#write({ id, result }); }
  reject(id: HelperRequestId): void {
    if (this.connected) this.#write({ id, error: { code: -32601, message: "This helper only supports its requested Seeker notification." } });
  }

  close(): Promise<void> {
    // A deadline is not evidence against a later close event. For a bridge,
    // only its affirmative acknowledgment plus EOF confirms native settlement.
    if (this.#settled && (!this.#socket || this.#remoteSettled)) {
      if (!this.#closing || this.#closeFailed) { this.#closing = Promise.resolve(); this.#closeFailed = false; }
      return this.#closing;
    }
    if (this.#closing && (!this.#closeFailed || !this.#socket || this.#socket.destroyed)) return this.#closing;
    this.#closeFailed = false;
    let resolveClose!: () => void, rejectClose!: (reason: unknown) => void;
    this.#closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    this.#lost();
    void (async () => {
      // EOF lets the official launcher/native server settle their own MCP children.
      if (this.#socket) {
        // A local socket close does not prove that the connector settled its child.
        // Keep reading only the explicit settlement acknowledgment until its EOF.
        const notice = new Promise<void>((resolve) => { this.#closeNotice = resolve; });
        if (!this.#socket.destroyed) this.#socket.write(JSON.stringify({ method: "seeker/close" }) + "\n");
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([this.#exit, notice, new Promise<void>((resolve) => { timer = setTimeout(resolve, 7_000); })]);
        clearTimeout(timer); this.#closeNotice = undefined;
        if (!this.#settled || !this.#remoteSettled) {
          // Preserve the sole channel for late settlement, with no ordinary RPC
          // traffic and no process-lifetime hold. Re-admission may recheck it.
          this.#socket.unref();
          throw new ConnectorError("desktop_helper_cleanup_failed", "The Desktop connector did not confirm native child settlement.", 503);
        }
        return;
      }
      const child = this.#child!;
      child.stdin.end();
      child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.#exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); })]);
      clearTimeout(timer);
      if (!this.#settled && child.pid) {
        // This process group was created by this exact ChildProcess, never adopted.
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* It already exited. */ }
        await Promise.race([this.#exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); })]);
        clearTimeout(timer);
        if (!this.#settled) {
          child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
          throw new ConnectorError("desktop_helper_cleanup_failed", "The owned helper did not settle its native pipes.", 503);
        }
      }
    })().then(resolveClose, (error) => { this.#closeFailed = true; rejectClose(error); });
    return this.#closing;
  }

  #write(value: unknown): void {
    if (!this.connected) throw unavailable();
    const line = JSON.stringify(value);
    if (Buffer.byteLength(line) > maxWireBytes) throw unavailable();
    this.#input.write(`${line}\n`);
  }
  #read(chunk: string): void {
    if (this.#closed && !this.#socket) return;
    this.#buffer += chunk;
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end < 0) {
        if (Buffer.byteLength(this.#buffer) > maxWireBytes) this.#invalid();
        return;
      }
      const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
      if (Buffer.byteLength(line) > maxWireBytes) { this.#invalid(); return; }
      if (!line.trim()) continue;
      try {
        const message = record(JSON.parse(line));
        if (this.#socket && message.method === "seeker/settled") {
          this.#remoteSettled = message.params === true;
          if (!this.#remoteSettled) this.#closeNotice?.();
          continue;
        }
        if (this.#closed) continue;
        if (typeof message.method === "string") {
          if (typeof message.id === "string" || typeof message.id === "number") {
            if (this.events) this.events.request(message.id, message.method, message.params);
            else this.reject(message.id);
          } else this.events?.notice(message.method, message.params);
        } else if (typeof message.id === "string") {
          const pending = this.#pending.get(message.id);
          if (message.error !== undefined) {
            const error = record(message.error);
            pending?.finish(new HelperRpcError(typeof error.code === "number" ? error.code : undefined, typeof error.message === "string" ? error.message.slice(0, 1024) : undefined));
          }
          else if (Object.hasOwn(message, "result")) pending?.finish(undefined, message.result);
        }
      } catch { this.#invalid(); return; }
      if (this.#closed && !this.#socket) return;
    }
  }
  #invalid(): void {
    // A quarantined socket must not retain unbounded or malformed input.
    if (this.#socket) { this.#remoteSettled = false; this.#socket.destroy(); }
    void this.close().catch(() => {});
  }
  #lost(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.finish(unavailable());
    this.events?.lost();
  }
}
function unavailable(): HelperRpcError { return new HelperRpcError(); }
