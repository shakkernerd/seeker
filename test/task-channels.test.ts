import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeekerCore } from "../src/core/seeker.ts";
import { eventEnvelope, eventReturnCurrent, eventReturnTarget } from "../src/core/event-return.ts";
import { eventDigest, eventLimits, eventRoute } from "../src/core/events.ts";
import type { EventOwner, EventWait } from "../src/events.ts";
import { fixtureBinding } from "../src/local/fixture.ts";
import { nativeWakeup } from "../src/hosts/codex/protocol.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const receiver: EventOwner = { hostId: "task-host", taskId: "manager-task", turnId: "manager-turn", callId: "manager-call" };
const sender: EventOwner = { hostId: "task-host", taskId: "lead-task", turnId: "lead-turn", callId: "lead-call" };
const grant = { waitId: "lead-reports", title: "Unit reports", peerTaskId: sender.taskId, expiresAt: 5000 };
const report = { waitId: grant.waitId, messageId: "report-1", text: "Proof passed; review is next.", evidenceRefs: ["artifact:proof"] };
function fixture(persistent = false) {
  const directory = mkdtempSync(join(tmpdir(), "seeker-channel-")), path = join(directory, "store.sqlite");
  let now = 1000, store = new SqliteExchangeStore(persistent ? path : ":memory:"), core = new SeekerCore(store, () => now);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    path, get core() { return core; }, get store() { return store; }, now: () => now,
    receiver: () => core.events(receiver), sender: () => core.events(sender), setTime: (time: number) => { now = time; },
    restart: () => { store.close(); store = new SqliteExchangeStore(path); core = new SeekerCore(store, () => now); },
    reopen: () => { store = new SqliteExchangeStore(path); core = new SeekerCore(store, () => now); },
  };
}
function complete(f: ReturnType<typeof fixture>, wait: EventWait, status: "accepted" | "unknown" = "accepted") {
  f.store.events.complete(wait.waitId, wait.generation, wait.delivery!.attemptId!, status === "accepted" ? { status, reference: `native:${wait.waitId}` } : { status, code: "native_timeout" }, f.now());
}

test("an explicit native receiver grant permits repeated peer reports without human-manager registration", () => {
  const f = fixture();
  expect(() => f.sender().sendChannel(report)).toThrow("No channel grant");
  const opened = f.receiver().openChannel(grant);
  expect(opened).toMatchObject({ state: "waiting", owner: receiver, channel: { peerTaskId: sender.taskId } });
  expect(f.receiver().openChannel(grant)).toEqual(opened);
  expect(() => f.receiver().openChannel({ ...grant, title: "Other unit" })).toThrow("different content");
  expect(() => f.receiver().openChannel({ ...grant, waitId: "self", peerTaskId: receiver.taskId })).toThrow("itself");
  expect(() => f.receiver().openChannel({ ...grant, waitId: "infinite", expiresAt: Infinity })).toThrow();
  expect(f.core.managerBinding(receiver.hostId, receiver.taskId)).toBeUndefined();
  expect(f.core.managerBinding(sender.hostId, sender.taskId)).toBeUndefined();
  expect(() => f.core.manager({ hostId: sender.hostId, managerId: sender.taskId, assignmentId: sender.taskId, generation: 1 })).toThrow();
  // A peer cannot flood discovery merely by naming this task; reverse discovery requires a reciprocal link.
  expect(f.sender().pending()).toEqual([]);
  expect(f.receiver().pending()).toEqual([expect.objectContaining({ waitId: grant.waitId, channelDirection: "receive" })]);
  expect(f.sender().get({ waitId: grant.waitId }).channel?.peerTaskId).toBe(sender.taskId);

  const first = f.sender().sendChannel(report);
  expect(first.status).toBe("recorded");
  expect(f.core.events({ ...sender, turnId: "later-turn", callId: "later-call" }).sendChannel(report)).toEqual({ ...first, status: "duplicate" });
  expect(() => f.sender().sendChannel({ ...report, text: "Changed result" })).toThrow("different content");
  const second = f.sender().sendChannel({ ...report, messageId: "report-2", text: "Review finished." });
  expect(second.waitId).not.toBe(first.waitId);
  const saved = f.receiver().get(first);
  expect(saved).toMatchObject({ state: "ready", message: { channelId: grant.waitId, sender }, receipt: { source: "channel", signal: { outcome: "message", summary: report.text, evidenceRefs: report.evidenceRefs } } });
  expect(f.sender().get(first)).toEqual(saved);
  expect(() => f.sender().cancel(first)).toThrow("another native task");
  expect(() => f.sender().cancel({ waitId: grant.waitId })).toThrow("another native task");
  for (const stranger of [{ ...sender, taskId: "other-task" }, { ...sender, hostId: "other-host" }]) {
    expect(() => f.core.events(stranger).sendChannel(report)).toThrow("No channel grant");
    expect(() => f.core.events(stranger).get(first)).toThrow("another native task");
    expect(f.core.events(stranger).pending()).toEqual([]);
  }
  // One recipient at a time, in the existing queue; a grant itself never sends a deadline notice.
  const claimed = f.store.events.claim(4, f.now(), []);
  expect(claimed.map((wait) => wait.waitId)).toEqual([first.waitId]);
  complete(f, claimed[0]!);
  const next = f.store.events.claim(4, f.now(), []);
  expect(next.map((wait) => wait.waitId)).toEqual([second.waitId]);
  complete(f, next[0]!);
  expect(f.receiver().pending().map((wait) => wait.waitId)).toEqual([grant.waitId]);
});

