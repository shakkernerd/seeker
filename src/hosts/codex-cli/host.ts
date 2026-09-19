import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DeliveryResult, HostAdapter, HostEnvelope, ManagerBinding } from "../../contracts.ts";
import { SeekerCore } from "../../core/seeker.ts";
import { SeekerError } from "../../core/validation.ts";
import { ConnectorError, envelopeReference, identifier, nativeWakeup, onlyKeys, parseInvocation, record, type NativeInvocation } from "../codex/protocol.ts";
import { invokeManager } from "../codex/tools.ts";
import { parseCliOwner, sameCliProcess, sameCliProfile, type CliOwner, type RegisteredCliOwner } from "./owner.ts";
import { NativeRpcError } from "./rpc.ts";
import { nativeCliRuntime, type CliRuntime, type NativeCliConnection } from "./runtime.ts";
import { readCliRegistration, saveCliRegistration } from "./state.ts";
import { cliHostId, cliRoute } from "./config.ts";

const epoch = (binding: ManagerBinding) => JSON.stringify([binding.id, binding.origin.hostId, binding.origin.managerId, binding.origin.assignmentId, binding.origin.generation]);
const retry = (code: string): DeliveryResult => ({ status: "retry", retryAfterMs: 1_000, code });
function mode(value: unknown): RegisteredCliOwner["remoteControl"] {
  const status = record(value).status;
  if (status === "disabled") return "disabled";
  if (["connecting", "connected", "errored"].includes(String(status))) return "enabled";
  throw new ConnectorError("cli_mode_unqualified", "The native CLI did not expose its current launch mode.", 503);
}

/** The service owns delivery and bounded preparation; an MCP child only conveys native invocations. */
export class CodexCliHost implements HostAdapter {
  readonly id = cliHostId;
  readonly #lifetime = new AbortController();
  readonly #ready = new Map<string, string>();
  readonly #preparing = new Map<string, Promise<void>>();
  readonly #attempts = new Map<string, { identity: string; result: Promise<DeliveryResult> }>();
  readonly #finished = new Map<string, { identity: string; result: DeliveryResult }>();
  readonly #admitted = new Set<string>();
  #registration?: RegisteredCliOwner;
  #rpc?: NativeCliConnection;
  #connecting?: Promise<NativeCliConnection>;
  #admitting?: Promise<void>;
  #modeWatch?: { rpc: NativeCliConnection; revision: number; serial: number };
  #ownerRevision = 0;
  #nextPreparation = 0;
  #stateFailed = false;
  #readyTimer?: ReturnType<typeof setTimeout>;
  #closed = false;

  constructor(private readonly core: SeekerCore, private readonly credential: string, private readonly statePath: string, private readonly runtime: CliRuntime = nativeCliRuntime) {
    if (!/^[a-f0-9]{64}$/.test(credential)) throw new ConnectorError("invalid_credential", "A private CLI connector credential is required.");
    this.#registration = readCliRegistration(statePath);
  }

