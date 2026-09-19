import { createConnection } from "node:net";
import type { DeliveryResult } from "../../contracts.ts";
import { identifier, maxWireBytes, nativeWakeup, record, type NativeDelivery, type NativeInvocation } from "./protocol.ts";

class NativeFailure extends Error {
  constructor(readonly code: string, readonly written: boolean) { super(code); }
}

/** Uses the registered app's existing-task input tool without creating another executor. */
export class CodexNativeClient {
  #namespace?: string;
  constructor(private readonly pipePath: string, private readonly timeoutMs = 4_000) {}

  async qualify(signal?: AbortSignal): Promise<void> {
    const response = record(await this.#request("tools/list", { threadStartKind: "all" }, signal));
    if (!Array.isArray(response.tools)) throw new NativeFailure("native_incompatible", false);
    const tool = response.tools.map(record).find((item) => item.name === "send_message_to_thread");
    if (!tool || typeof tool.namespace !== "string") throw new NativeFailure("native_input_unavailable", false);
    const schema = record(tool.inputSchema), properties = record(schema.properties);
    if (schema.type !== "object" || record(properties.threadId).type !== "string" || record(properties.prompt).type !== "string" || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((field) => field !== "threadId" && field !== "prompt")))) throw new NativeFailure("native_incompatible", false);
    this.#namespace = identifier(tool.namespace);
  }

  async deliver(delivery: NativeDelivery, signal?: AbortSignal): Promise<DeliveryResult> {
    const { binding, envelope } = delivery;
    const origin = binding.origin;
    if (!origin.turnId || !origin.callId) return { status: "retry", retryAfterMs: 5_000, code: "native_origin_required" };
    if (!this.#namespace) {
      try { await this.qualify(signal); }
      catch { return { status: "retry", retryAfterMs: 2_000, code: "native_input_unavailable" }; }
    }
    try {
      const response = record(await this.#request("tools/call", {
        namespace: this.#namespace,
        tool: "send_message_to_thread",
        threadId: origin.managerId,
        turnId: origin.turnId,
        callId: `seeker-${delivery.attemptId}`,
        arguments: { threadId: origin.managerId, prompt: nativeWakeup(delivery) },
      }, signal));
      if (response.success !== true || !Array.isArray(response.contentItems)) return { status: "unknown", code: "native_result_uncertain" };
      const target = response.contentItems.some((item: unknown) => {
        try { const content = record(item); return content.type === "inputText" && typeof content.text === "string" && record(JSON.parse(content.text)).threadId === origin.managerId; }
        catch { return false; }
      });
      return target
        ? { status: "accepted", reference: `codex:${envelope.deliveryId}` }
        : { status: "unknown", code: "native_target_unconfirmed" };
    } catch (error) {
      return error instanceof NativeFailure && !error.written
        ? { status: "retry", retryAfterMs: 2_000, code: error.code }
        : { status: "unknown", code: "native_delivery_uncertain" };
    }
  }

  #request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new NativeFailure("native_aborted", false));
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    if (payload.byteLength > maxWireBytes) return Promise.reject(new NativeFailure("native_request_too_large", false));
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.pipePath);
      let written = false, settled = false, pending = Buffer.alloc(0);
      const finish = (error?: NativeFailure, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new NativeFailure("native_aborted", written));
      const timer = setTimeout(() => finish(new NativeFailure("native_timeout", written)), this.timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => {
        if (signal?.aborted) return abort();
        const frame = Buffer.alloc(4 + payload.byteLength);
        frame.writeUInt32LE(payload.byteLength); payload.copy(frame, 4);
        written = true;
        socket.write(frame);
      });
      socket.on("data", (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (pending.length + bytes.length > maxWireBytes + 4) return finish(new NativeFailure("native_response_too_large", written));
        pending = Buffer.concat([pending, bytes]);
        if (pending.length < 4) return;
        const size = pending.readUInt32LE(0);
        if (!size || size > maxWireBytes) return finish(new NativeFailure("native_invalid_frame", written));
        if (pending.length < size + 4) return;
        try {
          const response = record(JSON.parse(pending.subarray(4, size + 4).toString("utf8")));
          if (response.jsonrpc !== "2.0" || response.id !== 1 || !("result" in response) || "error" in response) return finish(new NativeFailure("native_rpc_error", written));
          finish(undefined, response.result);
        } catch { finish(new NativeFailure("native_invalid_response", written)); }
      });
      socket.once("error", () => finish(new NativeFailure("native_unavailable", written)));
      socket.once("close", () => finish(new NativeFailure("native_disconnected", written)));
    });
  }
}

export function nativeEvidence(origin: NativeInvocation): string {
  return `codex:${origin.threadId}:${origin.turnId}:${origin.callId}`;
}