test("explicit urgent directions precede routine retries without overtaking in-flight delivery", () => {
  const f = fixture(true);
  f.receiver().openChannel(grant);
  const routineInput = { ...report, text: "Stop appears in this ordinary report." };
  const routine = f.sender().sendChannel(routineInput);
  const inFlight = f.store.events.claim(1, f.now(), [])[0]!;
  expect(inFlight.message?.urgent).toBeUndefined();
  f.store.events.complete(inFlight.waitId, inFlight.generation, inFlight.delivery!.attemptId!, { status: "retry", code: "event_owner_active", retryAfterMs: 1000 }, f.now());
  f.setTime(2500);
  const input = { ...report, messageId: "stop-1", text: "Stop the assigned work and report command settlement.", urgent: true };
  const urgent = f.sender().sendChannel(input);
  // The pump excludes an occupied route, even when an urgent message is due there.
  expect(f.store.events.claim(1, f.now(), [eventRoute(inFlight)])).toEqual([]);
  f.restart();
  expect(f.sender().sendChannel(input)).toEqual({ ...urgent, status: "duplicate" });
  expect(() => f.sender().sendChannel({ ...input, urgent: false })).toThrow("different content");
  expect(f.sender().sendChannel({ ...routineInput, urgent: false })).toEqual({ ...routine, status: "duplicate" });
  const selected = f.store.events.claim(1, f.now(), [])[0]!;
  expect(selected.waitId).toBe(urgent.waitId);
  expect(selected.message?.urgent).toBe(true);
  expect(eventEnvelope(selected).event.result.urgent).toBe(true);
  const prompt = nativeWakeup({ attemptId: "urgent-attempt", binding: eventReturnTarget(selected), envelope: eventEnvelope(selected) });
  expect(prompt).toContain("Delivery does not confirm");
  complete(f, selected, "unknown");
  // Reconnection and an exact retry retain ambiguity rather than steering twice.
  f.core.resumeHost(receiver.hostId);
  expect(f.sender().sendChannel(input)).toEqual({ ...urgent, status: "duplicate" });
  expect(f.store.events.claim(1, f.now(), [])[0]!.waitId).toBe(routine.waitId);
  expect(f.receiver().get(urgent).delivery?.state).toBe("unknown");
});

