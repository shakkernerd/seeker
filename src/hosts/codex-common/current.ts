import type { HostEnvelope, ManagerBinding } from "../../contracts.ts";
import { channelReadiness } from "../../core/attention.ts";
import type { SeekerCore } from "../../core/seeker.ts";
import { sameOwner } from "../../core/validation.ts";

/** Recheck retained delivery authority; the caller must also fence its live attempt. */
export function hostEnvelopeCurrent(core: SeekerCore, binding: ManagerBinding, envelope: HostEnvelope): boolean {
  try {
    const current = core.managerBinding(binding.origin.hostId, binding.origin.managerId);
    if (!current || current.id !== binding.id || !sameOwner(current.origin, binding.origin)) return false;
    const view = core.store.get(envelope.exchangeId);
    if (!view) return false;
    const { exchange } = view;
    if (exchange.id !== envelope.exchangeId || exchange.bindingId !== binding.id ||
      !sameOwner(exchange.origin, binding.origin) || exchange.state === "cancelled") return false;

    const delivery = view.deliveries.find((item) => item.id === envelope.deliveryId);
    if (!delivery || delivery.exchangeId !== exchange.id || delivery.lane !== "host" ||
      delivery.revision !== envelope.revision.number ||
      exchange.revisions[delivery.revision - 1]?.replyHandle !== envelope.revision.replyHandle ||
      (delivery.ownerGeneration !== undefined && delivery.ownerGeneration !== binding.origin.generation)) return false;
    // Preparation can outlive the retry budget. Only readiness may reopen that
    // known-undelivered row; accepted or uncertain writes must never be replayed.
    if (!["queued", "retry", "sending"].includes(delivery.state) &&
      !(delivery.state === "rejected" && delivery.code === "retry_exhausted")) return false;

    if ("receipt" in envelope) {
      if ("deferred" in envelope || "notice" in envelope || delivery.noticeOf || delivery.deferredEventId || delivery.receiptId !== envelope.receipt.id) return false;
      const receipt = exchange.receipts.find((item) => item.id === delivery.receiptId);
      return Boolean(receipt && receipt.revision === delivery.revision && receipt.revision === envelope.receipt.revision &&
        receipt.kind === envelope.receipt.kind && receipt.disposition.status === "pending");
    }
    if ("deferred" in envelope) {
      if ("notice" in envelope || delivery.noticeOf || delivery.receiptId || delivery.deferredChannelId !== envelope.deferred.channelId ||
        delivery.deferredEventId !== envelope.deferred.event.eventId || envelope.deferred.exchangeId !== exchange.id ||
        envelope.deferred.revision !== delivery.revision) return false;
      const deferred = view.deferredReplies?.find((item) => item.channelId === delivery.deferredChannelId && item.event.eventId === delivery.deferredEventId);
      return Boolean(deferred && deferred.exchangeId === exchange.id && deferred.revision === delivery.revision && deferred.disposition.status === "pending");
    }
    if (delivery.receiptId || delivery.deferredEventId || delivery.noticeOf !== envelope.notice.deliveryId ||
      delivery.ownerGeneration !== binding.origin.generation) return false;
    const target = view.deliveries.find((item) => item.id === delivery.noticeOf);
    return Boolean(target && target.lane === "channel" && target.exchangeId === exchange.id && target.revision === delivery.revision &&
      ["unknown", "rejected"].includes(target.state) && target.state === envelope.notice.state &&
      channelReadiness(exchange, target) !== "retire");
  } catch {
    // A closed store or ambiguous binding cannot authorize native input.
    return false;
  }
}
