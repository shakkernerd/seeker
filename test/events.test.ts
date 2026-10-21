import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { eventEnvelope, eventReturnCurrent, eventReturnTarget } from "../src/core/event-return.ts";
import { Database } from "bun:sqlite";
import { fixtureBinding, fixtureDecision } from "../src/local/fixture.ts";
import { eventDigest } from "../src/core/events.ts";
import type { EventArm, EventOwner, EventSignal } from "../src/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const owner: EventOwner = { hostId: "fixture-events", taskId: "task-one", turnId: "turn-one", callId: "call-one" };
const capability = "a".repeat(64);
const address = { waitId: "dependency-one", generation: "generation-one", revision: "source-one" };
const arm: EventArm = { ...address, title: "Wait for dependency", expiresAt: 100_000, capabilityDigest: eventDigest(capability) };
const signal: EventSignal = { ...address, eventId: "release-one", outcome: "released", summary: "Dependency is ready.", evidenceRefs: ["artifact:result-one"] };
function fixture(persistent = false) {
  const directory = mkdtempSync(join(tmpdir(), "seeker-event-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  let store = new SqliteExchangeStore(persistent ? join(directory, "store.sqlite") : ":memory:");
  let now = 1000;
  let core = new SeekerCore(store, () => now);
  cleanups.push(() => store.close());
  const port = () => core.events(owner);
  return { directory, get store() { return store; }, get core() { return core; }, port, setTime: (value: number) => { now = value; },
    restart: () => { store.close(); store = new SqliteExchangeStore(join(directory, "store.sqlite")); core = new SeekerCore(store, () => now); },
    reopen: () => { store = new SqliteExchangeStore(join(directory, "store.sqlite")); core = new SeekerCore(store, () => now); },
  };
}

test("machine admission fixes the native owner, deduplicates exact signals and retains complete evidence", () => {
  const f = fixture(); const wait = f.port().arm(arm);
  expect(wait.state).toBe("waiting");
  expect(JSON.stringify(wait)).not.toContain(capability);
  expect(f.core.managerBinding(owner.hostId, owner.taskId)).toBeUndefined();
  expect(() => f.core.manager({ hostId: owner.hostId, managerId: owner.taskId, assignmentId: owner.taskId, generation: 1 })).toThrow();
  expect(f.port().arm({ ...arm })).toEqual(wait);
  const reordered = { capabilityDigest: arm.capabilityDigest, expiresAt: arm.expiresAt, title: arm.title, revision: arm.revision, generation: arm.generation, waitId: arm.waitId };
  expect(f.port().arm(reordered)).toEqual(wait);
  expect(() => f.port().arm({ ...arm, title: "Different wait" })).toThrow("different content");
  expect(() => f.core.events({ ...owner, taskId: "other-task" }).get(address)).toThrow("another native task");
  expect(() => f.store.events.signal("b".repeat(64), signal, 1000)).toThrow("not accepted");
  expect(() => f.store.events.signal(capability, { ...signal, generation: "old" }, 1000)).toThrow("generation");
  expect(() => f.store.events.signal(capability, { ...signal, revision: "old" }, 1000)).toThrow("revision");
  const receipt = f.store.events.signal(capability, signal, 1000);
  expect(f.store.events.signal(capability, { ...signal }, 1000)).toEqual({ ...receipt, status: "duplicate" });
  expect(() => f.store.events.signal(capability, { ...signal, summary: "Changed result" }, 1000)).toThrow("different saved event");
  const saved = f.port().get(address);
  expect(saved.receipt?.signal).toEqual(signal);
  expect(saved.delivery?.state).toBe("queued");
  expect(f.port().pending()).toEqual([expect.objectContaining({ receiptId: receipt.receiptId, state: "ready" })]);
  expect(JSON.stringify(f.port().pending())).not.toContain(signal.summary);
});

test("cancellation, explicit expiry and stale versions revoke known-unsent work without evicting results", () => {
  for (const mode of ["cancel", "expire"] as const) {
    const f = fixture(); f.port().arm(arm); f.store.events.signal(capability, signal, 1000);
    let saved = f.port().get(address);
    expect(() => f.port().cancel(address, 1)).toThrow("current wait");
    if (mode === "cancel") saved = f.port().cancel(address, saved.version);
    else { f.setTime(arm.expiresAt); saved = f.port().get(address); }
    expect(saved.state).toBe(mode === "cancel" ? "cancelled" : "expired");
    expect(saved.receipt?.signal).toEqual(signal);
    expect(f.store.events.claim(4, arm.expiresAt, [])).toEqual([]);
    expect(f.store.events.signal(capability, signal, arm.expiresAt).status).toBe("duplicate");
  }
  const f = fixture(); f.port().arm(arm); f.port().cancel(address, 1);
  expect(() => f.store.events.signal(capability, signal, 1001)).toThrow("no longer accepts");
});

test("a missed deadline saves one truthful failure, rejects late producers and survives restart without replay", () => {
  for (const outcome of ["accepted", "unknown", "interrupted"] as const) {
    const f = fixture(true); f.port().arm(arm); f.restart(); f.setTime(arm.expiresAt);
    // A late signal can itself discover the deadline; rejection still commits its notice.
    expect(() => f.store.events.signal(capability, signal, arm.expiresAt)).toThrow("deadline passed");
    const saved = f.port().get(address);
    expect(saved.state).toBe("ready"); expect(saved.reason).toBe("deadline_passed");
    expect(saved.receipt).toMatchObject({ source: "deadline", disposition: "pending", recordedAt: arm.expiresAt,
      signal: { ...address, outcome: "failed", evidenceRefs: [] } });
    expect(saved.receipt!.signal.summary).toContain("Job completion is unknown");
    expect(f.port().arm(arm)).toEqual(saved);
    f.restart();
    let attempt = f.store.events.claim(1, arm.expiresAt, [])[0]!;
    expect(attempt.receipt).toEqual(saved.receipt);
    expect(eventReturnCurrent(f.core, eventReturnTarget(attempt), eventEnvelope(attempt))).toBe(true);
    f.store.events.complete(address.waitId, address.generation, attempt.delivery!.attemptId!, { status: "retry", code: "event_owner_active", retryAfterMs: 1000 }, arm.expiresAt);
    expect(f.store.events.claim(1, arm.expiresAt + 999, [])).toEqual([]);
    attempt = f.store.events.claim(1, arm.expiresAt + 1000, [])[0]!;
    expect(attempt.delivery!.id).toBe(saved.delivery!.id);
    if (outcome !== "interrupted") f.store.events.complete(address.waitId, address.generation, attempt.delivery!.attemptId!, outcome === "accepted" ? { status: "accepted", reference: "native:deadline" } : { status: "unknown", code: "io_timeout" }, arm.expiresAt + 1000);
    f.restart(); expect(f.store.events.recover(arm.expiresAt + 1001)).toBe(outcome === "interrupted" ? 1 : 0);
    expect(f.store.events.claim(1, arm.expiresAt + 2000, [])).toEqual([]);
    expect(f.store.events.resumeHost(owner.hostId, arm.expiresAt + 2000)).toBe(0);
    let current = f.port().get(address);
    expect(current.receipt).toEqual(saved.receipt);
    expect(current.delivery!.state).toBe(outcome === "accepted" ? "accepted" : "unknown");
    expect(f.store.events.claim(1, arm.expiresAt + 3000, [])).toEqual([]);
    current = f.port().acknowledge(address, current.version, current.receipt!.id, "handled");
    expect(f.port().clear(address, current.version).state).toBe("cleared");
  }
});

test("deadline discovery respects cancellation, and the pump creates a receipt without a reader", () => {
  const f = fixture(); f.port().arm(arm); f.port().cancel(address, 1);
  const due = { ...arm, waitId: "pump-deadline" };
  f.port().arm(due);
  f.setTime(arm.expiresAt);
  const claims = f.store.events.claim(4, arm.expiresAt, []);
  expect(claims).toHaveLength(1); expect(claims[0]!.waitId).toBe(due.waitId);
  expect(claims[0]!.receipt!.source).toBe("deadline");
  expect(f.port().get(address).receipt).toBeUndefined();
  f.store.events.complete(due.waitId, due.generation, claims[0]!.delivery!.attemptId!, { status: "accepted", reference: "native:deadline" }, arm.expiresAt + 1);
  const saved = f.port().get(due);
  expect(saved.state).toBe("ready"); expect(saved.delivery!.state).toBe("accepted");
  expect(eventReturnCurrent(f.core, eventReturnTarget(claims[0]!), eventEnvelope(claims[0]!))).toBe(false);
});

test("retained deadline notices do not starve later deadlines at the bounded expiry scan", () => {
  const f = fixture();
  for (let i = 0; i < 128; i++) f.port().arm({ ...arm, waitId: `deadline-${i}` });
  f.store.events.claim(1, arm.expiresAt, []);
  const other = f.core.events({ ...owner, taskId: "other-owner" });
  other.arm({ ...arm, waitId: "later-deadline", expiresAt: arm.expiresAt + 1 });
  const claims = f.store.events.claim(4, arm.expiresAt + 1, []);
  expect(claims.find((wait) => wait.waitId === "later-deadline")?.receipt?.source).toBe("deadline");
});

test("restarts retain waits and unknown sends; exact late acceptance refines only its own timed-out attempt", () => {
  const f = fixture(true); f.port().arm(arm); f.restart();
  f.store.events.signal(capability, signal, 1000);
  const attempt = f.store.events.claim(1, 1000, [])[0]!;
  expect(attempt.delivery?.state).toBe("sending");
  f.store.events.complete(address.waitId, address.generation, attempt.delivery!.attemptId!, { status: "unknown", code: "io_timeout" }, 1001);
  f.store.events.complete(address.waitId, address.generation, "wrong-attempt", { status: "accepted", reference: "native:wrong" }, 1002);
  expect(f.port().get(address).delivery?.state).toBe("unknown");
  f.store.events.complete(address.waitId, address.generation, attempt.delivery!.attemptId!, { status: "accepted", reference: "native:exact" }, 1002);
  expect(f.port().get(address).delivery?.reference).toBe("native:exact");
  f.restart(); expect(f.store.events.recover(1003)).toBe(0);
  expect(f.store.events.claim(1, 1003, [])).toEqual([]);
  expect(f.store.events.resumeHost(owner.hostId, 1003)).toBe(0);
  const second = { ...arm, waitId: "second-wait" }; f.port().arm(second);
  f.store.events.signal(capability, { ...signal, waitId: second.waitId }, 1003);
  f.store.events.claim(1, 1003, []); f.restart();
  expect(f.store.events.recover(1004)).toBe(1);
  expect(f.port().get(second).delivery?.code).toBe("receiver_restarted");
  expect(f.store.events.claim(1, 1004, [])).toEqual([]);
});

test("waits an earlier release stored as paused become deliverable at startup, while unknown sends remain unreplayed", () => {
  const f = fixture(true); f.port().arm(arm);
  f.store.events.signal(capability, signal, 1001);
  const waiting = { ...arm, waitId: "still-waiting" }, expired = { ...arm, waitId: "paused-expired", expiresAt: 1500 };
  f.port().arm(waiting); f.port().arm(expired);
  // Earlier releases wrote this state when the owner's turn changed; the current service never does.
  f.store.close();
  const db = new Database(join(f.directory, "store.sqlite"));
  for (const waitId of [address.waitId, waiting.waitId, expired.waitId]) db.run("UPDATE event_waits SET state='paused', data=json_set(data,'$.state','paused','$.reason','native_turn_changed') WHERE id=?", [waitId]);
  db.run("UPDATE event_waits SET data=json_set(data,'$.delivery.state','retired') WHERE id=?", [address.waitId]);
  db.close();
  f.reopen();
  expect(f.store.events.claim(1, 1002, [])).toEqual([]);
  expect(f.store.events.recover(2000)).toBe(0);
  expect(f.port().get(address).state).toBe("ready"); expect(f.port().get(address).reason).toBeUndefined();
  expect(f.port().get(waiting).state).toBe("waiting");
  // No result ever arrived for this one and its deadline passed while paused: it now reports that truthfully.
  expect(f.port().get(expired)).toMatchObject({ state: "ready", reason: "deadline_passed", receipt: { source: "deadline" }, delivery: { state: "queued" } });
  // One send per task at a time: the saved result first, the deadline notice after it settles.
  const attempt = f.store.events.claim(2, 2001, [])[0]!;
  expect(attempt.waitId).toBe(address.waitId); expect(attempt.receipt!.signal).toEqual(signal);
  expect(f.store.events.current(address, attempt.delivery!.id, attempt.version, 2001)).toBeDefined();
  f.store.events.complete(address.waitId, address.generation, attempt.delivery!.attemptId!, { status: "unknown", code: "native_uncertain" }, 2002);
  let saved = f.port().get(address);
  expect(saved.delivery?.state).toBe("unknown");
  const notice = f.store.events.claim(1, 2003, [])[0]!;
  expect(notice.waitId).toBe(expired.waitId); expect(notice.receipt!.source).toBe("deadline");
  f.store.events.complete(expired.waitId, expired.generation, notice.delivery!.attemptId!, { status: "accepted", reference: "native:deadline" }, 2003);
  expect(f.store.events.claim(1, 2003, [])).toEqual([]);
  f.setTime(2003);
  expect(() => f.port().clear(address, saved.version)).toThrow("Settle");
  const newer = f.core.events({ ...owner, turnId: "turn-two", callId: "call-two" });
  saved = newer.acknowledge(address, saved.version, saved.receipt!.id, "handled");
  expect(saved.receipt?.evidenceRef).toBe("fixture-events:task-one:turn-two:call-two");
  saved = newer.clear(address, saved.version);
  expect(saved.state).toBe("cleared"); expect(saved.receipt).toBeUndefined();
  expect(saved.owner).toEqual({ hostId: owner.hostId, taskId: owner.taskId });
  expect(Object.keys(saved).sort()).toEqual(["generation", "owner", "revision", "state", "updatedAt", "version", "waitId"].sort());
  expect(() => f.port().arm(arm)).toThrow("cleared");
  expect(() => f.store.events.signal(capability, signal, 2005)).toThrow("not accepted");
  // The still-waiting producer delivers to the task's current state without any reanchor.
  f.store.events.signal(capability, { ...signal, waitId: waiting.waitId, eventId: "later-release" }, 2006);
  const later = f.store.events.claim(1, 2006, [])[0]!;
  expect(later.waitId).toBe(waiting.waitId); expect(later.owner.turnId).toBe(owner.turnId);
});

test("bounded result/admission reject without displacing retained results", () => {
  const f = fixture();
  expect(() => f.port().arm({ ...arm, expiresAt: 1000 })).toThrow("future");
  f.port().arm(arm);
  expect(() => f.store.events.signal(capability, { ...signal, summary: "x".repeat(8193) }, 1000)).toThrow();
  expect(f.port().get(address).state).toBe("waiting");
  for (let i = 1; i < 128; i++) f.port().arm({ ...arm, waitId: `wait-${i}` });
  expect(() => f.port().arm({ ...arm, waitId: "overflow" })).toThrow("capacity");
  expect(f.port().get(address).title).toBe(arm.title);
});


test("event native authority fences exact receipt, version, target, cancellation and manager assignment", () => {
  const f = fixture(); f.core.bind(fixtureBinding);
  const nativeOwner = { hostId: fixtureBinding.origin.hostId, taskId: fixtureBinding.origin.managerId, turnId: "armed-turn", callId: "armed-call" };
  const port = f.core.events(nativeOwner); port.arm(arm); f.store.events.signal(capability, signal, 1000);
  const attempt = f.store.events.claim(1, 1000, [])[0]!, target = eventReturnTarget(attempt), envelope = eventEnvelope(attempt);
  expect(eventReturnCurrent(f.core, target, envelope)).toBe(true);
  expect(eventReturnCurrent(f.core, { ...target, origin: { ...target.origin, managerId: "wrong" } }, envelope)).toBe(false);
  expect(eventReturnCurrent(f.core, target, { ...envelope, event: { ...envelope.event, receiptId: "wrong" } })).toBe(false);
  expect(eventReturnCurrent(f.core, target, { ...envelope, event: { ...envelope.event, version: 1 } })).toBe(false);
  f.store.transfer(fixtureBinding.id, fixtureBinding.origin.generation, { ...fixtureBinding.origin, generation: fixtureBinding.origin.generation + 1 });
  expect(eventReturnCurrent(f.core, target, envelope)).toBe(false);
  expect(() => port.get(address)).toThrow("assignment changed");
  const successor = f.core.events(nativeOwner), saved = successor.get(address); successor.cancel(address, saved.version);
  expect(eventReturnCurrent(f.core, target, envelope)).toBe(false);
});


test("the existing version-six store upgrades atomically without replacing human exchanges", () => {
  const directory = mkdtempSync(join(tmpdir(), "seeker-event-migration-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "store.sqlite"), initial = new SqliteExchangeStore(path);
  try { const core = new SeekerCore(initial); core.bind(fixtureBinding); core.manager(fixtureBinding.origin).submit({ requestId: "retained-human-request", decision: fixtureDecision }); }
  finally { initial.close(); }
  // Removing only the new table reconstructs the unchanged predecessor schema.
  const legacy = new Database(path);
  try { legacy.run("DROP TABLE event_waits"); legacy.run("PRAGMA user_version=6"); }
  finally { legacy.close(); }
  const upgraded = new SqliteExchangeStore(path); cleanups.push(() => upgraded.close());
  expect(upgraded.get("retained-human-request")?.exchange.revisions[0]?.decision).toEqual(fixtureDecision);
  expect(new SeekerCore(upgraded, () => 1000).events(owner).arm(arm).state).toBe("waiting");
});

test("a watch is a wait Seeker itself settles: one observation of a failed or interrupted turn, quiet expiry, no producer signal", () => {
  const f = fixture(); f.setTime(1000);
  const watch = { waitId: "watch-lead", generation: "g-one", revision: "lead-one", title: "Lead one", expiresAt: 5000, threadId: "lead-task" };
  expect(() => f.port().watch({ ...watch, threadId: owner.taskId })).toThrow("cannot watch itself");
  const armed = f.port().watch(watch);
  expect(armed).toMatchObject({ state: "waiting", watch: { threadId: "lead-task" }, title: "Lead one" });
  expect(f.port().watch(watch).version).toBe(1);
  expect(() => f.port().watch({ ...watch, title: "renamed" })).toThrow("different content");
  expect(f.port().pending()[0]).toMatchObject({ waitId: "watch-lead", watch: { threadId: "lead-task" } });
  expect(f.store.events.watching(1001, 8).map((wait) => wait.waitId)).toEqual(["watch-lead"]);
  // A producer cannot signal a watch: it has no capability.
  expect(() => f.store.events.signal(capability, { waitId: watch.waitId, generation: watch.generation, revision: watch.revision, eventId: "e", outcome: "completed", summary: "s", evidenceRefs: [] }, 1002)).toThrow("not accepted");
  // Only failed or interrupted turns are observations, and an observation settles the watch.
  expect(() => f.store.events.observe(watch, { turnId: "t1", status: "completed" as never }, 1003)).toThrow("failed or interrupted");
  const observed = f.store.events.observe(watch, { turnId: "lead-turn-3", status: "interrupted" }, 1003)!;
  expect(observed.state).toBe("ready"); expect(observed.receipt).toMatchObject({ source: "watch", disposition: "pending", signal: { outcome: "failed", eventId: "watch:lead-turn-3:interrupted", evidenceRefs: ["codex:lead-task:lead-turn-3"] } });
  expect(observed.receipt!.signal.summary).toContain("was interrupted"); expect(observed.receipt!.signal.summary).toContain("sent it nothing");
  expect(f.store.events.observe(watch, { turnId: "lead-turn-4", status: "failed" }, 1004)).toBeUndefined();
  expect(f.store.events.watching(1004, 8)).toEqual([]);
  const attempt = f.store.events.claim(1, 1004, [])[0]!;
  expect(attempt.waitId).toBe("watch-lead");
  expect(eventReturnCurrent(f.core, eventReturnTarget(attempt), eventEnvelope(attempt))).toBe(true);
  f.store.events.complete("watch-lead", "g-one", attempt.delivery!.attemptId!, { status: "accepted", reference: "native:watch" }, 1005);
  let saved = f.port().get(watch);
  saved = f.port().acknowledge(watch, saved.version, saved.receipt!.id, "handled");
  expect(saved.state).toBe("handled");
  // A watch that reaches its expiry without an observation simply expires: no deadline notice, no delivery.
  const quiet = { ...watch, waitId: "watch-quiet" }; f.port().watch(quiet);
  f.setTime(5000);
  expect(f.store.events.claim(4, 5000, [])).toEqual([]);
  expect(f.port().get(quiet)).toMatchObject({ state: "expired", reason: "deadline_passed" });
  expect(f.port().get(quiet).receipt).toBeUndefined();
  expect(f.store.events.observe(quiet, { turnId: "late", status: "failed" }, 5001)).toBeUndefined();
  // A cancelled watch reports nothing either.
  const cancelled = { ...watch, waitId: "watch-cancelled", expiresAt: 9000 }; f.port().watch(cancelled);
  f.port().cancel(cancelled, 1);
  expect(f.store.events.observe(cancelled, { turnId: "t", status: "failed" }, 5002)).toBeUndefined();
  expect(f.store.events.watching(5002, 8)).toEqual([]);
});
