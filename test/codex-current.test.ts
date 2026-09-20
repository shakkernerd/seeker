import { afterEach, expect, test } from "bun:test";
import type { DeferredEnvelope, DeliveryNoticeEnvelope, HostEnvelope, InboundReply, ReceiptEnvelope } from "../src/contracts.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { limits } from "../src/core/validation.ts";
import { hostEnvelopeCurrent } from "../src/hosts/codex-common/current.ts";
import { fixtureBinding, fixtureDecision } from "../src/local/fixture.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";

const stores: SqliteExchangeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new SqliteExchangeStore(":memory:"); stores.push(store);
  const core = new SeekerCore(store, () => 1_000);
  core.bind(fixtureBinding);
  const manager = core.manager(fixtureBinding.origin);
  const created = manager.submit({ requestId: "request", decision: fixtureDecision });
  const view = () => store.get(created.exchange.id)!;
  const receive = (eventId: string, overrides: Partial<InboundReply> = {}) => core.channel("local").receive([{
    eventId, actorId: "owner", conversationId: "inbox", sourceRef: `message:${eventId}`,
    replyHandle: created.current.replyHandle, kind: "question", text: "Why this option?", ...overrides,
  }])[0]!;
  const receiptEnvelope = (receiptId: string): ReceiptEnvelope => {
    const saved = view(), receipt = saved.exchange.receipts.find((item) => item.id === receiptId)!;
    const delivery = saved.deliveries.findLast((item) => item.receiptId === receipt.id)!;
    return { deliveryId: delivery.id, exchangeId: saved.exchange.id, revision: saved.exchange.revisions[receipt.revision - 1]!, receipt, requiresReconciliation: saved.exchange.state === "reconcile" };
  };
  const current = (envelope: HostEnvelope) => hostEnvelopeCurrent(core, fixtureBinding, envelope);
  const cancel = () => manager.update({ type: "cancel", requestId: created.exchange.id, expectedVersion: view().exchange.version, reason: "No longer needed." });
  return { store, core, manager, view, receive, receiptEnvelope, current, cancel };
}

test("delivery identity and owner transfer fence a prepared receipt", () => {
  const f = fixture(), receiptId = f.receive("reply").receiptId!, envelope = f.receiptEnvelope(receiptId);
  expect(f.current(envelope)).toBe(true);
  expect(hostEnvelopeCurrent(f.core, { ...fixtureBinding, origin: { ...fixtureBinding.origin, turnId: "new-turn", callId: "new-call" } }, envelope)).toBe(true);
  expect(f.current({ ...envelope, deliveryId: f.view().deliveries.find((item) => item.lane === "channel")!.id })).toBe(false);
  const other = f.receiptEnvelope(f.receive("other-reply").receiptId!);
  expect(f.current({ ...envelope, deliveryId: other.deliveryId })).toBe(false);
  expect(f.current({ ...envelope, exchangeId: "missing-request" })).toBe(false);
  expect(f.current({ ...envelope, revision: { ...envelope.revision, replyHandle: "wrong-handle" } })).toBe(false);
  expect(f.current({ ...envelope, notice: { deliveryId: "different-delivery", state: "unknown", code: "io_timeout" } })).toBe(false);

  const successor = { ...fixtureBinding, origin: { ...fixtureBinding.origin, generation: 2 } };
  f.store.transfer(fixtureBinding.id, 1, successor.origin);
  expect(f.current(envelope)).toBe(false);
  expect(hostEnvelopeCurrent(f.core, successor, envelope)).toBe(false);
  expect(hostEnvelopeCurrent(f.core, successor, f.receiptEnvelope(receiptId))).toBe(true);
});

test("manager acknowledgement and cancellation invalidate an unretired prepared receipt", () => {
  const f = fixture(), envelope = f.receiptEnvelope(f.receive("reply").receiptId!);
  expect(f.current(envelope)).toBe(true);
  f.manager.update({ type: "acknowledge", requestId: "request", receiptId: envelope.receipt.id, status: "received", evidenceRef: "native:read", expectedVersion: f.view().exchange.version });
  expect(f.view().deliveries.find((item) => item.id === envelope.deliveryId)!.state).toBe("queued");
  expect(f.current(envelope)).toBe(false);
  const later = f.receiptEnvelope(f.receive("later-reply").receiptId!);
  expect(f.current(later)).toBe(true);
  f.cancel();
  expect(f.current(later)).toBe(false);
});

