import { afterEach, expect, test } from "bun:test";
import type { HostAdapter, ThreadReader, ThreadState } from "../src/contracts.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { ThreadWatcher } from "../src/core/watch.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

function fixture() {
  let now = 1_000;
  const store = new SqliteExchangeStore(":memory:"), core = new SeekerCore(store, () => now);
  cleanups.push(() => store.close());
  const reads: { reader: ThreadReader; threadId: string }[] = [];
  const states = new Map<string, ThreadState | Error>();
  const host: HostAdapter = { id: "codex-desktop", deliver: async () => ({ status: "retry", retryAfterMs: 1_000, code: "unused" }), threadState: async (reader, threadId) => { reads.push({ reader, threadId }); const state = states.get(threadId); if (!state) throw new Error("unknown task"); if (state instanceof Error) throw state; return state; } };
  const blind: HostAdapter = { id: "codex-cli", deliver: async () => ({ status: "retry", retryAfterMs: 1_000, code: "unused" }) };
  const watcher = new ThreadWatcher(core, [host, blind], 60_000, 500);
  cleanups.push(() => watcher.stop());
  const manager = core.events({ hostId: "codex-desktop", taskId: "manager", turnId: "manager-turn", callId: "manager-call" });
  const watch = (threadId: string, on?: ("completed" | "failed" | "interrupted")[]) => manager.watch({ waitId: `watch-${threadId}`, title: `Watch ${threadId}`, expiresAt: 60_000, threadId, ...(on ? { on } : {}) });
  return { core, store, watcher, reads, states, manager, watch, setTime: (value: number) => { now = value; }, address: (threadId: string) => ({ waitId: `watch-${threadId}` }) };
}

test("the watcher reads each watched task without a model and records one observation when its turn ended the way the watch reports", async () => {
  const f = fixture();
  f.watch("lead-a"); f.watch("lead-b"); f.watch("lead-c"); f.watch("lead-gone"); f.watch("lead-done", ["completed"]);
  f.states.set("lead-a", { taskId: "lead-a", turnId: "a-1", status: "inProgress" });
  f.states.set("lead-b", { taskId: "lead-b", turnId: "b-1", status: "completed", completedAt: 1_500 });
  f.states.set("lead-c", { taskId: "lead-c", turnId: "c-2", status: "failed", completedAt: 1_500 });
  f.states.set("lead-done", { taskId: "lead-done", turnId: "d-3", status: "completed", completedAt: 1_500 });
  expect(await f.watcher.tick()).toBe(2);
  expect(f.reads.map((read) => read.threadId).sort()).toEqual(["lead-a", "lead-b", "lead-c", "lead-done", "lead-gone"]);
  expect(f.reads[0]!.reader).toEqual({ hostId: "codex-desktop", taskId: "manager", turnId: "manager-turn" });
  expect(f.manager.get(f.address("lead-c"))).toMatchObject({ state: "ready", receipt: { source: "watch", signal: { outcome: "failed", evidenceRefs: ["codex:lead-c:c-2"] } } });
  // A completed turn wakes only the watch that asked for it.
  expect(f.manager.get(f.address("lead-done"))).toMatchObject({ state: "ready", receipt: { source: "watch", signal: { outcome: "completed", evidenceRefs: ["codex:lead-done:d-3"] } } });
  expect(f.manager.get(f.address("lead-a")).state).toBe("waiting");
  expect(f.manager.get(f.address("lead-b")).state).toBe("waiting");
  expect(f.manager.get(f.address("lead-gone")).state).toBe("waiting");
  // The observed watch is settled; the others are read again, and an unreadable task is simply retried next pass.
  f.states.set("lead-a", { taskId: "lead-a", turnId: "a-2", status: "interrupted", completedAt: 1_600 });
  f.states.set("lead-gone", { taskId: "lead-gone", turnId: "g-1", status: "interrupted", completedAt: 1_600 });
  expect(await f.watcher.tick()).toBe(2);
  expect(f.reads.filter((read) => read.threadId === "lead-c")).toHaveLength(1);
  expect(f.manager.get(f.address("lead-a")).receipt!.signal.summary).toContain("was interrupted");
  const claimed = f.store.events.claim(4, f.core.clock(), []);
  // One send per task at a time: the other two observations follow once this one settles.
  expect(claimed.map((wait) => wait.waitId)).toEqual(["watch-lead-a"]);
  // Nothing is ever read for a host that cannot observe tasks, and a cancelled or expired watch is not read.
  const cli = f.core.events({ hostId: "codex-cli", taskId: "cli-manager", turnId: "t", callId: "c" });
  cli.watch({ waitId: "watch-cli-lead", title: "CLI lead", expiresAt: 60_000, threadId: "cli-lead" });
  f.manager.cancel(f.address("lead-b"));
  f.setTime(61_000);
  const before = f.reads.length;
  expect(await f.watcher.tick()).toBe(0);
  expect(f.reads).toHaveLength(before);
  expect(f.manager.get(f.address("lead-gone")).state).toBe("ready");
});

