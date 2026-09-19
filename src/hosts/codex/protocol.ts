import type { DeliveryResult, HostEnvelope, ManagerBinding } from "../../contracts.ts";
import { SeekerError } from "../../core/validation.ts";

export const codexRoute = "/api/hosts/codex";
export const connectorProtocol = 1;
export const maxWireBytes = 1_048_576;

/** These fields come from the host's MCP request metadata, never tool arguments. */
export interface NativeInvocation {
  threadId: string;
  turnId: string;
  callId: string;
}

export interface NativeDelivery {
  attemptId: string;
  binding: ManagerBinding;
  envelope: HostEnvelope;
}

export class ConnectorError extends SeekerError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status);
    this.name = "ConnectorError";
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("invalid_input", "Expected an object.");
  return value as Record<string, unknown>;
}

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) throw new ConnectorError("invalid_identity", "A stable host identifier is required.");
  return value;
}

export function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new ConnectorError("unexpected_argument", "This operation does not accept caller identity, role, or extra arguments.");
}

export function invocationFromMetadata(value: unknown): NativeInvocation {
  const metadata = record(value);
  let raw = metadata["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { throw new ConnectorError("missing_origin", "Codex did not supply valid invocation metadata.", 403); }
  }
  const turn = record(raw);
  const origin = { threadId: identifier(turn.thread_id), turnId: identifier(turn.turn_id), callId: identifier(metadata.callId) };
  if (metadata.threadId !== undefined && metadata.threadId !== origin.threadId) throw new ConnectorError("origin_mismatch", "Codex invocation identities disagree.", 403);
  return origin;
}

export function parseInvocation(value: unknown): NativeInvocation {
  const input = record(value);
  onlyKeys(input, ["threadId", "turnId", "callId"]);
  return { threadId: identifier(input.threadId), turnId: identifier(input.turnId), callId: identifier(input.callId) };
}

export function parseDeliveryResult(value: unknown): DeliveryResult {
  const result = record(value);
  if (result.status === "accepted") return { status: "accepted", reference: identifier(result.reference) };
  if (result.status === "retry") {
    if (!Number.isSafeInteger(result.retryAfterMs) || (result.retryAfterMs as number) < 100 || (result.retryAfterMs as number) > 60_000) throw new ConnectorError("invalid_result", "Invalid retry delay.");
    return { status: "retry", code: identifier(result.code), retryAfterMs: result.retryAfterMs as number };
  }
  if (result.status === "rejected" || result.status === "unknown") return { status: result.status, code: identifier(result.code) };
  throw new ConnectorError("invalid_result", "Invalid native delivery result.");
}

export function nativeWakeup(delivery: NativeDelivery): string {
  const { envelope } = delivery;
  if ("notice" in envelope) return [
    "Seeker service notice: delivery to the configured owner channel needs attention.",
    `Request: ${envelope.exchangeId}; channel delivery: ${envelope.notice.deliveryId}; state: ${envelope.notice.state}.`,
    "This is an operational status, not a human reply, approval or evidence that the owner received the request.",
    `Use Seeker get with ${JSON.stringify({ requestId: envelope.exchangeId, collection: "deliveries", itemId: envelope.notice.deliveryId })} to inspect the current delivery state.`,
    "If the decision still needs the owner, use this task's supported native attention path and explain that external delivery is unavailable or uncertain. Continue independent authorized work.",
    "Do not blindly resend uncertain input, poll repeatedly, or post status back through the failing channel. Do not acknowledge a service notice as an owner receipt or resolve the decision from it.",
  ].join("\n");
  if ("deferred" in envelope) return [
    "Seeker retained owner input that requires reconciliation.",
    `Request: ${envelope.exchangeId}; source channel: ${envelope.deferred.channelId}; event: ${envelope.deferred.event.eventId}; original revision: ${envelope.deferred.revision}.`,
    `Use Seeker get with ${JSON.stringify({ requestId: envelope.exchangeId, collection: "deferred", itemId: envelope.deferred.event.eventId, channelId: envelope.deferred.channelId })} to read the complete saved input, its source, conditions and original scope.`,
    "This notice is not an accepted approval or a new execution permission.",
    "Reconcile the actual input with the current exchange. Use update with type reconcile-input, the source channel/event IDs and current version only after incorporating it; native invocation evidence is attached automatically.",
  ].join("\n");
  return [
    "Seeker has recorded a reply from your configured owner.",
    `Request: ${envelope.exchangeId}; receipt: ${envelope.receipt.id}; revision: ${envelope.receipt.revision}; kind: ${envelope.receipt.kind}.`,
    `Use Seeker get with ${JSON.stringify({ requestId: envelope.exchangeId, collection: "receipts", itemId: envelope.receipt.id })} to read the complete authenticated reply and scope before acting. This notification itself is not an approval.`,
    "A context question keeps the decision open: respond with a context update in the same exchange. Preserve the owner's conditions and chronology.",
    "Acknowledge this receipt as received after reading it, and handled only when you have incorporated it. Handling a natural-language answer does not close the exchange: set resolvesExchange only when the owner's actual answer resolves the decision. A request for context keeps it open.",
    "Use the current exchange version; reconcile any intervening revision or correction.",
    "Seeker replies do not change native execution permissions or grant unrelated authority.",
  ].join("\n");
}

export function envelopeReference(envelope: HostEnvelope): string {
  if ("receipt" in envelope) return `receipt:${envelope.receipt.id}`;
  if ("deferred" in envelope) return `deferred:${envelope.deferred.channelId}:${envelope.deferred.event.eventId}`;
  return `notice:${envelope.notice.deliveryId}`;
}
