import { createConnection } from "node:net";
import type { ThreadState } from "../../contracts.ts";
import { identifier, maxWireBytes, record, type NativeInvocation } from "./protocol.ts";

export class NativeFailure extends Error {
  /** True once the request frame reached the native socket: the host may have acted on it. */
  constructor(readonly code: string, readonly written = false, readonly nativeCode?: number, readonly nativeMessage?: string) { super(code); }
}
export interface NativeSendArguments { threadId: string; prompt: string }
export type NativeSendOutcome =
  | { status: "accepted"; threadId: string }
  | { status: "refused"; code: string }
  | { status: "uncertain"; code: string };

/** Qualifies a native connector through the registered app's read-only tool catalogue. */
export class CodexNativeClient {
  #namespace?: string;
  #readNamespace?: string;
  constructor(private readonly pipePath: string, private readonly timeoutMs = 4_000) {}

  async qualify(signal?: AbortSignal): Promise<void> {
    const response = record(await this.#request(signal));
    if (!Array.isArray(response.tools)) throw new NativeFailure("native_incompatible");
    const tool = response.tools.map(record).find((item) => item.name === "send_message_to_thread");
    if (!tool || typeof tool.namespace !== "string") throw new NativeFailure("native_input_unavailable");
    const schema = record(tool.inputSchema), properties = record(schema.properties);
    if (schema.type !== "object" || record(properties.threadId).type !== "string" || record(properties.prompt).type !== "string" || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((field) => field !== "threadId" && field !== "prompt")))) throw new NativeFailure("native_incompatible");
    this.#namespace = identifier(tool.namespace);
  }

  /**
   * One native notification to a loaded task through the Desktop's own input tool.
   * The invocation stamp names the receiving task and a turn it has; the call
   * identity is fresh for each attempt. No model prepares or approves this call.
   */
  async send(origin: NativeInvocation, args: NativeSendArguments, signal?: AbortSignal): Promise<NativeSendOutcome> {
    let result: unknown;
    try {
      if (!this.#namespace) await this.qualify(signal);
      result = await this.#request(signal, "tools/call", {
        arguments: { threadId: identifier(args.threadId), prompt: args.prompt },
        callerSource: "codex", namespace: this.#namespace, tool: "send_message_to_thread",
        threadId: origin.threadId, turnId: origin.turnId, callId: origin.callId,
      });
    } catch (error) {
      const failure = error instanceof NativeFailure ? error : new NativeFailure("native_unavailable");
      // Only a failure before the request reached the socket is known to be unsent. Once written,
      // every answer other than the host's confirmation of the target, an error, a wrong id, a
      // malformed frame or silence, leaves the outcome unknown: nothing proves the host did not act.
      return failure.written ? { status: "uncertain", code: failure.code } : { status: "refused", code: failure.code };
    }
    try {
      const value = record(result);
      if (value.success !== true || !Array.isArray(value.contentItems)) throw new Error("unconfirmed");
      const confirmed = value.contentItems.map(record).some((item) => {
        if (item.type !== "inputText" || typeof item.text !== "string") return false;
        try { return record(JSON.parse(item.text)).threadId === args.threadId; } catch { return false; }
      });
      if (!confirmed) throw new Error("unconfirmed");
      return { status: "accepted", threadId: args.threadId };
    } catch {
      // The host answered after taking the input; an unparseable answer is not evidence that nothing was sent.
      return { status: "uncertain", code: "native_target_unconfirmed" };
    }
  }

  /** The latest turn of a loaded task; messages, previews and outputs are discarded at this reader. */
  async threadState(origin: NativeInvocation, threadId: string, signal?: AbortSignal): Promise<ThreadState> {
    if (!this.#readNamespace) {
      const list = record(await this.#request(signal));
      if (!Array.isArray(list.tools)) throw new NativeFailure("native_read_unavailable");
      const tool = list.tools.map(record).find((item) => item.name === "read_thread");
      if (!tool) throw new NativeFailure("native_read_unavailable");
      this.#readNamespace = identifier(tool.namespace);
    }
    const result = await this.#request(signal, "tools/call", {
      arguments: { threadId: identifier(threadId), turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 50 },
      callerSource: "codex", namespace: this.#readNamespace, tool: "read_thread",
      threadId: origin.threadId, turnId: origin.turnId, callId: origin.callId,
    });
    return parseThreadState(result, threadId);
  }

  #request(signal?: AbortSignal, method = "tools/list", params: unknown = { threadStartKind: "all" }): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new NativeFailure("native_aborted"));
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.pipePath);
      let settled = false, written = false, pending = Buffer.alloc(0);
      const finish = (error?: NativeFailure, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(new NativeFailure(error.code, written, error.nativeCode, error.nativeMessage)); else resolve(value);
      };
      const abort = () => finish(new NativeFailure("native_aborted"));
      const timer = setTimeout(() => finish(new NativeFailure("native_timeout")), this.timeoutMs);
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
        if (pending.length + bytes.length > maxWireBytes + 4) return finish(new NativeFailure("native_response_too_large"));
        pending = Buffer.concat([pending, bytes]);
        if (pending.length < 4) return;
        const size = pending.readUInt32LE(0);
        if (!size || size > maxWireBytes) return finish(new NativeFailure("native_invalid_frame"));
        if (pending.length < size + 4) return;
        try {
          const response = record(JSON.parse(pending.subarray(4, size + 4).toString("utf8")));
          if (response.jsonrpc !== "2.0" || response.id !== 1) return finish(new NativeFailure("native_rpc_uncorrelated"));
          if ("error" in response) {
            const error = record(response.error);
            if ("result" in response || typeof error.code !== "number") return finish(new NativeFailure("native_invalid_response"));
            return finish(new NativeFailure("native_call_failed", false, error.code, typeof error.message === "string" ? error.message.slice(0, 200) : undefined));
          }
          if (!("result" in response)) return finish(new NativeFailure("native_invalid_response"));
          finish(undefined, response.result);
        } catch { finish(new NativeFailure("native_invalid_response")); }
      });
      socket.once("error", () => finish(new NativeFailure("native_unavailable")));
      socket.once("close", () => finish(new NativeFailure("native_disconnected")));
    });
  }
}

