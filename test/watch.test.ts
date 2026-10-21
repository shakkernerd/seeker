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
  const watcher = new ThreadWatcher(core, [host, blind], 60_000, 500, 8);
  cleanups.push(() => watcher.stop());
  const manager = core.events({ hostId: "codex-desktop", taskId: "manager", turnId: "manager-turn", callId: "manager-call" });
  const watch = (threadId: string, expiresAt = 60_000) => manager.watch({ waitId: `watch-${threadId}`, generation: "g", revision: threadId, title: `Watch ${threadId}`, expiresAt, threadId });
  return { core, store, watcher, reads, states, manager, watch, setTime: (value: number) => { now = value; }, address: (threadId: string) => ({ waitId: `watch-${threadId}`, generation: "g", revision: threadId }) };
}

test("the watcher reads each watched task without a model and records one observation when its turn failed or was interrupted", async () => {
  const f = fixture();
  f.watch("lead-a"); f.watch("lead-b"); f.watch("lead-c"); f.watch("lead-gone");
  f.states.set("lead-a", { taskId: "lead-a", turnId: "a-1", status: "inProgress" });
  f.states.set("lead-b", { taskId: "lead-b", turnId: "b-1", status: "completed" });
  f.states.set("lead-c", { taskId: "lead-c", turnId: "c-2", status: "failed" });
  expect(await f.watcher.tick()).toBe(1);
  expect(f.reads.map((read) => read.threadId).sort()).toEqual(["lead-a", "lead-b", "lead-c", "lead-gone"]);
  expect(f.reads[0]!.reader).toEqual({ hostId: "codex-desktop", taskId: "manager", turnId: "manager-turn" });
  expect(f.manager.get(f.address("lead-c"))).toMatchObject({ state: "ready", receipt: { source: "watch", signal: { evidenceRefs: ["codex:lead-c:c-2"] } } });
  expect(f.manager.get(f.address("lead-a")).state).toBe("waiting");
  expect(f.manager.get(f.address("lead-b")).state).toBe("waiting");
  expect(f.manager.get(f.address("lead-gone")).state).toBe("waiting");
  // The observed watch is settled; the others are read again, and an unreadable task is simply retried next pass.
  f.states.set("lead-a", { taskId: "lead-a", turnId: "a-2", status: "interrupted" });
  f.states.set("lead-gone", { taskId: "lead-gone", turnId: "g-1", status: "interrupted" });
  expect(await f.watcher.tick()).toBe(2);
  expect(f.reads.filter((read) => read.threadId === "lead-c")).toHaveLength(1);
  expect(f.manager.get(f.address("lead-a")).receipt!.signal.summary).toContain("was interrupted");
  const claimed = f.store.events.claim(4, f.core.clock(), []);
  expect(claimed.map((wait) => wait.waitId)).toEqual(["watch-lead-a"]);
  // Nothing is ever read for a host that cannot observe tasks, and a cancelled or expired watch is not read.
  const cli = f.core.events({ hostId: "codex-cli", taskId: "cli-manager", turnId: "t", callId: "c" });
  cli.watch({ waitId: "watch-cli-lead", generation: "g", revision: "r", title: "CLI lead", expiresAt: 60_000, threadId: "cli-lead" });
  f.manager.cancel(f.address("lead-b"), f.manager.get(f.address("lead-b")).version);
  f.setTime(61_000);
  const before = f.reads.length;
  expect(await f.watcher.tick()).toBe(0);
  expect(f.reads).toHaveLength(before);
  expect(f.manager.get(f.address("lead-gone")).state).toBe("ready");
});

test("the watcher stops cleanly and never overlaps its own passes", async () => {
  const f = fixture();
  f.watch("lead-slow");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.states.set("lead-slow", { taskId: "lead-slow", turnId: "s-1", status: "failed" });
  const slowHost: HostAdapter = { id: "codex-desktop", deliver: async () => ({ status: "retry", retryAfterMs: 1_000, code: "unused" }), threadState: async () => { await gate; return { taskId: "lead-slow", turnId: "s-1", status: "failed" }; } };
  const watcher = new ThreadWatcher(f.core, [slowHost], 60_000, 5_000, 8);
  const first = watcher.tick();
  expect(await watcher.tick()).toBe(0);
  release();
  expect(await first).toBe(1);
  watcher.stop();
  expect(await watcher.tick()).toBe(0);
  const idle = new ThreadWatcher(f.core, [{ id: "none", deliver: async () => ({ status: "retry", retryAfterMs: 1_000, code: "unused" }) }]);
  idle.start(); idle.stop();
});