test("a turn that ended before the watch was armed is never reported; one seen running, or begun after the arm, is", async () => {
  const f = fixture();
  // Armed at 1000. A failure recorded at 900 is old news, with or without the host saying when it ended.
  f.watch("stale-timed"); f.states.set("stale-timed", { taskId: "stale-timed", turnId: "old", status: "failed", completedAt: 900 });
  f.watch("stale-untimed"); f.states.set("stale-untimed", { taskId: "stale-untimed", turnId: "old", status: "failed" });
  f.watch("running"); f.states.set("running", { taskId: "running", turnId: "r-1", status: "inProgress" });
  expect(await f.watcher.tick()).toBe(0);
  for (const task of ["stale-timed", "stale-untimed", "running"]) expect(f.manager.get(f.address(task)).state).toBe("waiting");
  expect(f.manager.get(f.address("running")).watch).toMatchObject({ seen: { turnId: "r-1", status: "inProgress" } });
  // The running turn ends; the untimed stale task starts a newer turn that fails; the timed stale task's old turn stays old.
  f.states.set("running", { taskId: "running", turnId: "r-1", status: "failed" });
  f.states.set("stale-untimed", { taskId: "stale-untimed", turnId: "new", status: "failed" });
  expect(await f.watcher.tick()).toBe(2);
  expect(f.manager.get(f.address("running"))).toMatchObject({ state: "ready", receipt: { signal: { evidenceRefs: ["codex:running:r-1"] } } });
  expect(f.manager.get(f.address("stale-untimed"))).toMatchObject({ state: "ready", receipt: { signal: { evidenceRefs: ["codex:stale-untimed:new"] } } });
  expect(f.manager.get(f.address("stale-timed")).state).toBe("waiting");
  // A Codex turn id carries its creation time: one created after the arm is new even on the first read.
  f.watch("uuid-task"); f.states.set("uuid-task", { taskId: "uuid-task", turnId: "00000000-07d0-7000-8000-000000000000", status: "completed" });
  f.watch("uuid-old"); f.states.set("uuid-old", { taskId: "uuid-old", turnId: "00000000-0384-7000-8000-000000000000", status: "failed" });
  expect(await f.watcher.tick()).toBe(0);
  expect(f.manager.get(f.address("uuid-old")).state).toBe("waiting");
  f.manager.cancel(f.address("uuid-task"));
  const done = f.core.events({ hostId: "codex-desktop", taskId: "manager", turnId: "t", callId: "c" }).watch({ waitId: "watch-uuid-done", title: "done", expiresAt: 60_000, threadId: "uuid-task", on: ["completed"] });
  expect(done.state).toBe("waiting");
  expect(await f.watcher.tick()).toBe(1);
  expect(f.manager.get({ waitId: "watch-uuid-done" })).toMatchObject({ state: "ready", receipt: { signal: { outcome: "completed" } } });
});

test("the watcher stops cleanly and never overlaps its own passes", async () => {
  const f = fixture();
  f.watch("lead-slow");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.states.set("lead-slow", { taskId: "lead-slow", turnId: "s-1", status: "failed", completedAt: 1_500 });
  const slowHost: HostAdapter = { id: "codex-desktop", deliver: async () => ({ status: "retry", retryAfterMs: 1_000, code: "unused" }), threadState: async () => { await gate; return { taskId: "lead-slow", turnId: "s-1", status: "failed", completedAt: 1_500 }; } };
  const watcher = new ThreadWatcher(f.core, [slowHost], 60_000, 5_000);
  const first = watcher.tick();
  expect(await watcher.tick()).toBe(0);
  release();
  expect(await first).toBe(1);
  watcher.stop();
  expect(await watcher.tick()).toBe(0);
  const idle = new ThreadWatcher(f.core, [{ id: "none", deliver: async () => ({ status: "retry", retryAfterMs: 1_000, code: "unused" }) }]);
  idle.start(); idle.stop();
});