export function parseThreadState(response: unknown, taskId: string): ThreadState {
  const unqualified = () => new NativeFailure("native_read_unqualified");
  const result = record(response);
  if (result.success !== true || !Array.isArray(result.contentItems) || result.contentItems.length !== 1) throw unqualified();
  const item = record(result.contentItems[0]);
  if (item.type !== "inputText" || typeof item.text !== "string") throw unqualified();
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(item.text)); } catch { throw unqualified(); }
  const thread = record(value.thread), page = record(value.page);
  if (value.schemaVersion !== 1 || thread.id !== taskId || thread.kind !== "codex" || page.order !== "newest_first" || !Array.isArray(value.turns) || value.turns.length !== 1) throw unqualified();
  const turn = record(value.turns[0]);
  if (!["inProgress", "completed", "interrupted", "failed"].includes(String(turn.status))) throw unqualified();
  const state: ThreadState = { taskId: identifier(taskId), turnId: identifier(turn.id), status: turn.status as ThreadState["status"] };
  const completedAt = turnCompletedAt(turn);
  if (completedAt !== undefined) state.completedAt = completedAt;
  return state;
}

/** The app-server's turn record gives `completedAt` in Unix seconds; a record without it gives nothing. */
export function turnCompletedAt(turn: Record<string, unknown>): number | undefined {
  const value = turn.completedAt;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  // Seconds in the protocol; a value already in milliseconds is left as it is.
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

export function nativeEvidence(origin: NativeInvocation): string {
  return `codex:${origin.threadId}:${origin.turnId}:${origin.callId}`;
}