test("one active grant per native receiver/peer pair makes idless retries and reverse routing unambiguous", () => {
  const f = fixture();
  const request = { title: grant.title, peerTaskId: grant.peerTaskId, expiresAt: grant.expiresAt };
  const opened = f.receiver().openChannel(request);
  expect(f.receiver().openChannel(request)).toEqual(opened);
  expect(f.receiver().openChannel({ ...request, waitId: opened.waitId })).toEqual(opened);
  for (const conflicting of [{ ...request, title: "Different unit" }, { ...request, expiresAt: 6000 }, { ...request, waitId: "different-id" }]) {
    expect(() => f.receiver().openChannel(conflicting)).toThrow("already has an active grant");
  }
  expect(f.receiver().pending().map((wait) => wait.waitId)).toEqual([opened.waitId]);
  const reverse = f.sender().openChannel({ title: "Instructions", peerTaskId: receiver.taskId, expiresAt: grant.expiresAt });
  expect(reverse.outgoing?.waitId).toBe(opened.waitId);
  expect(f.sender().openChannel({ title: "Instructions", peerTaskId: receiver.taskId, expiresAt: grant.expiresAt })).toEqual(reverse);
  expect(f.store.events.claim(4, f.now(), [])).toHaveLength(1);
  f.receiver().cancel(opened);
  const replacement = f.receiver().openChannel({ ...request, waitId: "replacement" });
  expect(replacement.waitId).toBe("replacement");
  expect(replacement.outgoing?.waitId).toBe(reverse.waitId);
  // Natural expiry also releases the active-pair slot while preserving the old identity.
  f.setTime(grant.expiresAt);
  expect(f.receiver().openChannel({ ...request, expiresAt: 6000, waitId: "after-expiry" }).state).toBe("waiting");
  expect(f.receiver().get(replacement).state).toBe("expired");
});

test("one-sided grants from unrelated tasks cannot flood a caller's bounded reciprocal discovery", () => {
  const f = fixture();
  for (let i = 0; i <= eventLimits.perTask; i++) {
    f.core.events({ ...receiver, taskId: `unlinked-${i}` }).openChannel({ title: "Unsolicited grant", peerTaskId: sender.taskId, expiresAt: grant.expiresAt });
  }
  f.receiver().openChannel(grant);
  expect(f.sender().pending()).toEqual([]);
  const reverse = f.sender().openChannel({ title: "Authorized instructions", peerTaskId: receiver.taskId, expiresAt: grant.expiresAt });
  expect(reverse.outgoing?.waitId).toBe(grant.waitId);
  expect(f.sender().pending()).toEqual([
    expect.objectContaining({ waitId: reverse.waitId, channelDirection: "receive" }),
    expect.objectContaining({ waitId: grant.waitId, channelDirection: "send", owner: { hostId: receiver.hostId, taskId: receiver.taskId } }),
  ]);
  f.sender().cancel(reverse);
  expect(f.sender().pending()).toEqual([]);
});

