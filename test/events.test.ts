import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { eventEnvelope, eventReturnCurrent, eventReturnTarget } from "../src/core/event-return.ts";
import { Database } from "bun:sqlite";
import { parseNativeEventState, eventAnchorState } from "../src/hosts/codex/event-state.ts";
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
  return { get store() { return store; }, get core() { return core; }, port, setTime: (value: number) => { now = value; },
    restart: () => { store.close(); store = new SqliteExchangeStore(join(directory, "store.sqlite")); core = new SeekerCore(store, () => now); },
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
    expect(() => f.port().resume(address, saved.version)).toThrow("closed");
  }
  const f = fixture(); f.port().arm(arm); f.port().cancel(address, 1);
  expect(() => f.store.events.signal(capability, signal, 1001)).toThrow("no longer accepts");
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

test("newer native activity pauses results for explicit owner resume, while unknown sends remain unreplayed", () => {
  const f = fixture(); f.port().arm(arm);
  f.store.events.pause(address, 1, "native_turn_changed", 1000);
  f.store.events.signal(capability, signal, 1001);
  expect(f.store.events.claim(1, 1001, [])).toEqual([]);
  let saved = f.port().get(address);
  const newer = f.core.events({ ...owner, turnId: "turn-two", callId: "call-two" });
  saved = newer.resume(address, saved.version);
  expect(saved.owner.turnId).toBe("turn-two");
  const attempt = f.store.events.claim(1, 1002, [])[0]!;
  expect(f.store.events.current(address, attempt.delivery!.id, attempt.version, 1002)).toBeDefined();
  f.store.events.complete(address.waitId, address.generation, attempt.delivery!.attemptId!, { status: "unknown", code: "native_uncertain" }, 1003);
  f.store.events.pause(address, attempt.version, "native_turn_changed", 1003);
  saved = newer.get(address); saved = newer.resume(address, saved.version);
  expect(saved.delivery?.state).toBe("unknown");
  expect(f.store.events.claim(1, 1004, [])).toEqual([]);
  expect(() => newer.clear(address, saved.version)).toThrow("Settle");
  saved = newer.acknowledge(address, saved.version, saved.receipt!.id, "handled");
  expect(saved.receipt?.evidenceRef).toBe("fixture-events:task-one:turn-two:call-two");
  saved = newer.clear(address, saved.version);
  expect(saved.state).toBe("cleared"); expect(saved.receipt).toBeUndefined();
  expect(saved.owner).toEqual({ hostId: owner.hostId, taskId: owner.taskId });
  expect(saved.title).toBeUndefined(); expect(saved.expiresAt).toBeUndefined();
  expect(Object.keys(saved).sort()).toEqual(["generation", "owner", "revision", "state", "updatedAt", "version", "waitId"].sort());
  expect(() => f.port().arm(arm)).toThrow("cleared");
  expect(() => f.store.events.signal(capability, signal, 1005)).toThrow("not accepted");
  // A separate event wake can advance the owner while another producer is still running.
  const waiting = { ...arm, waitId: "still-waiting" };
  f.port().arm(waiting);
  const reanchored = newer.resume(waiting, 1);
  expect(reanchored.state).toBe("waiting");
  expect(reanchored.owner.turnId).toBe("turn-two");
  f.store.events.signal(capability, { ...signal, waitId: waiting.waitId, eventId: "later-release" }, 1006);
  const later = f.store.events.claim(1, 1006, [])[0]!;
  expect(later.waitId).toBe(waiting.waitId);
  expect(later.generation).toBe(waiting.generation);
  expect(later.revision).toBe(waiting.revision);
  expect(later.owner.turnId).toBe("turn-two");
  const newest = f.core.events({ ...owner, turnId: "turn-three", callId: "call-three" });
  const fresh = newest.resume(waiting, later.version);
  f.store.events.pause(waiting, later.version, "native_turn_changed", 1007);
  expect(newest.get(waiting).state).toBe("ready");
  f.store.events.complete(waiting.waitId, waiting.generation, later.delivery!.attemptId!, { status: "rejected", code: "old_anchor_changed" }, 1007);
  const renewed = f.store.events.claim(1, 1007, [])[0]!;
  expect(renewed.version).toBe(fresh.version);
  expect(renewed.delivery!.id === later.delivery!.id).toBe(false);
  expect(renewed.owner.turnId).toBe("turn-three");
  expect(renewed.receipt!.id).toBe(later.receipt!.id);
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

test("native event metadata classifies original completion, active work, newer turns and interruption without forwarding content", () => {
  const response = (status: string, turnId = "armed-turn") => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ schemaVersion: 1, thread: { id: "task-one", kind: "codex", preview: "Untrusted task preview" }, page: { order: "newest_first" }, turns: [{ id: turnId, status, items: [{ text: "Untrusted output" }] }] }) }] });
  for (const [status, expected] of [["completed", "ready"], ["inProgress", "active"], ["interrupted", "stopped"], ["failed", "stopped"]] as const) {
    const state = parseNativeEventState(response(status), "task-one");
    expect(eventAnchorState("armed-turn", state)).toBe(expected);
    expect(Object.keys(state).sort()).toEqual(["status", "taskId", "turnId"]);
  }
  expect(eventAnchorState("armed-turn", parseNativeEventState(response("completed", "newer-turn"), "task-one"))).toBe("changed");
  expect(() => parseNativeEventState(response("completed"), "wrong-owner")).toThrow();
  expect(() => parseNativeEventState(response("unknown-native-status"), "task-one")).toThrow();
});
