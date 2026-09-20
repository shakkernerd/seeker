import type { DeliveryResult, HostEnvelope, ManagerBinding } from "../../contracts.ts";
import type { SeekerCore } from "../../core/seeker.ts";
import { sameOwner } from "../../core/validation.ts";
import { hostEnvelopeCurrent } from "../codex-common/current.ts";
import type { HelperEvents, HelperRequestId } from "./helper-rpc.ts";
import type { DesktopHelperRuntime, PreparedHelper } from "./helper-runtime.ts";
import { envelopeReference, identifier, nativeWakeup, record } from "./protocol.ts";

interface Job {
  key: string;
  binding: ManagerBinding;
  envelope: HostEnvelope;
  args: { threadId: string; prompt: string };
  controller: AbortController;
  phase: "preparing" | "ready" | "sending" | "finished";
  helper?: PreparedHelper;
  turnId?: string;
  itemId?: string;
  approval?: HelperRequestId;
  approvalWritten: boolean;
  watch: ReturnType<typeof setInterval>;
  expires: ReturnType<typeof setTimeout>;
  inputTimer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
  result?: Promise<DeliveryResult>;
  finish?: (value: DeliveryResult) => void;
}
const retry = (code: string): DeliveryResult => ({ status: "retry", retryAfterMs: 1_000, code });
const epoch = (binding: ManagerBinding) => [binding.id, binding.origin.hostId, binding.origin.managerId, binding.origin.assignmentId, binding.origin.generation];

/** Model preparation cannot send: one real native approval is the input boundary. */
export class DesktopHelperDelivery {
  #job?: Job;
  readonly #finished = new Map<string, { key: string; result: DeliveryResult }>();
  readonly #failed = new Map<string, { key: string; attempts: number; nextAt: number }>();
  readonly #settling = new Set<Promise<unknown>>();
  #closed = false;
  #readyTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly core: SeekerCore, private readonly runtime: DesktopHelperRuntime, private readonly preparationMs = 60_000, private readonly inputMs = 4_000, private readonly readyMs = 15_000) {}