test("reciprocal grants bootstrap an idle first opener exactly once through its already authorized incoming path", () => {
  const f = fixture();
  expect(f.receiver().openChannel(grant).outgoing).toBeUndefined();
  expect(f.store.events.claim(4, f.now(), [])).toEqual([]);
  const reverse = { waitId: "manager-instructions", title: "Unit instructions", peerTaskId: receiver.taskId, expiresAt: 5000 };
  const opened = f.sender().openChannel(reverse);
  expect(opened.outgoing).toEqual({ waitId: grant.waitId, expiresAt: grant.expiresAt, receiverTaskId: receiver.taskId });
  expect(f.sender().openChannel(reverse)).toEqual(opened);
  expect(f.receiver().openChannel(grant).outgoing).toEqual({ waitId: reverse.waitId, expiresAt: reverse.expiresAt, receiverTaskId: sender.taskId });
  const ready = f.store.events.claim(4, f.now(), []);
  expect(ready).toHaveLength(1);
  expect(ready[0]).toMatchObject({ owner: receiver, message: { sender, channelId: grant.waitId, readyChannelId: reverse.waitId } });
  const notice = nativeWakeup({ attemptId: "test", binding: eventReturnTarget(ready[0]!), envelope: eventEnvelope(ready[0]!) });
  expect(notice).toContain(`event_get {"waitId":"${reverse.waitId}"}`);
  expect(notice).toContain("not human approval");
  complete(f, ready[0]!);
  expect(f.store.events.claim(4, f.now(), [])).toEqual([]);
  expect(f.sender().openChannel(reverse).outgoing?.waitId).toBe(grant.waitId);
  expect(f.store.events.claim(4, f.now(), [])).toEqual([]);
  const instruction = f.receiver().sendChannel({ waitId: reverse.waitId, messageId: "continue-proof", text: "Continue the authorized focused proof." });
  expect(f.sender().get(instruction).message?.sender.taskId).toBe(receiver.taskId);
  expect(f.receiver().pending().filter((wait) => wait.channel).map((wait) => [wait.waitId, wait.channelDirection])).toEqual([[grant.waitId, "receive"], [reverse.waitId, "send"]]);
});

test("expiry closes new sends while committed messages survive restart and parent retention", () => {
  const f = fixture(true); f.receiver().openChannel(grant);
  const sent = f.sender().sendChannel(report);
  f.setTime(grant.expiresAt);
  expect(() => f.sender().sendChannel({ ...report, messageId: "too-late" })).toThrow("expired");
  expect(f.receiver().get(grant).state).toBe("expired");
  expect(f.sender().sendChannel(report)).toEqual({ ...sent, status: "duplicate" });
  expect(f.receiver().openChannel(grant).state).toBe("expired");
  expect(f.sender().pending()).toEqual([]);
  f.restart();
  f.setTime(grant.expiresAt + eventLimits.retainedMs * 2);
  const attempt = f.store.events.claim(4, f.now(), [])[0]!;
  expect(attempt.waitId).toBe(sent.waitId);
  expect(f.receiver().get(grant).state).toBe("expired");
  expect(() => f.receiver().clear(grant)).toThrow("Settle");
  expect(eventReturnCurrent(f.core, eventReturnTarget(attempt), eventEnvelope(attempt))).toBe(true);
  complete(f, attempt);
  f.setTime(f.now() + eventLimits.retainedMs);
  f.store.events.claim(4, f.now(), []);
  expect(f.receiver().get(sent).state).toBe("cleared");
  f.store.events.claim(4, f.now(), []);
  expect(f.receiver().get(grant).state).toBe("cleared");
  expect(() => f.receiver().openChannel({ ...grant, expiresAt: f.now() + 1000 })).toThrow("different content");
  expect(() => f.sender().sendChannel(report)).toThrow("No channel grant");
});

test("cancel after expiry fences committed work and retains unknown and in-flight evidence", () => {
  const f = fixture(true); f.receiver().openChannel(grant);
  const unknown = f.sender().sendChannel(report);
  const first = f.store.events.claim(1, f.now(), [])[0]!; complete(f, first, "unknown");
  const queued = f.sender().sendChannel({ ...report, messageId: "queued" });
  const inflight = f.sender().sendChannel({ ...report, messageId: "inflight" });
  // The earlier unsent queue member is the claimed in-flight attempt; the later one stays queued.
  const second = f.store.events.claim(1, f.now(), [])[0]!;
  expect(second.waitId).toBe(queued.waitId);
  f.setTime(grant.expiresAt); f.receiver().cancel(grant);
  expect(f.receiver().get(unknown)).toMatchObject({ state: "cancelled", delivery: { state: "unknown" } });
  expect(f.receiver().get(queued)).toMatchObject({ state: "cancelled", delivery: { state: "sending" } });
  expect(f.receiver().get(inflight)).toMatchObject({ state: "cancelled", delivery: { state: "retired" } });
  expect(eventReturnCurrent(f.core, eventReturnTarget(second), eventEnvelope(second))).toBe(false);
  // A write that escaped before cancellation may still confirm acceptance. Cancellation never lies about it.
  complete(f, second);
  expect(f.receiver().get(queued)).toMatchObject({ state: "cancelled", delivery: { state: "accepted" } });
  f.restart(); f.store.events.recover(f.now());
  f.setTime(f.now() + eventLimits.retainedMs * 2); f.store.events.claim(4, f.now(), []);
  expect(f.receiver().get(unknown)).toMatchObject({ state: "cancelled", delivery: { state: "unknown" } });
  expect(f.receiver().get(grant).state).toBe("cancelled");
  expect(() => f.receiver().clear(unknown)).toThrow("Settle");
  f.receiver().acknowledge(unknown, "handled"); f.receiver().clear(unknown);
  f.store.events.claim(4, f.now(), []);
  expect(f.receiver().get(grant).state).toBe("cleared");
});

