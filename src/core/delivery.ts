import type { Delivery, DeliveryResult, HostAdapter, MessagingChannel } from "../contracts.ts";
import { SeekerCore } from "./seeker.ts";

/** One prompt, no reminders. Only a definite retryable failure may be retried. */
export class DeliveryPump {
  readonly #active = new Map<string, { controller: AbortController; route: string }>();
  readonly #abandoned = new Map<string, { controller: AbortController; route: string }>();
  #timer?: ReturnType<typeof setInterval>;
  #stopped = false;
  lastError?: "store_write_failed";

  constructor(
    private readonly core: SeekerCore,
    private readonly channels: readonly MessagingChannel[],
    private readonly hosts: readonly HostAdapter[],
    private readonly timeoutMs = 5_000,
  ) {}

  start(): void {
    this.core.store.recoverInterruptedDeliveries();
    this.#stopped = false;
    this.#timer = setInterval(() => this.tick(), 200);
    this.#timer.unref();
    this.tick();
  }

  tick(): void {
    if (this.#stopped || this.#active.size >= 4 || this.lastError) return;
    try {
      const excluded = [...this.#active.values(), ...this.#abandoned.values()].map((item) => item.route);
      for (const attempt of this.core.store.claimDeliveries(4 - this.#active.size, this.core.clock(), excluded)) this.#dispatch(attempt);
    } catch { this.lastError = "store_write_failed"; }
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    for (const { controller } of [...this.#active.values(), ...this.#abandoned.values()]) controller.abort();
    // Pending I/O may already have escaped. A restart will mark these attempts unknown.
  }

  get inFlight(): number { return this.#active.size; }

  #dispatch(attempt: Delivery): void {
    const controller = new AbortController();
    const view = this.core.store.get(attempt.exchangeId)!;
    const exchange = view.exchange;
    const active = { controller, route: `${attempt.lane}:${attempt.lane === "channel" ? exchange.recipient.channelId : exchange.origin.hostId}` };
    this.#active.set(attempt.id, active);
    const binding = this.core.store.binding(exchange.origin);
    const revision = exchange.revisions[attempt.revision - 1]!;
    const commit = (result: DeliveryResult) => {
      if (this.#stopped) return;
      try { this.core.store.completeDelivery(attempt.id, attempt.attemptId!, result, this.core.clock()); }
      catch { this.lastError = "store_write_failed"; }
    };
    const timeout = setTimeout(() => {
      controller.abort();
      commit({ status: "unknown", code: "io_timeout" });
      this.#active.delete(attempt.id);
      this.#abandoned.set(attempt.id, active);
      this.tick();
    }, this.timeoutMs);
    timeout.unref();

    // Start only after committing the attempt. No transaction crosses this promise boundary.
    const operation = Promise.resolve().then((): Promise<DeliveryResult> | DeliveryResult => {
      const latest = this.core.store.get(attempt.exchangeId)!.exchange;
      this.core.store.binding(exchange.origin);
      if (controller.signal.aborted) return { status: "unknown", code: "aborted" };
      if (attempt.lane === "channel") {
        if (latest.cancellation || latest.revision !== attempt.revision || (!attempt.contextId && latest.state !== "waiting")) return { status: "rejected", code: "superseded" };
        const adapter = this.channels.find((item) => item.id === exchange.recipient.channelId);
        if (!adapter) return { status: "retry", retryAfterMs: 30_000, code: "channel_unavailable" };
        return adapter.send({
          deliveryId: attempt.id, exchangeId: exchange.id, managerLabel: exchange.managerLabel,
          recipient: exchange.recipient, revision,
          ...(attempt.contextId ? { context: exchange.context.find((item) => item.id === attempt.contextId)! } : {}),
        }, controller.signal);
      }
      const adapter = this.hosts.find((item) => item.id === binding.origin.hostId);
      if (!adapter) return { status: "retry", retryAfterMs: 30_000, code: "host_unavailable" };
      const receipt = exchange.receipts.find((item) => item.id === attempt.receiptId)!;
      return adapter.deliver({ ...binding, origin: exchange.origin }, {
        deliveryId: attempt.id, exchangeId: exchange.id, revision, receipt,
        requiresReconciliation: exchange.state === "reconcile" || receipt.revision !== exchange.revision,
      }, controller.signal);
    });
    operation.then(commit, () => commit({ status: "unknown", code: "adapter_error" })).finally(() => {
      clearTimeout(timeout);
      this.#active.delete(attempt.id);
      this.#abandoned.delete(attempt.id);
      this.tick();
    });
    // At most one unsettled operation per configured adapter is quarantined after timeout.
    // It cannot create replacements or occupy the shared slots needed by healthy adapters.
  }
}
