import { randomBytes, randomUUID } from "node:crypto";
import type { Delivery, Exchange, InboundReply, ManagerBinding, ManagerCommand, Receipt, Revision } from "../contracts.ts";
import { decision, fail, id, integer, limits, text } from "./validation.ts";

export interface Change {
  exchange: Exchange;
  deliveries: Delivery[];
  changed: boolean;
  retireChannel?: boolean;
}

export function revision(snapshot: Revision["decision"], number: number, now: number): Revision {
  return { number, decision: snapshot, replyHandle: `r_${randomBytes(18).toString("base64url")}`, createdAt: now };
}

export function delivery(exchange: Exchange, lane: Delivery["lane"], now: number, extra: Partial<Delivery> = {}): Delivery {
  return { id: randomUUID(), exchangeId: exchange.id, revision: exchange.revision, lane, state: "queued", attempts: 0, nextAt: now, ...extra };
}

export function create(binding: ManagerBinding, requestId: string, snapshot: Revision["decision"], now: number): Change {
  const exchange: Exchange = {
    id: id(requestId, "Request"), bindingId: binding.id, managerLabel: binding.label,
    origin: binding.origin, recipient: binding.recipient, version: 1, revision: 1, state: "waiting",
    revisions: [revision(snapshot, 1, now)], context: [], receipts: [], createdAt: now, updatedAt: now,
  };
  return { exchange, deliveries: [delivery(exchange, "channel", now)], changed: true };
}

export function current(exchange: Exchange): Revision {
  return exchange.revisions[exchange.revision - 1]!;
}

function isAnswer(receipt: Receipt, exchange: Exchange): boolean {
  return ["approve", "decline", "answer"].includes(receipt.kind) ||
    (receipt.kind === "acknowledge" && current(exchange).decision.kind === "attention");
}

export function refreshState(exchange: Exchange): void {
  if (exchange.receipts.some((item) => item.classification === "correction" && item.disposition.status !== "handled")) {
    exchange.state = "reconcile";
    return;
  }
  if (exchange.cancellation) {
    exchange.state = "cancelled";
    return;
  }
  const receipts = exchange.receipts.filter((item) => item.revision === exchange.revision);
  const answered = receipts.some((item) => isAnswer(item, exchange));
  exchange.state = answered ? (receipts.every((item) => item.disposition.status === "handled") ? "handled" : "answered") : "waiting";
}

export function mutate(exchange: Exchange, command: Exclude<ManagerCommand, { type: "submit" }>, now: number): Change {
  const result: Change = { exchange, deliveries: [], changed: false };
  integer(command.expectedVersion, "Expected version");
  if (command.type === "context") {
    id(command.messageId, "Context message");
    text(command.text, "Context message");
    const existing = exchange.context.find((item) => item.id === command.messageId);
    if (existing) {
      if (existing.text !== command.text) fail("idempotency_conflict", "Context identity was reused for different text.", 409);
      return result;
    }
  }
  if (command.type === "acknowledge") {
    const existing = exchange.receipts.find((item) => item.id === command.receiptId);
    if (!existing) fail("not_found", "Receipt not found.", 404);
    if (!["received", "handled", "unknown"].includes(command.status)) fail("invalid_input", "Unknown manager disposition.");
    text(command.evidenceRef, "Manager evidence reference", 500);
    if (command.note !== undefined) text(command.note, "Manager note", 2_000, true);
    if (existing.disposition.status === command.status && existing.disposition.generation === exchange.origin.generation &&
      existing.disposition.evidenceRef === command.evidenceRef && existing.disposition.note === command.note) return result;
    if (existing.disposition.status === "handled" && command.status !== "handled") fail("already_handled", "A handled receipt cannot be downgraded; record a correction separately.", 409);
  }
  if (exchange.version !== command.expectedVersion) fail("version_conflict", "The exchange changed. Read its current state before updating.", 409);

  switch (command.type) {
    case "revise": {
      if (exchange.cancellation) fail("cancelled", "A cancelled request cannot be revised.", 409);
      const snapshot = decision(command.decision);
      if (JSON.stringify(snapshot) === JSON.stringify(current(exchange).decision)) return result;
      if (exchange.revisions.length >= limits.revisions) fail("capacity", "Revision capacity reached; retained decisions were not deleted.", 503);
      exchange.revision += 1;
      exchange.revisions.push(revision(snapshot, exchange.revision, now));
      result.retireChannel = true;
      result.deliveries.push(delivery(exchange, "channel", now));
      break;
    }
    case "context": {
      if (exchange.cancellation) fail("cancelled", "A cancelled request cannot receive new manager context.", 409);
      if (exchange.context.length >= limits.context) fail("capacity", "Context capacity reached; earlier context was retained.", 503);
      exchange.context.push({ id: command.messageId, sequence: exchange.version + 1, revision: exchange.revision, text: command.text, createdAt: now });
      result.deliveries.push(delivery(exchange, "channel", now, { contextId: command.messageId }));
      break;
    }
    case "cancel":
      text(command.reason, "Cancellation reason", 2_000);
      if (exchange.cancellation) return result;
      exchange.cancellation = { reason: command.reason, at: now };
      result.retireChannel = true;
      break;
    case "acknowledge": {
      const receipt = exchange.receipts.find((item) => item.id === command.receiptId)!;
      if (receipt.disposition.status !== "pending") (receipt.dispositionHistory ??= []).push(receipt.disposition);
      receipt.disposition = {
        status: command.status, generation: exchange.origin.generation, evidenceRef: command.evidenceRef,
        ...(command.note === undefined ? {} : { note: command.note }), updatedAt: now,
      };
      break;
    }
  }
  refreshState(exchange);
  exchange.version += 1;
  exchange.updatedAt = now;
  result.changed = true;
  return result;
}