test("a restart marks a channel message in flight unknown and never replays it", () => {
  const f = fixture(true); f.receiver().openChannel(grant);
  const sent = f.sender().sendChannel(report);
  expect(f.store.events.claim(1, f.now(), [])).toHaveLength(1);
  f.restart(); expect(f.store.events.recover(f.now())).toBe(1);
  expect(f.receiver().get(sent)).toMatchObject({ state: "ready", delivery: { state: "unknown", code: "receiver_restarted" } });
  expect(f.store.events.claim(4, f.now(), [])).toEqual([]);
  expect(f.sender().sendChannel(report)).toEqual({ ...sent, status: "duplicate" });
});

test("both endpoints' optional assignment snapshots fence grants before native delivery", () => {
  for (const endpoint of [receiver, sender]) {
    const f = fixture();
    const binding = { ...fixtureBinding, id: `binding-${endpoint.taskId}`, origin: { hostId: endpoint.hostId, managerId: endpoint.taskId, assignmentId: "unit", generation: 1 } };
    f.core.bind(binding);
    const stale = f.core.events(endpoint);
    f.receiver().openChannel(grant); f.sender().sendChannel(report);
    const attempt = f.store.events.claim(1, f.now(), [])[0]!;
    f.store.transfer(binding.id, 1, { ...binding.origin, generation: 2 });
    expect(() => stale.pending()).toThrow("assignment changed");
    expect(eventReturnCurrent(f.core, eventReturnTarget(attempt), eventEnvelope(attempt))).toBe(false);
    expect(f.receiver().get(grant)).toMatchObject({ state: "cancelled", reason: "channel_owner_changed" });
    expect(() => f.sender().sendChannel({ ...report, messageId: "new-generation" })).toThrow("assignment changed");
  }
  const f = fixture(); f.receiver().openChannel(grant); f.sender().sendChannel(report);
  const attempt = f.store.events.claim(1, f.now(), [])[0]!;
  // A previously unregistered sender gaining a human-manager assignment also changes its snapshot.
  f.core.bind({ ...fixtureBinding, origin: { hostId: sender.hostId, managerId: sender.taskId, assignmentId: "new-assignment", generation: 1 } });
  expect(eventReturnCurrent(f.core, eventReturnTarget(attempt), eventEnvelope(attempt))).toBe(false);
});

test("ambiguous channel ownership cannot block unrelated one-shot delivery", () => {
  for (const endpoint of [receiver, sender]) {
    const f = fixture();
    f.receiver().openChannel(grant); f.sender().sendChannel(report);
    const healthy = { ...receiver, taskId: "healthy-task" };
    const job = { waitId: "healthy-job", generation: "g", revision: "r", title: "Unrelated job", expiresAt: 5000, capabilityDigest: eventDigest("a".repeat(64)) };
    f.store.events.arm(healthy, job, f.now());
    f.store.events.signal("a".repeat(64), { waitId: job.waitId, generation: job.generation, revision: job.revision, eventId: "done", outcome: "completed", summary: "Finished", evidenceRefs: [] }, f.now());
    for (const n of [1, 2]) f.core.bind({ ...fixtureBinding, id: `ambiguous-${n}`, origin: { hostId: endpoint.hostId, managerId: endpoint.taskId, assignmentId: `unit-${n}`, generation: 1 } });
    const claimed = f.store.events.claim(4, f.now(), []);
    expect(claimed.map((wait) => wait.waitId)).toEqual([job.waitId]);
    expect(f.store.events.get(receiver, grant, f.now())).toMatchObject({ state: "cancelled", reason: "channel_owner_changed" });
    complete(f, claimed[0]!);
  }
});

