import { randomUUID } from "node:crypto";
import type { DeliveryResult, NativeEnvelope, NativeReturnTarget } from "../../contracts.ts";
import type { SeekerCore } from "../../core/seeker.ts";
import { sameOwner } from "../../core/validation.ts";
import { hostEnvelopeCurrent } from "../codex-common/current.ts";
import type { NativeSender } from "./native-bridge.ts";
import { nativeEvidence } from "./native.ts";
import { envelopeIdentity, envelopeReference, nativeWakeup, type NativeInvocation } from "./protocol.ts";

const retry = (code: string): DeliveryResult => ({ status: "retry", retryAfterMs: 1_000, code });
const epoch = (binding: NativeReturnTarget) => [binding.id, binding.origin.hostId, binding.origin.managerId, binding.origin.assignmentId, binding.origin.generation];

/**
 * Desktop delivery: one stamped native tool call per attempt through the
 * connector. The saved result, the target and the exact-once rules stay with
 * the store; a newer owner turn changes nothing here, the host delivers to an
 * idle task as a new turn and steers an active one.
 */
export class DesktopNativeDelivery {
  readonly #finished = new Map<string, { key: string; result: DeliveryResult }>();
  readonly #attempts = new Map<string, { key: string; result: Promise<DeliveryResult> }>();
  #closed = false;

  constructor(private readonly core: SeekerCore, private readonly send: NativeSender, private readonly lastInvocation: (threadId: string) => NativeInvocation | undefined = () => undefined) {}


  deliver(binding: NativeReturnTarget, envelope: NativeEnvelope, signal: AbortSignal): Promise<DeliveryResult> {
    if (this.#closed || signal.aborted) return Promise.resolve(retry("desktop_unavailable"));
    if (!("event" in envelope)) {
      const current = this.core.managerBinding(binding.origin.hostId, binding.origin.managerId);
      if (!current || current.id !== binding.id || !sameOwner(current.origin, binding.origin)) return Promise.resolve({ status: "rejected", code: "owner_changed" });
    }
    const prompt = nativeWakeup({ attemptId: envelope.deliveryId, binding, envelope });
    const key = JSON.stringify([epoch(binding), envelope.deliveryId, envelopeIdentity(envelope), envelopeReference(envelope), prompt]);
    const finished = this.#finished.get(envelope.deliveryId);
    if (finished) return Promise.resolve(finished.key === key ? finished.result : { status: "rejected", code: "delivery_identity_changed" });
    const attempt = this.#attempts.get(envelope.deliveryId);
    if (attempt) return attempt.key === key ? attempt.result : Promise.resolve({ status: "rejected", code: "delivery_identity_changed" });
    if (!hostEnvelopeCurrent(this.core, binding, envelope)) return Promise.resolve({ status: "rejected", code: "owner_or_exchange_changed" });
    const result = this.#send(binding, envelope, prompt, signal).then((outcome) => {
      if (outcome.status !== "retry") {
        this.#finished.set(envelope.deliveryId, { key, result: outcome });
        if (this.#finished.size > 512) this.#finished.delete(this.#finished.keys().next().value!);
      }
      return outcome;
    }).finally(() => this.#attempts.delete(envelope.deliveryId));
    this.#attempts.set(envelope.deliveryId, { key, result });
    return result;
  }

  /** Genuine connector re-admission is a real recovery event, not a model polling loop. */
  restored(): void {
    if (this.#closed) return;
    this.core.resumeHost("codex-desktop");
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#attempts.values()].map((attempt) => attempt.result));
    this.#finished.clear();
  }

  #exchangeTurn(exchangeId: string): string | undefined {
    try { return this.core.store.get(exchangeId)?.exchange.origin.turnId; } catch { return undefined; }
  }

  async #send(binding: NativeReturnTarget, envelope: NativeEnvelope, prompt: string, signal: AbortSignal): Promise<DeliveryResult> {
    const threadId = binding.origin.managerId;
    // The stamp names a turn the receiving task has: the armed turn for an event, else the
    // task's latest admitted invocation. The call identity is fresh for every attempt.
    const turnId = binding.origin.turnId ?? ("event" in envelope ? undefined : this.#exchangeTurn(envelope.exchangeId)) ?? this.lastInvocation(threadId)?.turnId;
    if (!turnId) return retry("desktop_owner_turn_unknown");
    const origin: NativeInvocation = { threadId, turnId, callId: randomUUID() };
    let outcome;
    try { outcome = await this.send(origin, { threadId, prompt }, signal, () => !this.#closed && hostEnvelopeCurrent(this.core, binding, envelope)); }
    catch (error) {
      const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "desktop_connector_unavailable";
      return code === "delivery_not_current" ? { status: "rejected", code: "owner_or_exchange_changed" } : retry(code);
    }
    if (outcome.status === "accepted") return { status: "accepted", reference: nativeEvidence(origin) };
    if (outcome.status === "refused") return retry(outcome.code);
    return { status: "unknown", code: outcome.code };
  }
}