test("a later correction or stop reopens cancelled work for genuine reconciliation", () => {
  const f = fixture(); f.cancel();
  for (const kind of ["correction", "stop"] as const) {
    expect(f.view().exchange.state).toBe("cancelled");
    const envelope = f.receiptEnvelope(f.receive(kind, { kind, text: `Owner ${kind}.` }).receiptId!);
    expect(f.view().exchange.cancellation).toBeDefined();
    expect(f.view().exchange.state).toBe("reconcile");
    expect(f.current(envelope)).toBe(true);
    f.manager.update({ type: "acknowledge", requestId: "request", receiptId: envelope.receipt.id, status: "handled", evidenceRef: `native:${kind}`, expectedVersion: f.view().exchange.version });
    expect(f.current(envelope)).toBe(false);
  }
});

test("deferred input after cancellation stays eligible only until its exact event is reconciled", () => {
  const f = fixture();
  for (let index = 0; index < limits.receipts; index += 1) f.receive(`question-${index}`);
  f.cancel();
  expect(f.receive("late-stop", { kind: "stop", text: "Stop the prior work." }).status).toBe("deferred");
  const saved = f.view(), deferred = saved.deferredReplies!.find((item) => item.event.eventId === "late-stop")!;
  const delivery = saved.deliveries.find((item) => item.deferredEventId === deferred.event.eventId)!;
  const envelope: DeferredEnvelope = { deliveryId: delivery.id, exchangeId: saved.exchange.id, revision: saved.exchange.revisions[deferred.revision - 1]!, deferred, requiresReconciliation: true };
  expect(saved.exchange.cancellation).toBeDefined();
  expect(saved.exchange.state).toBe("reconcile");
  expect(f.current(envelope)).toBe(true);
  expect(f.current({ ...envelope, deferred: { ...deferred, channelId: "other-channel" } })).toBe(false);
  f.manager.update({ type: "reconcile-input", requestId: "request", expectedVersion: saved.exchange.version, channelId: deferred.channelId, eventId: deferred.event.eventId, evidenceRef: "native:stop-read" });
  expect(f.current(envelope)).toBe(false);
});

test("only known-undelivered work survives the preparation retry budget", () => {
  const f = fixture(), envelope = f.receiptEnvelope(f.receive("reply").receiptId!);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const delivery = f.store.claimDeliveries(4, 1_000 + attempt * 1_000).find((item) => item.id === envelope.deliveryId)!;
    expect(f.current(envelope)).toBe(true);
    f.store.completeDelivery(delivery.id, delivery.attemptId!, { status: "retry", retryAfterMs: 1_000, code: "preparing" }, 1_000 + attempt * 1_000);
  }
  expect(f.view().deliveries.find((item) => item.id === envelope.deliveryId)).toMatchObject({ state: "rejected", code: "retry_exhausted" });
  expect(f.current(envelope)).toBe(true);
  expect(f.core.resumeHost(fixtureBinding.origin.hostId)).toBe(1);
  const delivery = f.store.claimDeliveries(4, 6_000).find((item) => item.id === envelope.deliveryId)!;
  f.store.completeDelivery(delivery.id, delivery.attemptId!, { status: "unknown", code: "io_timeout" }, 6_000);
  expect(f.current(envelope)).toBe(false);
  f.store.completeDelivery(delivery.id, delivery.attemptId!, { status: "accepted", reference: "native:late-acceptance" }, 6_001);
  expect(f.current(envelope)).toBe(false);
});

test("a prepared channel notice retires when its original failure no longer needs attention", () => {
  for (const change of ["revision", "answer", "cancellation", "late acceptance"] as const) {
    const f = fixture(), failed = f.store.claimDeliveries(4, 1_000)[0]!;
    f.store.completeDelivery(failed.id, failed.attemptId!, { status: "unknown", code: "io_timeout" }, 1_000);
    const delivery = f.store.claimDeliveries(4, 1_000)[0]!;
    const envelope: DeliveryNoticeEnvelope = { deliveryId: delivery.id, exchangeId: "request", revision: f.view().exchange.revisions[0]!, notice: { deliveryId: failed.id, state: "unknown", code: "io_timeout" }, requiresReconciliation: true };
    expect(f.current(envelope)).toBe(true);
    if (change === "revision") f.manager.update({ type: "revise", requestId: "request", expectedVersion: f.view().exchange.version, decision: { ...fixtureDecision, target: "A changed destination" } });
    else if (change === "answer") f.receive("approved", { kind: "approve", optionId: "local" });
    else if (change === "cancellation") {
      f.cancel(); f.receive("late-stop", { kind: "stop" });
      expect(f.view().exchange.state).toBe("reconcile");
    } else f.store.completeDelivery(failed.id, failed.attemptId!, { status: "accepted", reference: "channel:late-acceptance" }, 1_001);
    expect(f.view().deliveries.find((item) => item.id === delivery.id)!.state).toBe("sending");
    expect(f.current(envelope)).toBe(false);
  }
});
