import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { eventEnvelope, eventReturnCurrent, eventReturnTarget } from "../src/core/event-return.ts";
import { Database } from "bun:sqlite";
import { fixtureBinding, fixtureDecision } from "../src/local/fixture.ts";
import { eventDigest } from "../src/core/events.ts";
import type { EventArm, EventOwner, EventSignal } from "../src/events.ts";
import { eventLimits, eventResult } from "../src/core/events.ts";
import { nativeWakeup } from "../src/hosts/codex/protocol.ts";

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
  // Store-level arming with a known key; the port's own arming prepares the key file (tested below).
  const armed = (input: EventArm, who: EventOwner = owner) => store.events.arm(who, input, now);
  return { directory, get store() { return store; }, get core() { return core; }, port, arm: armed, setTime: (value: number) => { now = value; },
    restart: () => { store.close(); store = new SqliteExchangeStore(join(directory, "store.sqlite")); core = new SeekerCore(store, () => now); },
    reopen: () => { store = new SqliteExchangeStore(join(directory, "store.sqlite")); core = new SeekerCore(store, () => now); },
  };
}

test("machine admission fixes the native owner, deduplicates exact signals and retains complete evidence", () => {
  const f = fixture(); const wait = f.arm(arm);
  expect(wait.state).toBe("waiting");
  expect(JSON.stringify(wait)).not.toContain(capability);
  expect(f.core.managerBinding(owner.hostId, owner.taskId)).toBeUndefined();
  expect(() => f.core.manager({ hostId: owner.hostId, managerId: owner.taskId, assignmentId: owner.taskId, generation: 1 })).toThrow();
  expect(f.arm({ ...arm })).toEqual(wait);
  const reordered = { capabilityDigest: arm.capabilityDigest, expiresAt: arm.expiresAt, title: arm.title, revision: arm.revision, generation: arm.generation, waitId: arm.waitId };
  expect(f.arm(reordered)).toEqual(wait);
  expect(() => f.arm({ ...arm, title: "Different wait" })).toThrow("different content");
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

test("cancellation revokes known-unsent work without evicting results, and a saved result outlives the deadline", () => {
  const f = fixture(); f.arm(arm); f.store.events.signal(capability, signal, 1000);
  let saved = f.port().get(address);
  expect(() => f.port().cancel(address, { expectedVersion: 1 })).toThrow("current wait");
  saved = f.port().cancel(address, { expectedVersion: saved.version });
  expect(saved.state).toBe("cancelled"); expect(saved.receipt?.signal).toEqual(signal);
  expect(f.store.events.claim(4, arm.expiresAt, [])).toEqual([]);
  expect(f.store.events.signal(capability, signal, arm.expiresAt).status).toBe("duplicate");
  // A result saved just before the deadline is delivered after it: the deadline ends only the waiting.
  const late = fixture(); late.arm(arm); late.store.events.signal(capability, signal, arm.expiresAt - 1);
  late.setTime(arm.expiresAt + 5000);
  expect(late.port().get(address).state).toBe("ready");
  const attempt = late.store.events.claim(4, arm.expiresAt + 5000, [])[0]!;
  expect(attempt.waitId).toBe(address.waitId); expect(attempt.receipt!.signal).toEqual(signal); expect(attempt.receipt!.source).toBeUndefined();
  late.store.events.complete(address.waitId, address.generation, attempt.delivery!.attemptId!, { status: "accepted", reference: "native:late" }, arm.expiresAt + 5001);
  expect(late.port().get(address).state).toBe("delivered");
  const g = fixture(); g.arm(arm); g.port().cancel(address, { expectedVersion: 1 });
  expect(() => g.store.events.signal(capability, signal, 1001)).toThrow("no longer accepts");
});

test("a missed deadline saves one truthful failure, rejects late producers and survives restart without replay", () => {
  for (const outcome of ["accepted", "unknown", "interrupted"] as const) {
    const f = fixture(true); f.arm(arm); f.restart(); f.setTime(arm.expiresAt);
    // A late signal can itself discover the deadline; rejection still commits its notice.
    expect(() => f.store.events.signal(capability, signal, arm.expiresAt)).toThrow("deadline passed");
    const saved = f.port().get(address);
    expect(saved.state).toBe("ready"); expect(saved.reason).toBe("deadline_passed");
    expect(saved.receipt).toMatchObject({ source: "deadline", disposition: "pending", recordedAt: arm.expiresAt,
      signal: { ...address, outcome: "failed", evidenceRefs: [] } });
    expect(saved.receipt!.signal.summary).toContain("Job completion is unknown");
    expect(f.arm(arm)).toEqual(saved);
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
    expect(current.receipt).toMatchObject({ ...saved.receipt, disposition: outcome === "accepted" ? "received" : "pending" });
    expect(current.delivery!.state).toBe(outcome === "accepted" ? "accepted" : "unknown");
    expect(current.state).toBe(outcome === "accepted" ? "delivered" : "ready");
    expect(f.store.events.claim(1, arm.expiresAt + 3000, [])).toEqual([]);
    current = f.port().acknowledge(address, "handled", { receiptId: current.receipt!.id, expectedVersion: current.version });
    expect(f.port().clear(address, { expectedVersion: current.version }).state).toBe("cleared");
  }
});

test("deadline discovery respects cancellation, and the pump creates a receipt without a reader", () => {
  const f = fixture(); f.arm(arm); f.port().cancel(address, { expectedVersion: 1 });
  const due = { ...arm, waitId: "pump-deadline" };
  f.arm(due);
  f.setTime(arm.expiresAt);
  const claims = f.store.events.claim(4, arm.expiresAt, []);
  expect(claims).toHaveLength(1); expect(claims[0]!.waitId).toBe(due.waitId);
  expect(claims[0]!.receipt!.source).toBe("deadline");
  expect(f.port().get(address).receipt).toBeUndefined();
  f.store.events.complete(due.waitId, due.generation, claims[0]!.delivery!.attemptId!, { status: "accepted", reference: "native:deadline" }, arm.expiresAt + 1);
  const saved = f.port().get(due);
  expect(saved.state).toBe("delivered"); expect(saved.delivery!.state).toBe("accepted"); expect(saved.receipt!.disposition).toBe("received");
  expect(eventReturnCurrent(f.core, eventReturnTarget(claims[0]!), eventEnvelope(claims[0]!))).toBe(false);
});

test("retained deadline notices do not starve later deadlines at the bounded expiry scan", () => {
  const f = fixture();
  for (let i = 0; i < 128; i++) f.arm({ ...arm, waitId: `deadline-${i}` });
  f.store.events.claim(1, arm.expiresAt, []);
  f.arm({ ...arm, waitId: "later-deadline", expiresAt: arm.expiresAt + 1 }, { ...owner, taskId: "other-owner" });
  const claims = f.store.events.claim(4, arm.expiresAt + 1, []);
  expect(claims.find((wait) => wait.waitId === "later-deadline")?.receipt?.source).toBe("deadline");
});

test("restarts retain waits and unknown sends; exact late acceptance refines only its own timed-out attempt", () => {
  const f = fixture(true); f.arm(arm); f.restart();
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
  const second = { ...arm, waitId: "second-wait" }; f.arm(second);
  f.store.events.signal(capability, { ...signal, waitId: second.waitId }, 1003);
  f.store.events.claim(1, 1003, []); f.restart();
  expect(f.store.events.recover(1004)).toBe(1);
  expect(f.port().get(second).delivery?.code).toBe("receiver_restarted");
  expect(f.store.events.claim(1, 1004, [])).toEqual([]);
});

test("waits an earlier release stored as paused become deliverable at startup, while unknown sends remain unreplayed", () => {
  const f = fixture(true); f.arm(arm);
  f.store.events.signal(capability, signal, 1001);
  const waiting = { ...arm, waitId: "still-waiting" }, expired = { ...arm, waitId: "paused-expired", expiresAt: 1500 };
  f.arm(waiting); f.arm(expired);
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
  expect(() => f.port().clear(address, { expectedVersion: saved.version })).toThrow("Settle");
  const newer = f.core.events({ ...owner, turnId: "turn-two", callId: "call-two" });
  saved = newer.acknowledge(address, "handled", { receiptId: saved.receipt!.id, expectedVersion: saved.version });
  expect(saved.receipt?.evidenceRef).toBe("fixture-events:task-one:turn-two:call-two");
  saved = newer.clear(address, { expectedVersion: saved.version });
  expect(saved.state).toBe("cleared"); expect(saved.receipt).toBeUndefined();
  expect(saved.owner).toEqual({ hostId: owner.hostId, taskId: owner.taskId });
  expect(Object.keys(saved).sort()).toEqual(["generation", "owner", "revision", "state", "updatedAt", "version", "waitId"].sort());
  expect(() => f.arm(arm)).toThrow("cleared");
  expect(() => f.store.events.signal(capability, signal, 2005)).toThrow("not accepted");
  // The still-waiting producer delivers to the task's current state without any reanchor.
  f.store.events.signal(capability, { ...signal, waitId: waiting.waitId, eventId: "later-release" }, 2006);
  const later = f.store.events.claim(1, 2006, [])[0]!;
  expect(later.waitId).toBe(waiting.waitId); expect(later.owner.turnId).toBe(owner.turnId);
});

test("bounded result/admission reject without displacing retained results", () => {
  const f = fixture();
  expect(() => f.arm({ ...arm, expiresAt: 1000 })).toThrow("future");
  f.arm(arm);
  expect(() => f.store.events.signal(capability, { ...signal, summary: "x".repeat(8193) }, 1000)).toThrow();
  expect(f.port().get(address).state).toBe("waiting");
  for (let i = 1; i < 128; i++) f.arm({ ...arm, waitId: `wait-${i}` });
  expect(() => f.arm({ ...arm, waitId: "overflow" })).toThrow("capacity");
  expect(f.port().get(address).title).toBe(arm.title);
});


test("event native authority fences exact receipt, version, target, cancellation and manager assignment", () => {
  const f = fixture(); f.core.bind(fixtureBinding);
  const nativeOwner = { hostId: fixtureBinding.origin.hostId, taskId: fixtureBinding.origin.managerId, turnId: "armed-turn", callId: "armed-call" };
  const port = f.core.events(nativeOwner); f.arm(arm, { ...nativeOwner, bindingId: fixtureBinding.id, ownerGeneration: fixtureBinding.origin.generation }); f.store.events.signal(capability, signal, 1000);
  const attempt = f.store.events.claim(1, 1000, [])[0]!, target = eventReturnTarget(attempt), envelope = eventEnvelope(attempt);
  expect(eventReturnCurrent(f.core, target, envelope)).toBe(true);
  expect(eventReturnCurrent(f.core, { ...target, origin: { ...target.origin, managerId: "wrong" } }, envelope)).toBe(false);
  expect(eventReturnCurrent(f.core, target, { ...envelope, event: { ...envelope.event, receiptId: "wrong" } })).toBe(false);
  expect(eventReturnCurrent(f.core, target, { ...envelope, event: { ...envelope.event, version: 1 } })).toBe(false);
  f.store.transfer(fixtureBinding.id, fixtureBinding.origin.generation, { ...fixtureBinding.origin, generation: fixtureBinding.origin.generation + 1 });
  expect(eventReturnCurrent(f.core, target, envelope)).toBe(false);
  expect(() => port.get(address)).toThrow("assignment changed");
  const successor = f.core.events(nativeOwner), saved = successor.get(address); successor.cancel(address, { expectedVersion: saved.version });
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
  expect(upgraded.events.arm(owner, arm, 1000).state).toBe("waiting");
});

test("a watch is a wait Seeker itself settles: one observation of an ending it reports, quiet expiry, no producer signal", async () => {
  const f = fixture(); f.setTime(1000);
  const watch = { waitId: "watch-lead", title: "Lead one", expiresAt: 5000, threadId: "lead-task" };
  await expect(f.port().watch({ ...watch, threadId: owner.taskId })).rejects.toThrow("cannot watch itself");
  await expect(f.port().watch({ ...watch, on: [] })).rejects.toThrow("which turn endings");
  await expect(f.port().watch({ ...watch, on: ["aborted" as never] })).rejects.toThrow("which turn endings");
  const armed = await f.port().watch(watch);
  expect(armed).toMatchObject({ state: "waiting", watch: { threadId: "lead-task", on: ["failed", "interrupted"] }, title: "Lead one" });
  expect(armed.generation).toMatch(/^[0-9a-f-]{36}$/);
  expect((await f.port().watch(watch)).version).toBe(1);
  await expect(f.port().watch({ ...watch, title: "renamed" })).rejects.toThrow("different content");
  expect(f.port().pending()[0]).toMatchObject({ waitId: "watch-lead", watch: { threadId: "lead-task" } });
  expect(f.store.events.watching(1001).map((wait) => wait.waitId)).toEqual(["watch-lead"]);
  // A producer cannot signal a watch: it has no capability.
  expect(() => f.store.events.signal(capability, { waitId: watch.waitId, generation: armed.generation, revision: armed.revision, eventId: "e", outcome: "completed", summary: "s", evidenceRefs: [] }, 1002)).toThrow("not accepted");
  // A completed turn is not an observation for this watch; the first reported ending settles it.
  expect(() => f.store.events.observe(watch, { turnId: "t1", status: "aborted" as never }, 1003)).toThrow("in progress, completed, failed or interrupted");
  expect(f.store.events.observe({ waitId: "watch-lead" }, { turnId: "t1", status: "completed", completedAt: 1003 }, 1003)).toBeUndefined();
  const observed = f.store.events.observe({ waitId: "watch-lead" }, { turnId: "lead-turn-3", status: "interrupted", completedAt: 1003 }, 1003)!;
  expect(observed.state).toBe("ready"); expect(observed.receipt).toMatchObject({ source: "watch", disposition: "pending", signal: { outcome: "failed", eventId: "watch:lead-turn-3:interrupted", evidenceRefs: ["codex:lead-task:lead-turn-3"] } });
  expect(observed.receipt!.signal.summary).toContain("was interrupted"); expect(observed.receipt!.signal.summary).toContain("sent it nothing");
  expect(f.store.events.observe({ waitId: "watch-lead" }, { turnId: "lead-turn-4", status: "failed", completedAt: 1004 }, 1004)).toBeUndefined();
  expect(() => f.store.events.observe({ waitId: "watch-lead", generation: "other" }, { turnId: "x", status: "failed" }, 1004)).toThrow("generation");
  expect(f.store.events.watching(1004)).toEqual([]);
  const attempt = f.store.events.claim(1, 1004, [])[0]!;
  expect(attempt.waitId).toBe("watch-lead");
  expect(eventReturnCurrent(f.core, eventReturnTarget(attempt), eventEnvelope(attempt))).toBe(true);
  expect(eventEnvelope(attempt).event.result).toMatchObject({ title: "Lead one", source: "watch", outcome: "failed", evidenceRefs: ["codex:lead-task:lead-turn-3"] });
  f.store.events.complete("watch-lead", attempt.generation, attempt.delivery!.attemptId!, { status: "accepted", reference: "native:watch" }, 1005);
  expect(f.port().get({ waitId: "watch-lead" }).state).toBe("delivered");
  expect(f.port().acknowledge({ waitId: "watch-lead" }, "handled").state).toBe("handled");
  // A watch armed for completion reports the completed turn, as a completed outcome.
  const done = await f.port().watch({ waitId: "watch-done", title: "Lead two", expiresAt: 5000, threadId: "lead-two", on: ["completed", "interrupted", "failed"] });
  expect(done.watch).toEqual({ threadId: "lead-two", on: ["completed", "failed", "interrupted"] });
  const finished = f.store.events.observe({ waitId: "watch-done" }, { turnId: "two-7", status: "completed", completedAt: 1006 }, 1006)!;
  expect(finished.receipt!.signal).toMatchObject({ outcome: "completed", eventId: "watch:two-7:completed" });
  expect(finished.receipt!.signal.summary).toContain("turn two-7 completed");
  // A watch that reaches its expiry without an observation simply expires: no deadline notice, no delivery.
  const quiet = { ...watch, waitId: "watch-quiet" }; await f.port().watch(quiet);
  f.setTime(5000);
  expect(f.store.events.claim(4, 5000, []).map((wait) => wait.waitId)).toEqual(["watch-done"]);
  expect(f.port().get(quiet)).toMatchObject({ state: "expired", reason: "deadline_passed" });
  expect(f.port().get(quiet).receipt).toBeUndefined();
  expect(f.store.events.observe(quiet, { turnId: "late", status: "failed", completedAt: 5001 }, 5001)).toBeUndefined();
  // A cancelled watch reports nothing either.
  const cancelled = { ...watch, waitId: "watch-cancelled", expiresAt: 9000 }; await f.port().watch(cancelled);
  f.port().cancel(cancelled);
  expect(f.store.events.observe(cancelled, { turnId: "t", status: "failed", completedAt: 5002 }, 5002)).toBeUndefined();
  expect(f.store.events.watching(5002)).toEqual([]);
});

test("observed watches neither starve the expiry scan nor skip their retry delay, and every watch is read", async () => {
  const f = fixture(); f.setTime(1000);
  for (let i = 0; i < 40; i++) await f.port().watch({ waitId: `watch-${i}`, title: "lead", expiresAt: 2000, threadId: `lead-${i}` });
  expect(f.store.events.watching(1001)).toHaveLength(40);
  // Observed, delivered with a retry, then past expiry: the retry waits its delay and the ordinary deadline still fires.
  f.store.events.observe({ waitId: "watch-0" }, { turnId: "t", status: "failed", completedAt: 1002 }, 1002);
  const attempt = f.store.events.claim(1, 1002, [])[0]!;
  expect(attempt.waitId).toBe("watch-0");
  f.store.events.complete("watch-0", attempt.generation, attempt.delivery!.attemptId!, { status: "retry", code: "desktop_connector_unavailable", retryAfterMs: 60_000 }, 1003);
  f.arm({ ...arm, waitId: "ordinary-deadline", expiresAt: 2000 });
  f.setTime(2001);
  const claims = f.store.events.claim(4, 2001, []);
  expect(claims.map((wait) => wait.waitId)).toEqual(["ordinary-deadline"]);
  expect(claims[0]!.receipt!.source).toBe("deadline");
  expect(f.port().get({ waitId: "watch-0" })).toMatchObject({ state: "ready", delivery: { state: "retry" } });
  expect(f.store.events.claim(4, 61_003, []).map((wait) => wait.waitId)).toEqual(["watch-0"]);
  expect(f.store.events.watching(2001)).toEqual([]);
});

test("the port arms a wait in one call: it prepares the private key file and returns the wait without the key", () => {
  const f = fixture(); f.setTime(1000);
  // With a key directory, a title and an expiry are the whole call: the key goes under Seeker's home and leaves with the record.
  expect(() => f.port().arm({ title: "Release", expiresAt: 5000 })).toThrow("no key directory");
  const keyed = new SeekerCore(f.store, () => 1000, { keyDirectory: join(f.directory, "keys") }).events(owner);
  const placed = keyed.arm({ title: "Release", expiresAt: 5000 });
  expect(placed.capabilityFile).toBe(join(f.directory, "keys", `${placed.waitId}.json`));
  expect(statSync(join(f.directory, "keys")).mode & 0o777).toBe(0o700); expect(statSync(placed.capabilityFile).mode & 0o777).toBe(0o600);
  expect(placed).not.toHaveProperty("keyFile"); expect(JSON.stringify(keyed.get({ waitId: placed.waitId }))).not.toContain("keyFile");
  expect(keyed.arm({ title: "Release", expiresAt: 5000, waitId: placed.waitId })).toEqual(placed);
  // A refused arm leaves no key behind; the key of an existing wait is untouched by a retry the store refuses.
  for (let i = 0; i < 127; i++) f.arm({ ...arm, waitId: `open-${i}`, expiresAt: 5000 });
  expect(() => keyed.arm({ title: "Overflow", expiresAt: 5000 })).toThrow("capacity");
  expect(() => keyed.arm({ title: "Renamed", expiresAt: 5000, waitId: placed.waitId })).toThrow("different content");
  expect(readdirSync(join(f.directory, "keys"))).toEqual([`${placed.waitId}.json`]);
  keyed.cancel({ waitId: placed.waitId }); keyed.clear({ waitId: placed.waitId });
  expect(() => statSync(placed.capabilityFile)).toThrow();
  // A task-chosen path is prepared at that path and stays the task's file.
  const capabilityFile = join(f.directory, "release.json");
  expect(() => f.port().arm({ title: "Release", expiresAt: 5000, capabilityFile: "relative.json" })).toThrow("absolute path");
  expect(() => f.port().arm({ title: "Release", expiresAt: 5000, capabilityFile: join(f.directory, "missing", "key.json") })).toThrow("does not exist");
  expect(() => f.port().arm({ title: "Release", expiresAt: 999, capabilityFile })).toThrow("future");
  const wait = f.port().arm({ title: "Release", expiresAt: 5000, capabilityFile });
  expect(wait).toMatchObject({ state: "waiting", title: "Release", revision: "unversioned", capabilityFile });
  expect(wait.waitId).toMatch(/^wait-/); expect(wait.generation).toMatch(/^[0-9a-f-]{36}$/);
  const key = JSON.parse(readFileSync(capabilityFile, "utf8"));
  expect(statSync(capabilityFile).mode & 0o777).toBe(0o600);
  expect(key).toMatchObject({ waitId: wait.waitId, generation: wait.generation, revision: "unversioned" });
  expect(JSON.stringify(wait)).not.toContain(key.capability);
  expect(JSON.stringify(f.port().get({ waitId: wait.waitId }))).not.toContain(key.capability);
  // The same path arms the same wait again; a different wait under that path is refused.
  expect(f.port().arm({ title: "Release", expiresAt: 5000, capabilityFile })).toEqual(wait);
  expect(() => f.port().arm({ title: "Other", expiresAt: 5000, capabilityFile })).toThrow("different content");
  expect(() => f.port().arm({ title: "Release", expiresAt: 5000, capabilityFile, revision: "v2" })).toThrow("different wait");
  f.port().cancel({ waitId: wait.waitId }); f.port().clear({ waitId: wait.waitId });
  expect(statSync(capabilityFile).isFile()).toBe(true);
  // A chosen identity and revision are kept, and the key the service wrote signals the wait.
  const chosen = f.port().arm({ title: "Build", expiresAt: 5000, capabilityFile: join(f.directory, "build.json"), waitId: "build-7", revision: "sha-7" });
  expect(chosen).toMatchObject({ waitId: "build-7", revision: "sha-7" });
  const buildKey = JSON.parse(readFileSync(join(f.directory, "build.json"), "utf8")).capability as string;
  expect(f.store.events.signal(buildKey, { waitId: "build-7", generation: chosen.generation, revision: "sha-7", eventId: "b", outcome: "completed", summary: "Built.", evidenceRefs: [] }, 1001).status).toBe("recorded");
  expect(f.port().get({ waitId: "build-7" }).state).toBe("ready");
});

test("a confirmed delivery settles the wait: nothing to acknowledge, not pending, cleared by retention a day later", () => {
  const f = fixture(true); f.setTime(1000); f.arm(arm);
  const refs = [signal.evidenceRefs[0]!, `file:///${"x".repeat(990)}`];
  f.store.events.signal(capability, { ...signal, evidenceRefs: refs }, 1000);
  const attempt = f.store.events.claim(1, 1000, [])[0]!;
  // The notice carries every reference complete; only the summary is bounded.
  expect(eventEnvelope(attempt).event.result).toEqual({ title: arm.title, outcome: "released", summary: signal.summary, evidenceRefs: refs });
  f.store.events.complete(address.waitId, address.generation, attempt.delivery!.attemptId!, { status: "accepted", reference: "native:one" }, 1001);
  let saved = f.port().get({ waitId: address.waitId });
  expect(saved).toMatchObject({ state: "delivered", receipt: { disposition: "received", evidenceRef: "native:one" }, delivery: { state: "accepted" } });
  expect(f.port().pending()).toEqual([]);
  // Its expiry passing changes nothing: the result reached the task.
  f.setTime(arm.expiresAt + 1); expect(f.store.events.claim(4, arm.expiresAt + 1, [])).toEqual([]);
  expect(f.port().get({ waitId: address.waitId }).state).toBe("delivered");
  // Acknowledging is optional and still recorded; cancelling a settled wait changes nothing.
  expect(f.port().cancel({ waitId: address.waitId }).state).toBe("delivered");
  saved = f.port().acknowledge({ waitId: address.waitId }, "handled");
  expect(saved.state).toBe("handled"); expect(saved.receipt!.disposition).toBe("handled");
  expect(() => f.port().acknowledge({ waitId: address.waitId }, "received", { receiptId: "other" })).toThrow("not its own");
  // Settled waits leave capacity: a full task can keep arming once its waits settle.
  for (let i = 0; i < 128; i++) f.arm({ ...arm, waitId: `open-${i}`, expiresAt: arm.expiresAt + 2 * eventLimits.retainedMs });
  expect(() => f.arm({ ...arm, waitId: "overflow", expiresAt: arm.expiresAt + 2 * eventLimits.retainedMs })).toThrow("capacity");
  // Retention: a day after settling, the service clears the record on its own; unsettled waits stay.
  const settledAt = saved.updatedAt;
  f.store.events.claim(4, settledAt + eventLimits.retainedMs - 1, []);
  expect(f.port().get({ waitId: address.waitId }).state).toBe("handled");
  f.store.events.claim(4, settledAt + eventLimits.retainedMs, []);
  const cleared = f.port().get({ waitId: address.waitId });
  expect(cleared.state).toBe("cleared"); expect(cleared.receipt).toBeUndefined();
  expect(f.port().get({ waitId: "open-0" }).state).toBe("waiting");
  // Cancelling frees capacity at once. Retention survives restart, and an unknown delivery is never cleared until the task reconciles it.
  expect(f.port().cancel({ waitId: "open-0" }).state).toBe("cancelled");
  const unknown = { ...arm, waitId: "unknown-send", expiresAt: settledAt + 10 * eventLimits.retainedMs }; f.arm(unknown);
  f.store.events.signal(capability, { ...signal, waitId: unknown.waitId }, settledAt + eventLimits.retainedMs);
  const sent = f.store.events.claim(1, settledAt + eventLimits.retainedMs, [])[0]!;
  f.store.events.complete(unknown.waitId, unknown.generation, sent.delivery!.attemptId!, { status: "unknown", code: "native_timeout" }, settledAt + eventLimits.retainedMs);
  f.restart();
  f.store.events.claim(4, settledAt + 3 * eventLimits.retainedMs, []);
  expect(f.port().get({ waitId: unknown.waitId })).toMatchObject({ state: "ready", delivery: { state: "unknown" } });
  expect(f.port().pending().map((wait) => wait.waitId)).toContain(unknown.waitId);
  expect(() => f.port().clear({ waitId: unknown.waitId })).toThrow("Settle");
  expect(f.port().acknowledge({ waitId: unknown.waitId }, "handled").state).toBe("handled");
  expect(f.port().clear({ waitId: unknown.waitId }).state).toBe("cleared");
});

test("rows that may not be cleared yet never hold retention back for the rest", async () => {
  const f = fixture(); f.setTime(1000);
  // 129 cancelled waits with an unknown send each: older than the one clearable wait, and never clearable until acknowledged.
  for (let i = 0; i < 129; i++) {
    const stuck = { ...arm, waitId: `stuck-${i}`, expiresAt: 10 * eventLimits.retainedMs }; f.arm(stuck);
    f.store.events.signal(capability, { ...signal, waitId: stuck.waitId }, 1000 + i);
    const sent = f.store.events.claim(1, 1000 + i, [])[0]!;
    expect(sent.waitId).toBe(stuck.waitId);
    f.store.events.complete(stuck.waitId, stuck.generation, sent.delivery!.attemptId!, { status: "unknown", code: "native_timeout" }, 1000 + i);
    f.port().cancel({ waitId: stuck.waitId });
  }
  const done = { ...arm, waitId: "done", expiresAt: 10 * eventLimits.retainedMs }; f.arm(done);
  f.store.events.signal(capability, { ...signal, waitId: done.waitId }, 2000);
  const sent = f.store.events.claim(1, 2000, [])[0]!;
  f.store.events.complete(done.waitId, done.generation, sent.delivery!.attemptId!, { status: "accepted", reference: "native:done" }, 2000);
  // Settled without ever having a delivery: cancelled before a result, and a watch that expired quietly.
  f.setTime(2000); f.arm({ ...arm, waitId: "never-signalled", expiresAt: 10 * eventLimits.retainedMs }); f.port().cancel({ waitId: "never-signalled" });
  await f.port().watch({ waitId: "quiet-watch", title: "quiet", expiresAt: 3000, threadId: "someone" });
  f.setTime(3000); expect(f.port().get({ waitId: "quiet-watch" }).state).toBe("expired");
  f.store.events.claim(4, 3000 + eventLimits.retainedMs, []);
  for (const waitId of ["done", "never-signalled", "quiet-watch"]) expect(f.port().get({ waitId }).state).toBe("cleared");
  expect(f.port().get({ waitId: "stuck-0" })).toMatchObject({ state: "cancelled", delivery: { state: "unknown" } });
  // Once acknowledged, a stuck row clears at the next pass.
  f.port().acknowledge({ waitId: "stuck-0" }, "handled");
  f.store.events.claim(4, 3000 + eventLimits.retainedMs, []);
  expect(f.port().get({ waitId: "stuck-0" }).state).toBe("cleared");
});

test("keys Seeker placed follow the key directory when the state moves", () => {
  const f = fixture(true); f.setTime(1000);
  const before = join(f.directory, "keys-before"), after = join(f.directory, "keys-after");
  const wait = new SeekerCore(f.store, () => 1000, { keyDirectory: before }).events(owner).arm({ title: "Moved", expiresAt: 5000 });
  expect(wait.capabilityFile).toBe(join(before, `${wait.waitId}.json`));
  f.store.close(); renameSync(before, after); f.reopen();
  const moved = new SeekerCore(f.store, () => 1000, { keyDirectory: after }).events(owner);
  moved.cancel({ waitId: wait.waitId }); moved.clear({ waitId: wait.waitId });
  expect(readdirSync(after)).toEqual([]);
});

test("a store from the release before retention keeps its settled waits for one retention period after the upgrade", () => {
  const f = fixture(true); f.setTime(1000); f.arm(arm);
  f.store.events.signal(capability, signal, 1000);
  f.port().acknowledge(address, "handled");
  f.store.close();
  const db = new Database(join(f.directory, "store.sqlite"));
  db.run("UPDATE event_waits SET next_at=json_extract(data,'$.expiresAt') WHERE id=?", [address.waitId]);
  db.run("PRAGMA user_version=7");
  db.close();
  const before = Date.now();
  f.reopen();
  // Its old next_at (the expiry, long past) would have cleared it at once; the upgrade gave it a full retention period instead.
  f.store.events.claim(4, before + eventLimits.retainedMs - 1, []);
  expect(f.port().get(address).state).toBe("handled");
  f.store.events.claim(4, Date.now() + eventLimits.retainedMs + 1, []);
  expect(f.port().get(address).state).toBe("cleared");
});

test("arming a watch reads where the task stands, so an ending from before the watch is old news and a running turn is reported when it ends", async () => {
  const f = fixture(); f.setTime(1000);
  const reads: { hostId: string; taskId: string; threadId: string }[] = [];
  let state: { taskId: string; turnId: string; status: "inProgress" | "completed" | "failed" | "interrupted" } | undefined = { taskId: "lead", turnId: "old", status: "failed" };
  f.core.threadReader = async (reader, threadId) => { reads.push({ hostId: reader.hostId, taskId: reader.taskId, threadId }); return state; };
  const armed = await f.port().watch({ waitId: "w-ended", title: "ended", expiresAt: 9000, threadId: "lead" });
  expect(reads).toEqual([{ hostId: owner.hostId, taskId: owner.taskId, threadId: "lead" }]);
  expect(armed.watch).toEqual({ threadId: "lead", on: ["failed", "interrupted"], seen: { turnId: "old", status: "failed" } });
  // The same ended turn, read again later without a completion time, is not an observation; a newer turn is.
  expect(f.store.events.observe({ waitId: "w-ended" }, { turnId: "old", status: "failed" }, 1500)).toBeUndefined();
  expect(f.store.events.observe({ waitId: "w-ended" }, { turnId: "next", status: "failed" }, 1600)!.state).toBe("ready");
  // A turn running when the watch was armed is reported when it ends, even without a completion time.
  state = { taskId: "lead", turnId: "running", status: "inProgress" };
  const running = await f.port().watch({ waitId: "w-running", title: "running", expiresAt: 9000, threadId: "lead" });
  expect(running.watch!.seen).toEqual({ turnId: "running", status: "inProgress" });
  expect(f.store.events.observe({ waitId: "w-running" }, { turnId: "running", status: "interrupted" }, 1700)!.state).toBe("ready");
  // The request's signal reaches the read; a request that ended before the read answered arms nothing.
  const ended = new AbortController(); let readSignal: AbortSignal | undefined;
  f.core.threadReader = async (_reader, _threadId, signal) => { readSignal = signal; ended.abort(); return undefined; };
  await expect(f.port().watch({ waitId: "w-ended-request", title: "late", expiresAt: 9000, threadId: "lead" }, ended.signal)).rejects.toThrow("request ended");
  expect(readSignal).toBe(ended.signal);
  expect(() => f.port().get({ waitId: "w-ended-request" })).toThrow("not found");
  f.core.threadReader = async () => state;
  // When the host cannot say where the task stands, the watch is armed without a baseline and the later rules apply.
  state = undefined;
  const blind = await f.port().watch({ waitId: "w-blind", title: "blind", expiresAt: 9000, threadId: "lead" });
  expect(blind.watch!.seen).toBeUndefined();
  expect(f.store.events.observe({ waitId: "w-blind" }, { turnId: "whatever", status: "failed", completedAt: 1800 }, 1800)!.state).toBe("ready");
});

test("a wait id with a colon arms with a key Seeker places, and a notice never outgrows the native input limit", () => {
  const f = fixture(); f.setTime(1000);
  const keyed = new SeekerCore(f.store, () => 1000, { keyDirectory: join(f.directory, "keys") }).events(owner);
  const wait = keyed.arm({ title: "Build", expiresAt: 5000, waitId: "build:release" });
  expect(wait.capabilityFile).toBe(join(f.directory, "keys", "build:release.json"));
  // The largest result the store accepts: a long summary of multibyte text and eight 1000-character references.
  const key = JSON.parse(readFileSync(wait.capabilityFile, "utf8")).capability as string;
  const refs = Array.from({ length: 8 }, (_, i) => `file:///${String(i)}${"é".repeat(990)}`);
  const signal = { waitId: "build:release", generation: wait.generation, revision: wait.revision, eventId: "big", outcome: "completed" as const, summary: "x".repeat(200), evidenceRefs: refs };
  expect(Buffer.byteLength(JSON.stringify(signal))).toBeLessThanOrEqual(eventLimits.resultBytes);
  f.store.events.signal(key, signal, 1001);
  const attempt = f.store.events.claim(1, 1001, [])[0]!;
  const { result } = eventEnvelope(attempt).event;
  expect(result.summary).toBe(signal.summary);
  expect(result.evidenceRefs).toEqual(refs);
  // A long multibyte summary is cut by bytes, not only by characters.
  const bounded = eventResult({ ...attempt, receipt: { ...attempt.receipt!, signal: { ...attempt.receipt!.signal, summary: "é".repeat(2500) } } });
  expect(bounded.summary.endsWith("(truncated; the full summary is in the saved record)")).toBe(true);
  expect(Buffer.byteLength(bounded.summary)).toBeLessThanOrEqual(eventLimits.noticeSummaryBytes + 100);
  // Every reference is in the notice, complete, and the notice stays within what the native input path admits.
  const notice = nativeWakeup({ attemptId: "x", binding: eventReturnTarget(attempt), envelope: eventEnvelope(attempt) });
  for (const ref of refs) expect(notice).toContain(ref);
  expect(Buffer.byteLength(notice)).toBeLessThanOrEqual(eventLimits.noticeBytes);
});