export function incorporate(
  exchange: Exchange, number: number, input: InboundReply, channelId: string,
  verification: Receipt["source"]["verification"], now: number,
): { change: Change; receipt: Receipt; duplicate: boolean } {
  const snapshot = exchange.revisions[number - 1];
  if (!snapshot) fail("unknown_revision", "Unknown decision revision.", 409);
  const correction = input.kind === "correction" || input.kind === "stop";
  if (number !== exchange.revision && !correction) fail("stale_revision", "This decision changed. Read the current question before answering.", 409);
  if (exchange.cancellation && !correction) fail("cancelled", "This request was cancelled. A correction or stop can still be recorded.", 409);
  const option = input.optionId === undefined ? undefined : snapshot.decision.options.find((item) => item.id === input.optionId);
  if (input.optionId !== undefined && (!option || option.kind !== input.kind)) fail("invalid_choice", "The choice does not match this decision.", 409);
  if (["approve", "decline"].includes(input.kind) && !option) fail("invalid_choice", "Use a declared choice or send a natural reply for the manager to interpret.", 409);
  const replyText = input.text || option?.meaning || "Acknowledged";
  const conditions = input.conditions ?? "";
  const earlierAnswer = exchange.receipts.findLast((item) => item.revision === number && (isAnswer(item, exchange) || item.classification === "correction"));
  // Coalesce only a repeated declared choice, and only against the latest decision.
  // Source-event deduplication is separate; natural conversation and A/B/A changes survive.
  const duplicate = !correction && option && earlierAnswer && earlierAnswer.kind === input.kind &&
    earlierAnswer.optionId === input.optionId && earlierAnswer.text === replyText && earlierAnswer.conditions === conditions;
  if (duplicate) return { change: { exchange, deliveries: [], changed: false }, receipt: earlierAnswer, duplicate: true };
  if (exchange.receipts.length >= limits.receipts) fail("capacity", "Reply capacity reached; this reply was not acknowledged or discarded. Use the original manager conversation.", 503);
  const receipt: Receipt = {
    id: randomUUID(), sequence: exchange.version + 1, revision: number, kind: input.kind, text: replyText, conditions,
    ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
    classification: correction || (earlierAnswer && ["approve", "decline", "answer"].includes(input.kind)) ? "correction" : "response",
    source: {
      channelId, actorId: input.actorId, conversationId: input.conversationId, eventId: input.eventId,
      reference: input.sourceRef, ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      recordedAt: now, verification,
    },
    disposition: { status: "pending" },
  };
  exchange.receipts.push(receipt);
  refreshState(exchange);
  exchange.version += 1;
  exchange.updatedAt = now;
  return {
    change: { exchange, deliveries: [delivery(exchange, "host", now, { revision: number, receiptId: receipt.id })], changed: true },
    receipt, duplicate: false,
  };
}
