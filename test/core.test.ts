import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundReply, ManagerOrigin } from "../src/contracts.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";
import { fixtureBinding, fixtureDecision } from "../src/local/fixture.ts";

const openStores: SqliteExchangeStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of openStores.splice(0)) { try { store.close(); } catch {} }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(path = ":memory:") {
  const store = new SqliteExchangeStore(path);
  openStores.push(store);
  const core = new SeekerCore(store, () => 1_000);
  core.bind(fixtureBinding);
  const manager = core.manager(fixtureBinding.origin);
  const created = manager.submit({ requestId: "request-1", decision: fixtureDecision });
  const handle = created.current.replyHandle;
  const channel = core.channel("local");
  const event = (eventId: string, overrides: Partial<InboundReply> = {}): InboundReply => ({
    eventId, actorId: "owner", conversationId: "inbox", sourceRef: `message:${eventId}`,
    replyHandle: handle, kind: "approve", optionId: "local", text: "", ...overrides,
  });
  return { store, core, manager, created, handle, channel, event };
}

describe("durable exchange lifecycle", () => {
  test("caller-retained identity survives restart with pending answers and receipt identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "seeker-core-")); directories.push(directory);
    const path = join(directory, "exchanges.sqlite");
    const first = setup(path);
    const receipt = first.channel.receive([first.event("reply-1")])[0]!;
    first.store.close(); openStores.pop();
    const second = setup(path);
    expect(second.store.get("request-1")!.exchange.receipts[0]!.id).toBe(receipt.receiptId!);
    expect(second.manager.listPending().total).toBe(1);
    expect(second.created.exchange.state).toBe("answered");
    expect(second.store.get("request-1")!.deliveries.filter((item) => item.lane === "channel")).toHaveLength(1);
    expect(() => second.manager.submit({ requestId: "request-1", decision: { ...fixtureDecision, target: "different target" } })).toThrow("different decision");
  });

  test("admission uses exact host/manager/assignment/generation, not turn claims", () => {
    const { core, store, manager } = setup();
    const origin: ManagerOrigin = { ...fixtureBinding.origin, turnId: "later-turn", callId: "later-call" };
    expect(core.manager(origin).get("request-1").exchange.id).toBe("request-1");
    for (const forged of [
      { ...origin, managerId: "lead" }, { ...origin, assignmentId: "other-work" },
      { ...origin, generation: 2 }, { ...origin, hostId: "other-host" },
    ]) expect(() => core.manager(forged)).toThrow("not bound");
    store.transfer(fixtureBinding.id, 1, { ...origin, managerId: "successor", generation: 2 });
    expect(() => manager.get("request-1")).toThrow("not bound");
    expect(core.manager({ ...origin, managerId: "successor", generation: 2 }).get("request-1").exchange.revision).toBe(1);
  });

  test("same events and repeated current choices coalesce, but A/B/A and repeated text survive", () => {
    const { channel, store, event } = setup();
    const first = channel.receive([event("a1")])[0]!;
    expect(channel.receive([event("a1")])[0]!.status).toBe("duplicate");
    expect(channel.receive([event("a2")])[0]!.receiptId).toBe(first.receiptId);
    channel.receive([event("b", { kind: "decline", optionId: "skip" })]);
    const lastA = channel.receive([event("a3")])[0]!;
    expect(lastA.status).toBe("recorded");
    expect(lastA.receiptId).not.toBe(first.receiptId);
    for (const key of ["why1", "why2"]) channel.receive([event(key, { kind: "answer", optionId: undefined, text: "Why?" })]);
    const exchange = store.get("request-1")!.exchange;
    expect(exchange.receipts).toHaveLength(5);
    expect(exchange.receipts[2]!.classification).toBe("correction");
    expect(exchange.state).toBe("reconcile");
  });

  test("context preserves authority; changed material decisions retire old choices but retain late stop", () => {
    const { manager, channel, event, handle } = setup();
    let view = manager.update({ type: "context", requestId: "request-1", expectedVersion: 1, messageId: "why", text: "An equivalent implementation explanation." });
    expect(view.current.replyHandle).toBe(handle);
    expect(view.exchange.revision).toBe(1);
    view = manager.update({ type: "revise", requestId: "request-1", expectedVersion: view.exchange.version, decision: { ...fixtureDecision, target: "a different local directory" } });
    expect(view.exchange.revision).toBe(2);
    expect(channel.receive([event("old-choice")])[0]!.code).toBe("stale_revision");
    expect(channel.receive([event("late-stop", { kind: "stop", optionId: undefined, text: "Stop the old request too." })])[0]!.status).toBe("recorded");
    expect(manager.get("request-1").exchange.state).toBe("reconcile");
  });

  test("questions and conditional answers remain distinct and manager acknowledgment is explicit", () => {
    const { manager, channel, event } = setup();
    channel.receive([event("why", { kind: "question", optionId: undefined, text: "Why is it needed?" })]);
    expect(manager.get("request-1").exchange.state).toBe("waiting");
    const recorded = channel.receive([event("conditional", { conditions: "Only after the old data is backed up." })])[0]!;
    let view = manager.get("request-1", { collection: "receipts", itemId: recorded.receiptId! });
    expect(view.items[0]).toMatchObject({ conditions: expect.stringContaining("backed up") });
    expect(view.items[0]).toMatchObject({ disposition: { status: "pending" } });
    view = manager.update({ type: "acknowledge", requestId: "request-1", receiptId: recorded.receiptId!, expectedVersion: view.exchange.version, status: "received", evidenceRef: "native:message-1" });
    expect(view.exchange.state).toBe("answered");
    expect(manager.get("request-1", { collection: "receipts", itemId: recorded.receiptId! }).items[0]).toMatchObject({ disposition: { status: "received" } });
    expect(() => manager.update({ type: "acknowledge", requestId: "request-1", receiptId: recorded.receiptId!, expectedVersion: 1, status: "handled", evidenceRef: "native:message-2" })).toThrow("changed");
  });

  test("wrong actor, wrong conversation and manufactured native channel are rejected", () => {
    const { channel, core, manager, event } = setup();
    expect(channel.receive([event("wrong-user", { actorId: "stranger" })])[0]!.code).toBe("recipient_denied");
    expect(channel.receive([event("wrong-chat", { conversationId: "other-inbox" })])[0]!.code).toBe("recipient_denied");
    expect(() => core.channel("native:fixture")).toThrow("trusted host");
    expect(manager.get("request-1").counts.receipts).toBe(0);
  });

  test("ingress commits receipts, source dedup and progress as one batch", () => {
    const { channel, manager, event } = setup();
    channel.receive([], { cursor: "1", lastReceivedAt: 20, continuity: "continuous" });
    expect(() => channel.receive([event("batch1")], { cursor: "2", lastReceivedAt: 10, continuity: "continuous" })).toThrow("backwards");
    expect(manager.get("request-1").counts.receipts).toBe(0);
    expect(channel.progress()!.cursor).toBe("1");
    expect(channel.receive([event("batch1")], { cursor: "2", lastReceivedAt: 30, continuity: "continuous" })[0]!.status).toBe("recorded");
    expect(channel.progress()!.cursor).toBe("2");
  });

  test("ambiguous bare replies do not choose the newest manager; unique bare replies can correlate", () => {
    const { manager, channel, event, store } = setup();
    manager.submit({ requestId: "request-2", decision: fixtureDecision });
    expect(channel.receive([event("bare1", { replyHandle: undefined, occurredAt: 1_000, kind: "question", optionId: undefined, text: "Which folder?" })])[0]!.code).toBe("ambiguous");
    manager.update({ type: "cancel", requestId: "request-2", expectedVersion: 1, reason: "Redundant sample" });
    const presented = store.claimDeliveries(4, 1_000)[0]!;
    store.completeDelivery(presented.id, presented.attemptId!, { status: "accepted", reference: "local:presented" }, 1_000);
    expect(channel.receive([event("bare2", { replyHandle: undefined, occurredAt: 1_000, kind: "question", optionId: undefined, text: "Which folder?" })])[0]!.exchangeId).toBe("request-1");
  });

  test("native authenticated source can reconcile an exchange without manufacturing provider provenance", () => {
    const { core, manager, event } = setup();
    const result = core.receiveNative(fixtureBinding.origin, "request-1", 1, event("native-answer", { actorId: "native-human", conversationId: "native-task", kind: "answer", optionId: undefined, text: "Keep it local; I answered here." }));
    let view = manager.get("request-1", { collection: "receipts", itemId: result.receiptId! });
    expect(view.items[0]).toMatchObject({ source: { verification: "native" } });
    view = manager.update({ type: "acknowledge", requestId: "request-1", receiptId: result.receiptId!, status: "handled", resolvesExchange: true, expectedVersion: view.exchange.version, evidenceRef: "native:original-message" });
    expect(view.exchange.state).toBe("handled");
    expect(manager.listPending().total).toBe(0);
  });

  test("unknown send survives recovery without automatic retries and retry hints delay definite retries", () => {
    const { store, manager } = setup();
    const first = store.claimDeliveries(4, 1_000)[0]!;
    expect(first.state).toBe("sending");
    expect(store.recoverInterruptedDeliveries(1_000)).toBe(1);
    const notice = store.claimDeliveries(4, 1_000_000);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.noticeOf).toBe(first.id);
    store.completeDelivery(notice[0]!.id, notice[0]!.attemptId!, { status: "accepted", reference: "native:delivery-notice" }, 1_000_000);
    expect(store.get("request-1")!.deliveries[0]!.state).toBe("unknown");
    manager.submit({ requestId: "request-2", decision: fixtureDecision });
    const second = store.claimDeliveries(4, 1_000)[0]!;
    store.completeDelivery(second.id, second.attemptId!, { status: "retry", retryAfterMs: 7_000, code: "rate_limited" }, 1_000);
    expect(store.claimDeliveries(4, 7_999)).toHaveLength(0);
    expect(store.claimDeliveries(4, 8_000)).toHaveLength(1);
  });

  for (const boundary of ["receipt count", "record bytes"]) test(`${boundary} overflow retains the reply and lets an unrelated event and cursor commit`, () => {
    const { core, store, manager, channel, event } = setup();
    const other = manager.submit({ requestId: "healthy-request", decision: fixtureDecision });
    let blockedEvent: InboundReply | undefined;
    for (let index = 0; index <= 128; index += 1) {
      const input = event(`fill-${index}`, { kind: "question", optionId: undefined, text: boundary === "record bytes" ? "x".repeat(8_000) : `Question ${index}?` });
      const result = channel.receive([input])[0]!;
      if (result.status === "deferred") { blockedEvent = input; break; }
    }
    expect(blockedEvent).toBeDefined();
    const overflow = event("important-correction", { kind: "correction", optionId: undefined, text: boundary === "record bytes" ? "Use the amended condition. ".padEnd(8_000, "x") : "Use the amended condition.", conditions: "Do not touch existing data." });
    const results = channel.receive([overflow, event("healthy-answer", { replyHandle: other.current.replyHandle })], { cursor: "batch-complete", lastReceivedAt: 1_000, continuity: "continuous" });
    expect(results.map((item) => item.status)).toEqual(["deferred", "recorded"]);
    expect(channel.progress()!.cursor).toBe("batch-complete");
    const view = store.get("request-1")!;
    expect(view.deferredReplies!.find((item) => item.event.eventId === "important-correction")!.event.conditions).toBe("Do not touch existing data.");
    expect(view.deliveries.some((item) => item.deferredEventId === "important-correction" && item.lane === "host")).toBe(true);
    expect(channel.receive([overflow])[0]!.status).toBe("deferred");
    manager.update({ type: "reconcile-input", requestId: "request-1", expectedVersion: view.exchange.version, channelId: "local", eventId: "important-correction", evidenceRef: "native:reconciliation", note: "Applied the condition to the existing work." });
    expect(core.inbox(fixtureBinding.recipient).find((item) => item.exchange.id === "request-1")!.deferredReplies!.find((item) => item.event.eventId === "important-correction")!.disposition.status).toBe("handled");
    const receipt = store.get("request-1")!.exchange.receipts[0]!;
    manager.update({ type: "acknowledge", requestId: "request-1", expectedVersion: manager.get("request-1").exchange.version, receiptId: receipt.id,
      status: "handled", evidenceRef: "native:capacity-recovery", note: "n".repeat(2_000) });
    expect(store.get("request-1")!.exchange.receipts[0]!.disposition.status).toBe("handled");
    expect(manager.update({ type: "cancel", requestId: "request-1", expectedVersion: manager.get("request-1").exchange.version, reason: "x".repeat(2_000) }).exchange.cancellation).toBeDefined();
  });

  test("reconciliation defers the current prompt and handling the correction releases it", () => {
    const { manager, channel, store, event } = setup();
    const correction = channel.receive([event("correction", { kind: "correction", optionId: undefined, text: "Clarify the destination." })])[0]!;
    let view = manager.get("request-1");
    view = manager.update({ type: "revise", requestId: "request-1", expectedVersion: view.exchange.version, decision: { ...fixtureDecision, target: "the clarified directory" } });
    store.claimDeliveries(4, 1_000);
    expect(store.get("request-1")!.deliveries.find((item) => item.lane === "channel" && item.revision === 2)!.state).toBe("queued");
    manager.update({ type: "acknowledge", requestId: "request-1", expectedVersion: view.exchange.version, receiptId: correction.receiptId!, status: "handled", evidenceRef: "native:correction-clarified" });
    expect(store.claimDeliveries(4, 2_000).some((item) => item.lane === "channel" && item.revision === 2)).toBe(true);
  });

  test("a saved deferred stop invalidates prior approval views and blocks resolution", () => {
    const { manager, channel, event } = setup();
    for (let index = 0; index < 127; index += 1) {
      const receipt = channel.receive([event(`context-${index}`, { kind: "question", optionId: undefined, text: "Context please?" })])[0]!;
      manager.update({ type: "acknowledge", requestId: "request-1", receiptId: receipt.receiptId!, status: "handled", evidenceRef: `native:context-${index}`, expectedVersion: manager.get("request-1").exchange.version });
    }
    const approval = channel.receive([event("approval")])[0]!;
    const beforeStop = manager.get("request-1").exchange.version;
    expect(channel.receive([event("stop-at-capacity", { kind: "stop", optionId: undefined, text: "Stop before doing this." })])[0]!.status).toBe("deferred");
    const afterStop = manager.get("request-1");
    expect(afterStop.exchange.version).toBe(beforeStop + 1);
    expect(afterStop.exchange.state).toBe("reconcile");
    expect(() => manager.update({ type: "acknowledge", requestId: "request-1", receiptId: approval.receiptId!, status: "handled", evidenceRef: "native:old-view", expectedVersion: beforeStop })).toThrow("changed");
    expect(() => manager.update({ type: "acknowledge", requestId: "request-1", receiptId: approval.receiptId!, status: "handled", resolvesExchange: true, evidenceRef: "native:unchecked", expectedVersion: afterStop.exchange.version })).toThrow("later saved input");
    const reconciled = manager.update({ type: "reconcile-input", requestId: "request-1", channelId: "local", eventId: "stop-at-capacity", evidenceRef: "native:stop-understood", expectedVersion: afterStop.exchange.version });
    expect(reconciled.exchange.pendingInputs).toBe(0);
    expect(reconciled.exchange.version).toBe(afterStop.exchange.version + 1);
  });

  test("restored host retries only known-unaccepted work and preserves its delay", () => {
    const { core, store, channel, event } = setup();
    channel.receive([event("reply")]);
    let now = 1_000;
    for (let index = 0; index < 5; index += 1) {
      const attempt = store.claimDeliveries(4, now).find((item) => item.lane === "host")!;
      store.completeDelivery(attempt.id, attempt.attemptId!, { status: "retry", retryAfterMs: 3_000, code: "host_unavailable" }, now);
      now += 3_000;
    }
    expect(core.resumeHost("fixture")).toBe(1);
    expect(store.claimDeliveries(4, now - 1)).toHaveLength(0);
    const resumed = store.claimDeliveries(4, now)[0]!;
    store.completeDelivery(resumed.id, resumed.attemptId!, { status: "unknown", code: "io_timeout" }, now);
    expect(core.resumeHost("fixture")).toBe(0);
  });

  test("late success after timeout and ownership transfer stays attached to the old fenced attempt", () => {
    const { manager, core, store, channel, event } = setup();
    channel.receive([event("reply")]);
    const attempt = store.claimDeliveries(4, 1_000)[0]!;
    store.completeDelivery(attempt.id, attempt.attemptId!, { status: "unknown", code: "io_timeout" }, 1_100);
    store.transfer(fixtureBinding.id, 1, { ...fixtureBinding.origin, managerId: "successor", generation: 2 });
    store.completeDelivery(attempt.id, attempt.attemptId!, { status: "accepted", reference: "old-owner-acceptance" }, 1_200);
    expect(() => manager.get("request-1")).toThrow("not bound");
    const successorView = core.manager({ ...fixtureBinding.origin, managerId: "successor", generation: 2 }).get("request-1");
    const view = store.get(successorView.exchange.id)!;
    expect(view.deliveries.find((item) => item.id === attempt.id)!.state).toBe("unknown");
    expect(view.deliveries.find((item) => item.id === attempt.id)!.code).toBe("owner_transferred");
    expect(view.deliveries.find((item) => item.id === attempt.id)!.reference).toBeUndefined();
    expect(view.exchange.receipts[0]!.disposition.status).toBe("pending");
  });

  test("editing an old bare reply stays with its original exchange after another becomes pending", () => {
    const { manager, channel, event, store } = setup();
    const presented = store.claimDeliveries(4, 1_000)[0]!;
    store.completeDelivery(presented.id, presented.attemptId!, { status: "accepted", reference: "local:presented" }, 1_000);
    const initial = channel.receive([event("original", { replyHandle: undefined, occurredAt: 1_000, kind: "answer", optionId: undefined, text: "Use local." })])[0]!;
    manager.update({ type: "acknowledge", requestId: "request-1", expectedVersion: manager.get("request-1").exchange.version, receiptId: initial.receiptId!, status: "handled", resolvesExchange: true, evidenceRef: "native:original" });
    manager.submit({ requestId: "new-question", decision: fixtureDecision });
    const edited = channel.receive([event("edited", { replyHandle: undefined, replyToRef: "message:original", sourceRef: "message:original", kind: "correction", optionId: undefined, text: "Stop that earlier change." })])[0]!;
    expect(edited.exchangeId).toBe("request-1");
    expect(manager.get("new-question").counts.receipts).toBe(0);
  });

  test("unchanged edits coalesce against the latest original message, while A/B/A edits survive", () => {
    const { store, channel, event } = setup();
    const original = event("original-text", { kind: "answer", optionId: undefined, text: "A", sourceRef: "same-message" });
    channel.receive([original]);
    const edit = (eventId: string, text: string) => event(eventId, { kind: "correction", optionId: undefined, text, sourceRef: "same-message", replyToRef: "same-message", replyHandle: undefined });
    expect(channel.receive([edit("metadata-only", "A")])[0]!.status).toBe("duplicate");
    expect(channel.receive([edit("edit-b", "B")])[0]!.status).toBe("recorded");
    expect(channel.receive([edit("edit-a", "A")])[0]!.status).toBe("recorded");
    expect(channel.receive([edit("more-metadata", "A")])[0]!.status).toBe("duplicate");
    expect(store.get("request-1")!.exchange.receipts.map((item) => item.text)).toEqual(["A", "B", "A"]);
  });

  test("buffered bare replies cannot acquire a future question or material revision", () => {
    const { core, store, manager, channel, event } = setup();
    manager.update({ type: "cancel", requestId: "request-1", expectedVersion: 1, reason: "Old question ended" });
    const later = new SeekerCore(store, () => 5_500).manager(fixtureBinding.origin);
    const replacement = later.submit({ requestId: "later-question", decision: fixtureDecision });
    const bare = { replyHandle: undefined, kind: "answer" as const, optionId: undefined, text: "Yes" };
    expect(channel.receive([event("buffered", { ...bare, occurredAt: 1_000, occurredAtPrecisionMs: 1_000 })])[0]!.code).toBe("predates_current_revision");
    expect(channel.receive([event("rounded", { ...bare, occurredAt: 5_000, occurredAtPrecisionMs: 1_000 })])[0]!.code).toBe("uncertain_chronology");
    expect(channel.receive([event("untimed", bare)])[0]!.code).toBe("source_time_required");
    expect(later.get("later-question").counts.receipts).toBe(0);
    expect(channel.receive([event("explicit-same-second", { ...bare, replyHandle: replacement.current.replyHandle, occurredAt: 5_000, occurredAtPrecisionMs: 1_000 })])[0]!.status).toBe("recorded");
    const revised = new SeekerCore(store, () => 9_000).manager(fixtureBinding.origin);
    revised.update({ type: "revise", requestId: "later-question", expectedVersion: revised.get("later-question").exchange.version, decision: { ...fixtureDecision, target: "new material scope" } });
    expect(core.channel("local").receive([event("prior-revision", { ...bare, occurredAt: 7_000, occurredAtPrecisionMs: 1_000 })])[0]!.code).toBe("predates_current_revision");
  });

  test("bare reply context requires an accepted question presented before the source-time interval", () => {
    const { channel, store, event } = setup();
    const bare = { replyHandle: undefined, kind: "answer" as const, optionId: undefined, text: "Yes", occurredAt: 2_000 };
    expect(channel.receive([event("before-send", bare)])[0]!.code).toBe("question_not_presented");
    const attempt = store.claimDeliveries(4, 3_000)[0]!;
    store.completeDelivery(attempt.id, attempt.attemptId!, { status: "unknown", code: "io_timeout" }, 3_100);
    expect(channel.receive([event("unknown-send", { ...bare, occurredAt: 4_000 })])[0]!.code).toBe("question_not_presented");
    store.completeDelivery(attempt.id, attempt.attemptId!, { status: "accepted", reference: "late-provider-result" }, 5_500);
    expect(channel.receive([event("buffered-before-presentation", { ...bare, occurredAt: 4_000 })])[0]!.code).toBe("predates_presentation");
    expect(channel.receive([event("presentation-overlap", { ...bare, occurredAt: 5_000, occurredAtPrecisionMs: 1_000 })])[0]!.code).toBe("uncertain_chronology");
    expect(channel.receive([event("presented-context", { ...bare, occurredAt: 6_000, occurredAtPrecisionMs: 1_000 })])[0]!.status).toBe("recorded");
  });

  for (const change of ["revise", "cancel", "handle"]) test(`buffered ambiguity survives another manager's later ${change}`, () => {
    const { store, core, event } = setup();
    let now = 1_000;
    const timed = new SeekerCore(store, () => now);
    const managerA = timed.manager(fixtureBinding.origin);
    const originB = { ...fixtureBinding.origin, managerId: "manager-b", assignmentId: "work-b" };
    core.bind({ ...fixtureBinding, id: "binding-b", origin: originB });
    const managerB = timed.manager(originB);
    const questionB = managerB.submit({ requestId: "question-b", decision: fixtureDecision });
    for (let index = 0; index < 2; index += 1) {
      const send = store.claimDeliveries(4, now)[0]!;
      store.completeDelivery(send.id, send.attemptId!, { status: "accepted", reference: `presented:${index}` }, now);
    }
    now = 3_000;
    if (change === "revise") managerA.update({ type: "revise", requestId: "request-1", expectedVersion: 1, decision: { ...fixtureDecision, target: "changed destination" } });
    else if (change === "cancel") managerA.update({ type: "cancel", requestId: "request-1", expectedVersion: 1, reason: "Closed after the buffered reply" });
    else {
      const receipt = timed.channel("local").receive([event("close-a")])[0]!;
      managerA.update({ type: "acknowledge", requestId: "request-1", expectedVersion: managerA.get("request-1").exchange.version, receiptId: receipt.receiptId!, status: "handled", evidenceRef: "native:handled-a" });
    }
    now = 5_000;
    const buffered = event("historically-ambiguous", { replyHandle: undefined, kind: "answer", optionId: undefined, text: "Yes", occurredAt: 2_000, occurredAtPrecisionMs: 1_000 });
    expect(timed.channel("local").receive([buffered])[0]!.code).toBe("context_changed_since_reply");
    expect(timed.channel("local").receive([buffered])[0]!.status).toBe("unmatched");
    expect(managerB.get("question-b").counts.receipts).toBe(0);
    expect(timed.channel("local").receive([event("explicit-b", { replyHandle: questionB.current.replyHandle, kind: "question", optionId: undefined, text: "Clarify B", occurredAt: 2_000 })])[0]!.exchangeId).toBe("question-b");
    if (change !== "revise") expect(timed.channel("local").receive([event("after-closure", { replyHandle: undefined, kind: "answer", optionId: undefined, text: "Yes to the remaining request", occurredAt: 6_000 })])[0]!.exchangeId).toBe("question-b");
  });

  for (const lateResult of [false, true]) test(`an escaped earlier send retains ambiguity before ${lateResult ? "a delayed acceptance" : "any send result"}`, () => {
    const store = new SqliteExchangeStore(":memory:"); openStores.push(store);
    let now = 1_000;
    const core = new SeekerCore(store, () => now);
    core.bind(fixtureBinding);
    const originB = { ...fixtureBinding.origin, managerId: "manager-b", assignmentId: "work-b" };
    core.bind({ ...fixtureBinding, id: "binding-b", origin: originB });
    const managerA = core.manager(fixtureBinding.origin), managerB = core.manager(originB);
    managerB.submit({ requestId: "question-b", decision: fixtureDecision });
    const sendB = store.claimDeliveries(4, now)[0]!;
    store.completeDelivery(sendB.id, sendB.attemptId!, { status: "accepted", reference: "presented-b" }, now);
    managerA.submit({ requestId: "question-a", decision: fixtureDecision });
    const sendA = store.claimDeliveries(4, now)[0]!;
    now = 3_000;
    managerA.update({ type: "revise", requestId: "question-a", expectedVersion: 1, decision: { ...fixtureDecision, target: "later scope" } });
    if (lateResult) store.completeDelivery(sendA.id, sendA.attemptId!, { status: "accepted", reference: "accepted-earlier-confirmed-late" }, 3_500);
    now = 5_000;
    const result = core.channel("local").receive([{ eventId: "buffered", actorId: "owner", conversationId: "inbox", sourceRef: "message:buffered", kind: "answer", text: "Yes", occurredAt: 2_000 }])[0]!;
    expect(result.status).toBe("unmatched");
    expect(result.code).toBe("context_changed_since_reply");
    expect(managerB.get("question-b").counts.receipts).toBe(0);
  });

  test("trusted future recipient selection preserves old-channel replies and fixed old routes", () => {
    const { core, manager, channel, event, created } = setup();
    const recipient = { channelId: "other", actorId: "paired-owner", conversationId: "private-chat" };
    core.setRecipient(fixtureBinding.id, 1, recipient);
    expect(manager.submit({ requestId: "new-route", decision: fixtureDecision }).exchange.recipient).toEqual(recipient);
    expect(manager.get("request-1").exchange.recipient).toEqual(created.exchange.recipient);
    expect(channel.receive([event("old-channel")])[0]!.status).toBe("recorded");
    expect(core.channel("other").receive([event("wrong-channel", { actorId: "paired-owner", conversationId: "private-chat" })])[0]!.code).toBe("recipient_denied");
  });

  test("obsolete channel-failure notices retire, while a successor receives a current failure notice", () => {
    const { manager, core, store } = setup();
    const attempt = store.claimDeliveries(4, 1_000)[0]!;
    store.completeDelivery(attempt.id, attempt.attemptId!, { status: "unknown", code: "io_timeout" }, 1_001);
    store.transfer(fixtureBinding.id, 1, { ...fixtureBinding.origin, managerId: "successor", generation: 2 });
    const view = core.manager({ ...fixtureBinding.origin, managerId: "successor", generation: 2 }).get("request-1");
    const deliveries = store.get(view.exchange.id)!.deliveries;
    expect(deliveries.filter((item) => item.noticeOf && item.state === "queued")).toHaveLength(1);
    expect(deliveries.find((item) => item.noticeOf && item.state === "queued")!.ownerGeneration).toBe(2);
    core.manager({ ...fixtureBinding.origin, managerId: "successor", generation: 2 }).update({ type: "cancel", requestId: "request-1", expectedVersion: view.exchange.version, reason: "No longer needed" });
    expect(store.claimDeliveries(4, Date.now() + 1_000)).toHaveLength(0);
    expect(() => manager.get("request-1")).toThrow("not bound");
  });

  test("handled history does not exhaust active capacity and is retrieved in bounded pages", () => {
    const { manager, core } = setup();
    manager.update({ type: "cancel", requestId: "request-1", expectedVersion: 1, reason: "History fixture" });
    for (let index = 0; index < 1_000; index += 1) {
      const requestId = `history-${String(index).padStart(4, "0")}`;
      manager.submit({ requestId, decision: fixtureDecision });
      manager.update({ type: "cancel", requestId, expectedVersion: 1, reason: "Handled history fixture" });
    }
    expect(manager.submit({ requestId: "still-usable", decision: fixtureDecision }).exchange.state).toBe("waiting");
    expect(core.inbox(fixtureBinding.recipient)).toHaveLength(51);
    const first = core.history(fixtureBinding.recipient);
    const second = core.history(fixtureBinding.recipient, first.nextCursor);
    expect(first.items).toHaveLength(50); expect(second.items).toHaveLength(50);
    expect(first.items.some((item) => second.items.some((other) => other.exchange.id === item.exchange.id))).toBe(false);
    expect(manager.get("history-0999").exchange.cancellation!.reason).toBe("Handled history fixture");
  });
});