test("payload and existing queue bounds reject atomically without evicting reports or leaking a reverse grant", () => {
  const f = fixture(); f.receiver().openChannel(grant);
  expect(() => f.sender().sendChannel({ ...report, text: "x".repeat(8193) })).toThrow();
  expect(() => f.sender().sendChannel({ ...report, text: "é".repeat(8192) })).toThrow("byte limit");
  expect(() => f.sender().sendChannel({ ...report, evidenceRefs: Array(9).fill("artifact:x") })).toThrow("eight");
  for (let i = 0; i < eventLimits.perTask - 1; i++) f.sender().sendChannel({ ...report, messageId: `message-${i}` });
  expect(() => f.sender().sendChannel({ ...report, messageId: "overflow" })).toThrow("capacity");
  const reverse = { waitId: "reverse-at-capacity", title: "Instructions", peerTaskId: receiver.taskId, expiresAt: grant.expiresAt };
  expect(() => f.sender().openChannel(reverse)).toThrow("capacity");
  expect(() => f.sender().get(reverse)).toThrow("not found");
  const attempt = f.store.events.claim(1, f.now(), [])[0]!; complete(f, attempt);
  expect(f.sender().openChannel(reverse).outgoing?.waitId).toBe(grant.waitId);
  expect(f.receiver().pending()).toHaveLength(eventLimits.perTask + 1); // receiver capacity plus its newly discovered outgoing grant
});

test("revoking either bootstrap grant fences the ready notice and retention never orphans it", () => {
  const f = fixture(); f.receiver().openChannel(grant);
  const reverse = { waitId: "reverse", title: "Instructions", peerTaskId: receiver.taskId, expiresAt: grant.expiresAt };
  f.sender().openChannel(reverse);
  const ready = f.store.events.claim(1, f.now(), [])[0]!;
  f.sender().cancel(reverse);
  expect(eventReturnCurrent(f.core, eventReturnTarget(ready), eventEnvelope(ready))).toBe(false);
  expect(() => f.sender().clear(reverse)).toThrow("Settle");
  f.store.events.complete(ready.waitId, ready.generation, ready.delivery!.attemptId!, { status: "rejected", code: "delivery_not_current" }, f.now());
  f.receiver().clear(ready);
  expect(f.sender().clear(reverse).state).toBe("cleared");
});

test("schema upgrade preserves existing one-shot rows and rejects unsupported store semantics", () => {
  const f = fixture(true);
  const old = { waitId: "old-wait", generation: "g", revision: "r", title: "Existing job", expiresAt: 9000, capabilityDigest: eventDigest("a".repeat(64)) };
  f.store.events.arm(receiver, old, f.now());
  f.store.close();
  let db = new Database(f.path); db.run("PRAGMA user_version=8"); db.close();
  f.reopen(); expect(f.receiver().get(old).state).toBe("waiting");
  f.receiver().openChannel(grant); f.store.close();
  db = new Database(f.path);
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(10);
  db.run("PRAGMA user_version=11"); db.close();
  expect(() => new SqliteExchangeStore(f.path)).toThrow("compatible Seeker version");
  db = new Database(f.path); expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(11); db.run("PRAGMA user_version=10"); db.close();
  f.reopen(); expect(f.receiver().get(grant).state).toBe("waiting");
});
