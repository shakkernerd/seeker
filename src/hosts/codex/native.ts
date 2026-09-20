import { createConnection } from "node:net";
import { identifier, maxWireBytes, record, type NativeInvocation } from "./protocol.ts";

class NativeFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Qualifies a native connector through the registered app's read-only tool catalogue. */
export class CodexNativeClient {
  constructor(private readonly pipePath: string, private readonly timeoutMs = 4_000) {}

  async qualify(signal?: AbortSignal): Promise<void> {
    const response = record(await this.#request(signal));
    if (!Array.isArray(response.tools)) throw new NativeFailure("native_incompatible");
    const tool = response.tools.map(record).find((item) => item.name === "send_message_to_thread");
    if (!tool || typeof tool.namespace !== "string") throw new NativeFailure("native_input_unavailable");
    const schema = record(tool.inputSchema), properties = record(schema.properties);
    if (schema.type !== "object" || record(properties.threadId).type !== "string" || record(properties.prompt).type !== "string" || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((field) => field !== "threadId" && field !== "prompt")))) throw new NativeFailure("native_incompatible");
    identifier(tool.namespace);
  }

  #request(signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new NativeFailure("native_aborted"));
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { threadStartKind: "all" } }));
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.pipePath);
      let settled = false, pending = Buffer.alloc(0);
      const finish = (error?: NativeFailure, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new NativeFailure("native_aborted"));
      const timer = setTimeout(() => finish(new NativeFailure("native_timeout")), this.timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => {
        if (signal?.aborted) return abort();
        const frame = Buffer.alloc(4 + payload.byteLength);
        frame.writeUInt32LE(payload.byteLength); payload.copy(frame, 4);
        socket.write(frame);
      });
      socket.on("data", (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (pending.length + bytes.length > maxWireBytes + 4) return finish(new NativeFailure("native_response_too_large"));
        pending = Buffer.concat([pending, bytes]);
        if (pending.length < 4) return;
        const size = pending.readUInt32LE(0);
        if (!size || size > maxWireBytes) return finish(new NativeFailure("native_invalid_frame"));
        if (pending.length < size + 4) return;
        try {
          const response = record(JSON.parse(pending.subarray(4, size + 4).toString("utf8")));
          if (response.jsonrpc !== "2.0" || response.id !== 1 || !("result" in response) || "error" in response) return finish(new NativeFailure("native_rpc_error"));
          finish(undefined, response.result);
        } catch { finish(new NativeFailure("native_invalid_response")); }
      });
      socket.once("error", () => finish(new NativeFailure("native_unavailable")));
      socket.once("close", () => finish(new NativeFailure("native_disconnected")));
    });
  }
}

export function nativeEvidence(origin: NativeInvocation): string {
  return `codex:${origin.threadId}:${origin.turnId}:${origin.callId}`;
}