  deliver(binding: ManagerBinding, envelope: HostEnvelope, signal: AbortSignal): Promise<DeliveryResult> {
    if (this.#closed || signal.aborted) return Promise.resolve(retry("desktop_helper_unavailable"));
    const current = this.core.managerBinding(binding.origin.hostId, binding.origin.managerId);
    if (!current || current.id !== binding.id || !sameOwner(current.origin, binding.origin)) return Promise.resolve({ status: "rejected", code: "owner_changed" });
    const args = { threadId: binding.origin.managerId, prompt: nativeWakeup({ attemptId: envelope.deliveryId, binding, envelope }) };
    const key = JSON.stringify([epoch(binding), envelope.deliveryId, envelope.exchangeId, envelopeReference(envelope), args]);
    const finished = this.#finished.get(envelope.deliveryId);
    if (finished) return Promise.resolve(finished.key === key ? finished.result : { status: "rejected", code: "delivery_identity_changed" });
    if (!hostEnvelopeCurrent(this.core, binding, envelope)) return Promise.resolve({ status: "rejected", code: "owner_or_exchange_changed" });
    const previous = this.#job;
    if (previous && previous.key !== key && previous.phase !== "sending" && !this.#current(previous)) this.#finish(previous, retry("desktop_helper_cancelled"));
    if (this.#job && this.#job.key !== key) return Promise.resolve(retry("desktop_helper_busy"));
    if (!this.#job) {
      const failed = this.#failed.get(envelope.deliveryId);
      if (failed?.key === key && (failed.attempts >= 2 || Date.now() < failed.nextAt)) return Promise.resolve(retry("desktop_helper_preparation_failed"));
      this.#prepare(binding, envelope, args, key); return Promise.resolve(retry("desktop_helper_preparing"));
    }
    const job = this.#job;
    if (job.phase === "sending") return job.result!;
    if (job.phase !== "ready" || !job.helper || job.approval === undefined) return Promise.resolve(retry("desktop_helper_preparing"));
    job.result = new Promise((resolve) => { job.finish = resolve; });
    job.signal = signal;
    job.abort = () => this.#finish(job, job.approvalWritten ? { status: "unknown", code: "desktop_input_uncertain" } : retry("desktop_helper_cancelled"));
    signal.addEventListener("abort", job.abort, { once: true });
    job.inputTimer = setTimeout(job.abort, this.inputMs); job.inputTimer.unref();
    // Nothing asynchronous belongs between this current-attempt fence and the
    // sole affirmative response to the helper's actual native tool request.
    if (signal.aborted || !this.#current(job) || !job.helper.rpc.connected) { job.abort(); return job.result; }
    clearTimeout(job.expires);
    job.phase = "sending"; job.approvalWritten = true;
    try { job.helper.rpc.respond(job.approval, { action: "accept", content: null, _meta: null }); }
    catch { this.#finish(job, { status: "unknown", code: "desktop_input_uncertain" }); }
    return job.result;
  }

  async close(): Promise<void> {
    this.#closed = true; clearTimeout(this.#readyTimer);
    if (this.#job) this.#finish(this.#job, this.#job.approvalWritten ? { status: "unknown", code: "desktop_input_uncertain" } : retry("desktop_helper_closed"));
    await this.runtime.close();
    await Promise.allSettled([...this.#settling]);
    this.#finished.clear(); this.#failed.clear();
  }

  /** Genuine manager re-admission is a real recovery event, not a model polling loop. */
  restored(): void {
    if (this.#closed) return;
    this.#failed.clear();
    this.core.resumeHost("codex-desktop");
  }

  #current(job: Job): boolean {
    return !this.#closed && this.#job === job && !job.controller.signal.aborted && hostEnvelopeCurrent(this.core, job.binding, job.envelope);
  }
  #prepare(binding: ManagerBinding, envelope: HostEnvelope, args: Job["args"], key: string): void {
    const controller = new AbortController();
    const job: Job = { key, binding, envelope, args, controller, phase: "preparing", approvalWritten: false,
      watch: setInterval(() => { if (!this.#current(job)) this.#finish(job, job.approvalWritten ? { status: "unknown", code: "desktop_input_uncertain" } : retry("desktop_helper_cancelled")); }, 250),
      expires: setTimeout(() => this.#finish(job, retry("desktop_helper_preparation_failed")), this.preparationMs),
    };
    job.watch.unref(); job.expires.unref(); this.#job = job;
    const events: HelperEvents = {
      notice: (method, params) => this.#notice(job, method, params),
      request: (id, method, params) => this.#approval(job, id, method, params),
      lost: () => this.#finish(job, job.approvalWritten ? { status: "unknown", code: "desktop_input_uncertain" } : retry("desktop_helper_unavailable")),
    };
    const preparation = (async () => {
      const helper = await this.runtime.prepare(events, controller.signal, () => this.#current(job));
      if (!this.#current(job)) return;
      job.helper = helper;
      const turnId = await helper.start([
        "You are Seeker's bounded notification helper. Send exactly one native notification and do nothing else.",
        "Call codex_app send_message_to_thread exactly once using the JSON arguments below, unchanged. Do not read files, run commands, navigate, change any task settings, or call any other tool.",
        "The service will decide the one pending tool approval. Do not retry, poll, improvise another target, or infer approval from the notification. After the tool result, stop.",
        JSON.stringify(args),
      ].join("\n"), controller.signal);
      if (!this.#current(job)) return;
      if (job.turnId && job.turnId !== turnId) throw new Error("helper turn mismatch");
      job.turnId = turnId;
    })().catch(() => { if (!this.#closed) this.#finish(job, retry("desktop_helper_preparation_failed")); });
    this.#track(preparation);
  }

  #approval(job: Job, id: HelperRequestId, method: string, value: unknown): void {
    const rpc = job.helper?.rpc;
    const deny = () => { try { if (method === "mcpServer/elicitation/request") rpc?.respond(id, { action: "cancel", content: null, _meta: null }); else rpc?.reject(id); } catch { /* A lost helper has no grant. */ } };
    try {
      const params = record(value), meta = record(params._meta);
      if (!this.#current(job) || job.phase !== "preparing" || job.approval !== undefined || !job.itemId || !job.turnId || method !== "mcpServer/elicitation/request" || params.mode !== "form" || params.serverName !== "codex_app" || params.threadId !== job.helper?.threadId || params.turnId !== job.turnId || meta.codex_approval_kind !== "mcp_tool_call" || !sameArguments(meta.tool_params, job.args)) throw new Error("unqualified approval");
      job.approval = id; job.phase = "ready";
      clearTimeout(job.expires);
      job.expires = setTimeout(() => this.#finish(job, retry("desktop_helper_preparation_expired")), this.readyMs); job.expires.unref();
      // Run after the current retry commits, including its fifth/exhausted attempt.
      clearTimeout(this.#readyTimer);
      this.#readyTimer = setTimeout(() => { if (this.#current(job) && job.phase === "ready") this.core.resumeHost(job.binding.origin.hostId); }, 0);
      this.#readyTimer.unref();
    } catch {
      deny();
      this.#finish(job, job.approvalWritten ? { status: "unknown", code: "desktop_input_uncertain" } : retry("desktop_helper_request_rejected"));
    }
  }

  #notice(job: Job, method: string, value: unknown): void {
    if (this.#closed || this.#job !== job || job.phase === "finished") return;
    try {
      const params = record(value);
      if (params.threadId !== job.helper?.threadId) return;
      if (method === "turn/started") {
        const turnId = identifier(record(params.turn).id);
        if (job.turnId && job.turnId !== turnId) throw new Error("helper turn mismatch");
        job.turnId = turnId; return;
      }
      if (method === "turn/completed") {
        if (record(params.turn).id === job.turnId) this.#finish(job, job.approvalWritten ? { status: "unknown", code: "desktop_native_receipt_missing" } : retry("desktop_helper_no_call"));
        return;
      }
      if (method !== "item/started" && method !== "item/completed") return;
      const item = record(params.item);
      if (item.type !== "mcpToolCall") return;
      if (!job.turnId || params.turnId !== job.turnId || item.server !== "codex_app" || item.tool !== "send_message_to_thread" || !sameArguments(item.arguments, job.args)) throw new Error("helper call mismatch");
      const itemId = identifier(item.id);
      if (method === "item/started") {
        if (job.itemId || job.phase !== "preparing") throw new Error("duplicate helper call");
        job.itemId = itemId; return;
      }
      if (!job.approvalWritten || job.phase !== "sending" || itemId !== job.itemId) throw new Error("uncorrelated native result");
      const result = record(item.result);
      if (item.status !== "completed" || item.error != null || result.isError === true || !Array.isArray(result.content) || !result.content.some((part) => {
        try { const block = record(part); return block.type === "text" && typeof block.text === "string" && record(JSON.parse(block.text)).threadId === job.args.threadId; } catch { return false; }
      })) throw new Error("native target unconfirmed");
      this.#finish(job, { status: "accepted", reference: `codex:${job.helper!.threadId}:${job.turnId}:${itemId}` });
    } catch { this.#finish(job, job.approvalWritten ? { status: "unknown", code: "desktop_native_result_uncertain" } : retry("desktop_helper_request_rejected")); }
  }

  #finish(job: Job, result: DeliveryResult): void {
    if (job.phase === "finished") return;
    job.phase = "finished";
    clearInterval(job.watch); clearTimeout(job.expires); clearTimeout(job.inputTimer);
    if (job.abort) job.signal?.removeEventListener("abort", job.abort);
    if (!job.approvalWritten && job.approval !== undefined) {
      try { job.helper?.rpc.respond(job.approval, { action: "cancel", content: null, _meta: null }); } catch { /* No affirmative response was sent. */ }
    }
    job.controller.abort();
    if (job.approvalWritten && result.status === "retry") result = { status: "unknown", code: "desktop_input_uncertain" };
    let retryPreparation = false;
    if (result.status === "retry") {
      const previous = this.#failed.get(job.envelope.deliveryId);
      const attempts = (previous?.key === job.key ? previous.attempts : 0) + 1;
      this.#failed.set(job.envelope.deliveryId, { key: job.key, attempts, nextAt: Date.now() + 1_000 });
      if (this.#failed.size > 512) this.#failed.delete(this.#failed.keys().next().value!);
      retryPreparation = attempts < 2;
    } else {
      this.#finished.set(job.envelope.deliveryId, { key: job.key, result });
      if (this.#finished.size > 512) this.#finished.delete(this.#finished.keys().next().value!);
    }
    job.finish?.(result);
    // Receipt resolution need not wait for model completion, but the next job
    // cannot reuse a thread while its previous native turn could still act.
    this.#track(this.runtime.reset().then(() => {
      if (this.#job === job) this.#job = undefined;
      if (!this.#closed && (result.status !== "retry" || retryPreparation)) {
        clearTimeout(this.#readyTimer);
        this.#readyTimer = setTimeout(() => { if (!this.#closed) this.core.resumeHost(job.binding.origin.hostId); }, retryPreparation ? 1_000 : 0);
        this.#readyTimer.unref();
      }
    }));
  }
  #track(operation: Promise<unknown>): void {
    this.#settling.add(operation);
    void operation.finally(() => this.#settling.delete(operation)).catch(() => {});
  }
}
function sameArguments(value: unknown, expected: Job["args"]): boolean {
  try { const args = record(value); return Object.keys(args).length === 2 && args.threadId === expected.threadId && args.prompt === expected.prompt; }
  catch { return false; }
}
