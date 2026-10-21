import type { HostAdapter } from "../contracts.ts";
import type { EventWait } from "../events.ts";
import type { SeekerCore } from "./seeker.ts";

/**
 * Observes watched tasks for their owners. Every interval it asks each host for
 * the latest turn of the tasks its waits watch, with no model involved, and
 * hands each ended turn to the store, which records one observation when the
 * watch reports that ending. The recorded observation is the watch's result;
 * the delivery pump returns it to the watching task like any other machine event.
 */
export class ThreadWatcher {
  #timer?: ReturnType<typeof setInterval>;
  #running = false;
  #stopped = false;
  #controller?: AbortController;
  lastError?: "store_write_failed";

  constructor(private readonly core: SeekerCore, private readonly hosts: readonly HostAdapter[], private readonly intervalMs = 30_000, private readonly readTimeoutMs = 15_000) {}

  start(): void {
    this.#stopped = false;
    if (!this.hosts.some((host) => host.threadState)) return;
    this.#timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer); this.#timer = undefined;
    this.#controller?.abort();
  }

  /** One pass over every unexpired watch; a pass that outlasts the interval delays the next, it never overlaps it. */
  async tick(): Promise<number> {
    if (this.#stopped || this.#running || this.lastError) return 0;
    this.#running = true;
    const controller = new AbortController(); this.#controller = controller;
    let observed = 0;
    try {
      let watches: EventWait[];
      try { watches = this.core.store.events.watching(this.core.clock()); }
      catch { this.lastError = "store_write_failed"; return 0; }
      const byHost = new Map<string, EventWait[]>();
      for (const wait of watches) { const list = byHost.get(wait.owner.hostId) ?? []; list.push(wait); byHost.set(wait.owner.hostId, list); }
      await Promise.all([...byHost].map(async ([hostId, list]) => {
        const host = this.hosts.find((item) => item.id === hostId);
        if (!host?.threadState) return;
        // Reads of one host run in order: the native socket is one channel, not a pool.
        for (const wait of list) {
          if (controller.signal.aborted) return;
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.readTimeoutMs)]);
          let state;
          try { state = await host.threadState({ hostId, taskId: wait.owner.taskId, turnId: wait.owner.turnId }, wait.watch!.threadId, signal); }
          catch { continue; }
          if (state.taskId !== wait.watch!.threadId) continue;
          try { if (this.core.store.events.observe(wait, { turnId: state.turnId, status: state.status, ...(state.completedAt !== undefined ? { completedAt: state.completedAt } : {}) }, this.core.clock())) observed += 1; }
          catch { this.lastError = "store_write_failed"; return; }
        }
      }));
      return observed;
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
      this.#running = false;
    }
  }
}
