import { maxWireBytes } from "../codex/protocol.ts";

/** A write followed by a lost response is uncertain, even for a caller-supplied message ID. */
export class NativeRpcError extends Error {
  constructor(readonly written: boolean, readonly code: string, readonly nativeCode?: number, readonly nativeMessage?: string) {
    super("The registered Codex CLI host did not complete this request.");
  }
}

interface Pending {
  written: boolean;
  finish(error?: NativeRpcError, value?: unknown): void;
}

/** JSON-RPC over the original host's Unix WebSocket; never answers native approval requests. */
export class CliRpc {
  readonly #pending = new Map<string, Pending>();
  #sequence = 0;
  #closed = false;
  onNotice?: (method: string, params: unknown) => void;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || Buffer.byteLength(event.data) > maxWireBytes) { this.close(); return; }
      let message: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(event.data);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        message = value as Record<string, unknown>;
      } catch { this.close(); return; }
      // Server requests also carry IDs. Responding, including with an error,
      // would consume the callback shared with the manager's original interface.
      if (typeof message.method === "string") {
        if (message.id === undefined) this.onNotice?.(message.method, message.params);
        return;
      }
      if (typeof message.id !== "string") return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      if (message.error && typeof message.error === "object" && !Array.isArray(message.error)) {
        const error = message.error as Record<string, unknown>;
        pending.finish(new NativeRpcError(pending.written, "native_rejection", typeof error.code === "number" ? error.code : undefined, typeof error.message === "string" ? error.message.slice(0, 1_024) : undefined));
      } else if (Object.hasOwn(message, "result")) pending.finish(undefined, message.result);
      else pending.finish(new NativeRpcError(pending.written, "invalid_native_response"));
    });
    socket.addEventListener("close", () => this.#lost());
    socket.addEventListener("error", () => this.#lost());
  }

  static async connect(path: string, signal: AbortSignal): Promise<CliRpc> {
    // Bun's compression offer is incompatible with the qualified native Unix listener.
    // The project's DOM lib hides Bun's documented constructor-options overload.
    const UnixWebSocket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };
    const socket = new UnixWebSocket(`ws+unix://${path}`, { perMessageDeflate: false });
    const client = new CliRpc(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer); signal.removeEventListener("abort", abort);
          socket.removeEventListener("open", open); socket.removeEventListener("error", failed); socket.removeEventListener("close", failed);
          if (error) reject(error); else resolve();
        };
        const open = () => finish(), failed = () => finish(new NativeRpcError(false, "native_offline")), abort = () => finish(new NativeRpcError(false, "native_aborted"));
        const timer = setTimeout(failed, 2_000); timer.unref();
        socket.addEventListener("open", open, { once: true }); socket.addEventListener("error", failed, { once: true }); socket.addEventListener("close", failed, { once: true });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      await client.request("initialize", { clientInfo: { name: "seeker_cli", version: "0.1.0" }, capabilities: { experimentalApi: true } }, signal);
      socket.send(JSON.stringify({ method: "initialized", params: {} }));
      return client;
    } catch (error) { client.close(); throw error; }
  }

  get connected(): boolean { return !this.#closed && this.socket.readyState === WebSocket.OPEN; }

  request<T = unknown>(method: string, params: unknown, signal: AbortSignal, timeoutMs = 3_000): Promise<T> {
    if (signal.aborted || !this.connected) return Promise.reject(new NativeRpcError(false, "native_offline"));
    if (this.#pending.size >= 32) return Promise.reject(new NativeRpcError(false, "native_capacity"));
    const id = `seeker-${++this.#sequence}`, payload = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(payload) > maxWireBytes) return Promise.reject(new NativeRpcError(false, "native_request_too_large"));
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { written: false, finish: (error, value) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value as T);
      } };
      const abort = () => entry.finish(new NativeRpcError(entry.written, "native_aborted"));
      const timer = setTimeout(() => entry.finish(new NativeRpcError(entry.written, "native_timeout")), timeoutMs); timer.unref();
      this.#pending.set(id, entry); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try { this.socket.send(payload); entry.written = true; }
      catch { entry.finish(new NativeRpcError(false, "native_offline")); }
    });
  }

  close(): void { this.#lost(); this.socket.close(); }
  #lost(): void {
    this.#closed = true;
    for (const entry of this.#pending.values()) entry.finish(new NativeRpcError(entry.written, "native_connection_lost"));
  }
}
