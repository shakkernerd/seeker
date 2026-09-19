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
  const handle = created.exchange.revisions[0]!.replyHandle;
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
    expect(second.created.exchange.receipts[0]!.id).toBe(receipt.receiptId!);
    expect(second.manager.listPending()).toHaveLength(1);
    expect(second.created.exchange.state).toBe("answered");
    expect(second.created.deliveries.filter((item) => item.lane === "channel")).toHaveLength(1);
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
    const { channel, manager, event } = setup();
    const first = channel.receive([event("a1")])[0]!;
    expect(channel.receive([event("a1")])[0]!.status).toBe("duplicate");
    expect(channel.receive([event("a2")])[0]!.receiptId).toBe(first.receiptId);
    channel.receive([event("b", { kind: "decline", optionId: "skip" })]);
    const lastA = channel.receive([event("a3")])[0]!;
    expect(lastA.status).toBe("recorded");
    expect(lastA.receiptId).not.toBe(first.receiptId);
    for (const key of ["why1", "why2"]) channel.receive([event(key, { kind: "answer", optionId: undefined, text: "Why?" })]);
    const exchange = manager.get("request-1").exchange;
    expect(exchange.receipts).toHaveLength(5);
    expect(exchange.receipts[2]!.classification).toBe("correction");
    expect(exchange.state).toBe("reconcile");
  });

  test("context preserves authority; changed material decisions retire old choices but retain late stop", () => {
    const { manager, channel, event, handle } = setup();
    let view = manager.update({ type: "context", requestId: "request-1", expectedVersion: 1, messageId: "why", text: "An equivalent implementation explanation." });
    expect(view.exchange.revisions[0]!.replyHandle).toBe(handle);
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
    let view = manager.get("request-1");
    expect(view.exchange.receipts[1]!.conditions).toContain("backed up");
    expect(view.exchange.receipts[1]!.disposition.status).toBe("pending");
    view = manager.update({ type: "acknowledge", requestId: "request-1", receiptId: recorded.receiptId!, expectedVersion: view.exchange.version, status: "received", evidenceRef: "native:message-1" });
    expect(view.exchange.state).toBe("answered");
    expect(view.exchange.receipts[1]!.disposition.status).toBe("received");
    expect(() => manager.update({ type: "acknowledge", requestId: "request-1", receiptId: recorded.receiptId!, expectedVersion: 1, status: "handled", evidenceRef: "native:message-2" })).toThrow("changed");
  });

  test("wrong actor, wrong conversation and manufactured native channel are rejected", () => {
    const { channel, core, manager, event } = setup();
    expect(channel.receive([event("wrong-user", { actorId: "stranger" })])[0]!.code).toBe("recipient_denied");
    expect(channel.receive([event("wrong-chat", { conversationId: "other-inbox" })])[0]!.code).toBe("recipient_denied");
    expect(() => core.channel("native:fixture")).toThrow("trusted host");
    expect(manager.get("request-1").exchange.receipts).toHaveLength(0);
  });

  test("ingress commits receipts, source dedup and progress as one batch", () => {
    const { channel, manager, event } = setup();
    channel.receive([], { cursor: "1", lastReceivedAt: 20, continuity: "continuous" });
    expect(() => channel.receive([event("batch1")], { cursor: "2", lastReceivedAt: 10, continuity: "continuous" })).toThrow("backwards");
    expect(manager.get("request-1").exchange.receipts).toHaveLength(0);
    expect(channel.progress()!.cursor).toBe("1");
    expect(channel.receive([event("batch1")], { cursor: "2", lastReceivedAt: 30, continuity: "continuous" })[0]!.status).toBe("recorded");
    expect(channel.progress()!.cursor).toBe("2");
  });

  test("ambiguous bare replies do not choose the newest manager; unique bare replies can correlate", () => {
    const { manager, channel, event } = setup();
    manager.submit({ requestId: "request-2", decision: fixtureDecision });
    expect(channel.receive([event("bare1", { replyHandle: undefined, kind: "question", optionId: undefined, text: "Which folder?" })])[0]!.code).toBe("ambiguous");
    manager.update({ type: "cancel", requestId: "request-2", expectedVersion: 1, reason: "Redundant sample" });
    expect(channel.receive([event("bare2", { replyHandle: undefined, kind: "question", optionId: undefined, text: "Which folder?" })])[0]!.exchangeId).toBe("request-1");
  });

  test("native authenticated source can reconcile an exchange without manufacturing provider provenance", () => {
    const { core, manager, event } = setup();
    const result = core.receiveNative(fixtureBinding.origin, "request-1", 1, event("native-answer", { actorId: "native-human", conversationId: "native-task", kind: "answer", optionId: undefined, text: "Keep it local; I answered here." }));
    let view = manager.get("request-1");
    expect(view.exchange.receipts[0]!.source.verification).toBe("native");
    view = manager.update({ type: "acknowledge", requestId: "request-1", receiptId: result.receiptId!, status: "handled", expectedVersion: view.exchange.version, evidenceRef: "native:original-message" });
    expect(view.exchange.state).toBe("handled");
    expect(manager.listPending()).toHaveLength(0);
  });

  test("unknown send survives recovery without automatic retries and retry hints delay definite retries", () => {
    const { store, manager } = setup();
    const first = store.claimDeliveries(4, 1_000)[0]!;
    expect(first.state).toBe("sending");
    expect(store.recoverInterruptedDeliveries()).toBe(1);
    expect(store.claimDeliveries(4, 1_000_000)).toHaveLength(0);
    expect(manager.get("request-1").deliveries[0]!.state).toBe("unknown");
    manager.submit({ requestId: "request-2", decision: fixtureDecision });
    const second = store.claimDeliveries(4, 1_000)[0]!;
    store.completeDelivery(second.id, second.attemptId!, { status: "retry", retryAfterMs: 7_000, code: "rate_limited" }, 1_000);
    expect(store.claimDeliveries(4, 7_999)).toHaveLength(0);
    expect(store.claimDeliveries(4, 8_000)).toHaveLength(1);
  });
});