  async handle(request: Request): Promise<Response> {
    try {
      if (new URL(request.url).pathname !== cliRoute) return new Response(null, { status: 404 });
      if (this.#closed) throw new ConnectorError("host_closed", "The CLI bridge is stopping.", 503);
      if (request.method !== "POST" || request.headers.has("origin")) throw new ConnectorError("origin_denied", "Use the native CLI connector.", 403);
      const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (!supplied || supplied.length !== this.credential.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(this.credential))) throw new ConnectorError("unauthorized", "Native connector authentication failed.", 401);
      const text = await request.text();
      if (Buffer.byteLength(text) > 65_536) throw new ConnectorError("too_large", "The native invocation is too large.", 413);
      const body = record(JSON.parse(text)); onlyKeys(body, ["owner", "origin", "operation", "arguments"]);
      const origin = parseInvocation(body.origin), binding = this.#binding(origin);
      const owner = parseCliOwner(body.owner), signal = AbortSignal.any([request.signal, this.#lifetime.signal, AbortSignal.timeout(4_000)]);
      await this.#admit(owner, signal);
      const rpc = this.#rpc!;
      const current = record(await rpc.request("thread/read", { threadId: origin.threadId, includeTurns: false }, signal));
      const thread = record(current.thread);
      if (thread.id !== origin.threadId || record(thread.status).type === "notLoaded") throw new ConnectorError("origin_denied", "The original CLI owner has not loaded this manager.", 403);
      signal.throwIfAborted();
      if (epoch(this.#binding(origin)) !== epoch(binding)) throw new ConnectorError("owner_changed", "The manager assignment changed during admission.", 409);
      const port = this.core.manager({ ...binding.origin, turnId: origin.turnId, callId: origin.callId });
      const result = invokeManager(port, identifier(body.operation), body.arguments, origin);
      const key = epoch(binding);
      if (!this.#admitted.has(key)) {
        this.#admitted.add(key); if (this.#admitted.size > 512) this.#admitted.delete(this.#admitted.values().next().value!);
        this.#restored();
      }
      return json(result);
    } catch (error) {
      const known = error instanceof SeekerError;
      return json({ error: known ? error.code : "cli_unavailable", message: known ? error.message : "Seeker could not verify the original CLI owner. Retain request IDs and inspect the exchange before repeating a mutation." }, known ? error.status : 503);
    }
  }

  async deliver(binding: ManagerBinding, envelope: HostEnvelope, signal: AbortSignal): Promise<DeliveryResult> {
    if (this.#closed || signal.aborted || this.#stateFailed) return retry("cli_unavailable");
    if (!this.#current(binding, envelope)) return { status: "rejected", code: "owner_or_exchange_changed" };
    const identity = JSON.stringify([epoch(binding), envelope.exchangeId, envelopeReference(envelope)]);
    const prior = this.#finished.get(envelope.deliveryId);
    if (prior) return prior.identity === identity ? prior.result : { status: "rejected", code: "delivery_identity_changed" };
    const attempt = this.#attempts.get(envelope.deliveryId);
    if (attempt) return attempt.identity === identity ? attempt.result : { status: "rejected", code: "delivery_identity_changed" };
    const key = `${epoch(binding)}:${this.#ownerRevision}`;
    if (!this.#rpc?.connected || this.#ready.get(binding.origin.managerId) !== key) {
      this.#prepare(binding);
      return retry(this.#registration ? "cli_preparing" : "cli_not_admitted");
    }
    const result = this.#send(binding, envelope, signal).then((result) => {
      if (result.status !== "retry") {
        this.#finished.set(envelope.deliveryId, { identity, result });
        if (this.#finished.size > 512) this.#finished.delete(this.#finished.keys().next().value!);
      }
      return result;
    }).finally(() => this.#attempts.delete(envelope.deliveryId));
    this.#attempts.set(envelope.deliveryId, { identity, result });
    return result;
  }

  async close(): Promise<void> {
    this.#closed = true; this.#lifetime.abort(); clearTimeout(this.#readyTimer); this.#rpc?.close();
    await Promise.allSettled([...this.#preparing.values(), this.#connecting, this.#admitting]);
    this.#ready.clear(); this.#finished.clear();
  }

  #binding(origin: NativeInvocation): ManagerBinding {
    const binding = this.core.managerBinding(this.id, origin.threadId);
    if (!binding) throw new ConnectorError("origin_denied", "This native CLI task is not a registered manager. Report to your manager.", 403);
    return binding;
  }
  #bindingCurrent(binding: ManagerBinding): boolean {
    const current = this.core.managerBinding(this.id, binding.origin.managerId);
    return Boolean(current && epoch(current) === epoch(binding));
  }
  #current(binding: ManagerBinding, envelope: HostEnvelope): boolean {
    if (!this.#bindingCurrent(binding)) return false;
    const view = this.core.store.get(envelope.exchangeId), exchange = view?.exchange;
    if (!view || !exchange || exchange.bindingId !== binding.id || exchange.state === "cancelled" || exchange.origin.generation !== binding.origin.generation) return false;
    if ("receipt" in envelope) return exchange.receipts.some((item) => item.id === envelope.receipt.id && item.disposition.status === "pending");
    if ("deferred" in envelope) return Boolean(view.deferredReplies?.some((item) => item.channelId === envelope.deferred.channelId && item.event.eventId === envelope.deferred.event.eventId && item.disposition.status === "pending"));
    return view.deliveries.some((item) => item.id === envelope.notice.deliveryId && ["unknown", "rejected"].includes(item.state));
  }
  #save(registration: RegisteredCliOwner, settlingOwner = false): void {
    if (this.#closed && !settlingOwner) throw new ConnectorError("host_closed", "The CLI bridge is stopping.", 503);
    saveCliRegistration(this.statePath, registration); this.#registration = registration; this.#stateFailed = false;
  }

  async #admit(owner: CliOwner, signal: AbortSignal): Promise<void> {
    if (this.#connecting) await this.#connecting.catch(() => {});
    while (this.#admitting) await this.#admitting;
    signal.throwIfAborted();
    const previous = this.#registration?.owner;
    if (previous && !sameCliProfile(previous, owner)) throw new ConnectorError("cli_profile_changed", "This manager belongs to a different registered CLI profile. Preserve its original host.", 409);
    const operation = (async () => {
      if (previous && !sameCliProcess(previous.process, owner.process) && !await this.runtime.gone(previous, signal)) throw new ConnectorError("cli_owner_running", "Another execution owner is still alive for this registration.", 409);
      await this.runtime.verify(owner, signal);
      const changed = !previous || !sameCliProcess(previous.process, owner.process);
      if (changed) { this.#rpc?.close(); this.#rpc = undefined; this.#ready.clear(); this.#ownerRevision += 1; }
      const unavailable = !this.#rpc?.connected;
      const rpc = !unavailable ? this.#rpc! : await this.runtime.connect(owner, signal);
      try {
        const remoteControl = await this.#snapshotMode(rpc, this.#ownerRevision, signal);
        signal.throwIfAborted(); this.#save({ version: 1, owner, remoteControl }); this.#rpc = rpc;
        if (unavailable) this.#restored();
      } catch (error) { if (rpc !== this.#rpc) rpc.close(); throw error; }
    })();
    this.#admitting = operation;
    try { await operation; }
    finally { if (this.#admitting === operation) this.#admitting = undefined; }
  }

  #observe(rpc: NativeCliConnection, revision: number): { serial: number } {
    if (this.#modeWatch?.rpc === rpc && this.#modeWatch.revision === revision) return this.#modeWatch;
    const watch = { rpc, revision, serial: 0 }; this.#modeWatch = watch;
    rpc.onNotice = (method, params) => {
      if (this.#closed || this.#modeWatch !== watch || revision !== this.#ownerRevision) return;
      try {
        if (method === "remoteControl/status/changed") {
          watch.serial += 1;
          const remoteControl = mode(params);
          if (rpc === this.#rpc && this.#registration && remoteControl !== this.#registration.remoteControl) this.#save({ ...this.#registration, remoteControl });
        }
        if (method === "thread/status/changed") {
          const input = record(params);
          if (record(input.status).type === "notLoaded" && typeof input.threadId === "string") this.#ready.delete(input.threadId);
        }
      } catch { this.#stateFailed = true; rpc.close(); }
    };
    return watch;
  }
  async #snapshotMode(rpc: NativeCliConnection, revision: number, signal: AbortSignal): Promise<RegisteredCliOwner["remoteControl"]> {
    const watch = this.#observe(rpc, revision);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const serial = watch.serial;
      const snapshot = mode(await rpc.request("remoteControl/status/read", null, signal));
      if (serial === watch.serial) return snapshot;
    }
    throw new ConnectorError("cli_mode_changing", "The native launch mode is changing; retry after it settles.", 503);
  }

  #connection(signal: AbortSignal): Promise<NativeCliConnection> {
    if (this.#rpc?.connected) return Promise.resolve(this.#rpc);
    if (this.#connecting) return this.#connecting;
    if (!this.#registration) return Promise.reject(new ConnectorError("cli_not_admitted", "Use Seeker pending from the registered native CLI manager first.", 503));
    this.#ready.clear(); this.#rpc?.close(); this.#rpc = undefined;
    const operation = (async () => {
      if (this.#admitting) await this.#admitting;
      if (this.#rpc?.connected) return this.#rpc;
      const registration = this.#registration!;
      let owner = registration.owner;
      if (await this.runtime.gone(owner, signal)) {
        signal.throwIfAborted(); owner = await this.runtime.restart(registration, signal);
        this.#ownerRevision += 1; this.#save({ ...registration, owner }, true);
      } else await this.runtime.verify(owner, signal);
      signal.throwIfAborted();
      const rpc = await this.runtime.connect(owner, signal);
      try {
        if (await this.#snapshotMode(rpc, this.#ownerRevision, signal) !== registration.remoteControl) throw new ConnectorError("cli_mode_changed", "The native CLI launch mode changed during recovery.", 503);
        signal.throwIfAborted(); this.#rpc = rpc; return rpc;
      } catch (error) { rpc.close(); throw error; }
    })().finally(() => { if (this.#connecting === operation) this.#connecting = undefined; });
    this.#connecting = operation; return operation;
  }

  #prepare(binding: ManagerBinding): void {
    const threadId = binding.origin.managerId, key = epoch(binding);
    if (!this.#registration || this.#closed || this.#preparing.has(key) || this.#preparing.size >= 32 || Date.now() < this.#nextPreparation) return;
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(12_000)]);
    const operation = (async () => {
      const rpc = await this.#connection(signal), revision = this.#ownerRevision;
      if (!this.#bindingCurrent(binding)) return;
      const result = record(await rpc.request("thread/resume", { threadId, excludeTurns: true }, signal, 8_000));
      if (record(result.thread).id !== threadId) throw new ConnectorError("cli_wrong_thread", "CLI resumed a different task.", 503);
      signal.throwIfAborted();
      if (!this.#bindingCurrent(binding) || revision !== this.#ownerRevision || rpc !== this.#rpc) return;
      this.#ready.set(threadId, `${epoch(binding)}:${revision}`);
      // Let the core commit the known-unaccepted attempt before reopening any
      // exhausted retries. Background preparation never sends a notification.
      if (this.#ready.size > 512) this.#ready.delete(this.#ready.keys().next().value!);
      this.#restored();
    })().catch(() => { this.#nextPreparation = Date.now() + 3_000; }).finally(() => this.#preparing.delete(key));
    this.#preparing.set(key, operation);
  }

  async #send(binding: ManagerBinding, envelope: HostEnvelope, signal: AbortSignal): Promise<DeliveryResult> {
    const rpc = this.#rpc!, registration = this.#registration!, revision = this.#ownerRevision;
    const deadline = AbortSignal.any([signal, this.#lifetime.signal, AbortSignal.timeout(4_000)]);
    let requested = false;
    try {
      if (await this.runtime.gone(registration.owner, deadline)) { rpc.close(); this.#ready.clear(); return retry("cli_offline"); }
      if (deadline.aborted || revision !== this.#ownerRevision || rpc !== this.#rpc || !this.#current(binding, envelope)) return retry("cli_delivery_cancelled");
      requested = true;
      const result = record(await rpc.request("turn/start", { threadId: binding.origin.managerId, input: [{ type: "text", text: nativeWakeup({ attemptId: randomUUID(), binding, envelope }) }] }, deadline, 2_500));
      const turnId = identifier(record(result.turn).id);
      return { status: "accepted", reference: `cli:${binding.origin.managerId}:${turnId}` };
    } catch (error) {
      if (error instanceof NativeRpcError) {
        if (!error.written) return retry(error.code);
        if (error.nativeCode === -32600 && /^thread not found:/i.test(error.nativeMessage ?? "")) { this.#ready.delete(binding.origin.managerId); return retry("cli_task_unloaded"); }
        return { status: "unknown", code: "cli_input_uncertain" };
      }
      // Before request() only OS inspection can fail. A malformed successful
      // response occurs after a write and must retain uncertainty.
      return requested ? { status: "unknown", code: "cli_response_unrecognized" } : retry("cli_unavailable");
    }
  }
  #restored(): void {
    clearTimeout(this.#readyTimer);
    this.#readyTimer = setTimeout(() => { if (!this.#closed) this.core.resumeHost(this.id); }, 0);
    this.#readyTimer.unref();
  }
}
function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
