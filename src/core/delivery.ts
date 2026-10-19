import type { Delivery, DeliveryResult, HostAdapter, MessagingChannel } from "../contracts.ts";
import type { EventWait } from "../events.ts";
import { SeekerCore } from "./seeker.ts";
import { channelReadiness, routeFor } from "./attention.ts";
import { eventEnvelope, eventReturnCurrent, eventReturnTarget } from "./event-return.ts";
import { eventRoute } from "./events.ts";

/** One notice, no reminders. Only a definite retryable failure may be retried. */
export class DeliveryPump {
  readonly #active = new Map<string, { controller: AbortController; route: string }>();
  readonly #abandoned = new Map<string, { controller: AbortController; route: string }>();
  #timer?: ReturnType<typeof setInterval>;
  #stopped = false;
  #eventsFirst = false;
  lastError?: "store_write_failed";

  constructor(
    private readonly core: SeekerCore,
    private readonly channels: readonly MessagingChannel[],
    private readonly hosts: readonly HostAdapter[],
    private readonly timeoutMs = 5_000
  ) {}

  start(): void {
    this.core.store.recoverInterruptedDeliveries(this.core.clock());
    this.core.store.events.recover(this.core.clock());
    for (const host of this.hosts) this.core.resumeHost(host.id);
    for (const channel of this.channels) this.core.resumeChannel(channel.id);
    this.#stopped = false;
    this.#timer = setInterval(() => this.tick(), 200);
    this.#timer.unref();
    this.tick();
  }

  tick(): void {
    if (this.#stopped || this.#active.size >= 4 || this.lastError) return;
    const capacity = Math.min(4 - this.#active.size, 32 - this.#active.size - this.#abandoned.size);
    if (capacity <= 0) return;
    try {
      const claim = (events: boolean) => {
        const remaining = Math.min(4 - this.#active.size, 32 - this.#active.size - this.#abandoned.size);
        if (remaining <= 0) return;
        const excluded = [...this.#active.values(), ...this.#abandoned.values()].map((item) => item.route);
        if (events) for (const wait of this.core.store.events.claim(remaining, this.core.clock(), excluded)) this.#dispatchEvent(wait);
        else for (const attempt of this.core.store.claimDeliveries(remaining, this.core.clock(), excluded)) this.#dispatch(attempt);
      };
      // Neither family may monopolize slots under a sustained backlog.
      claim(this.#eventsFirst);
      claim(!this.#eventsFirst);
      this.#eventsFirst = !this.#eventsFirst;
    } catch { this.lastError = "store_write_failed"; }
  }
  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    for (const { controller } of [...this.#active.values(), ...this.#abandoned.values()]) controller.abort();
    // Pending I/O may already have escaped. Restart marks interrupted attempts unknown.
  }

  get inFlight(): number { return this.#active.size; }

  #run(id: string, route: string, send: (signal: AbortSignal) => Promise<DeliveryResult> | DeliveryResult, complete: (result: DeliveryResult) => void): void {
    const controller = new AbortController(), active = { controller, route };
    this.#active.set(id, active);
    const commit = (result: DeliveryResult) => {
      if (this.#stopped) return;
      try { complete(result); }
      catch { this.lastError = "store_write_failed"; }
    };
    const timeout = setTimeout(() => {
      controller.abort();
      commit({ status: "unknown", code: "io_timeout" });
      this.#active.delete(id);
      this.#abandoned.set(id, active);
      this.tick();
    }, this.timeoutMs);
    timeout.unref();
    // The attempt is durable before this promise boundary. A timed-out operation
    // stays quarantined until it settles; no replacement may reuse its route.
    Promise.resolve().then(() => controller.signal.aborted ? { status: "unknown", code: "aborted" } as const : send(controller.signal))
      .then(commit, () => commit({ status: "unknown", code: "adapter_error" })).finally(() => {
        clearTimeout(timeout);
        this.#active.delete(id);
        this.#abandoned.delete(id);
        this.tick();
      });
  }

  #dispatchEvent(wait: EventWait): void {
    const delivery = wait.delivery!, target = eventReturnTarget(wait), envelope = eventEnvelope(wait);
    this.#run(delivery.id, eventRoute(wait), (signal) => {
      if (!eventReturnCurrent(this.core, target, envelope)) return { status: "rejected", code: "event_owner_changed" };
      const adapter = this.hosts.find((host) => host.id === wait.owner.hostId);
      return adapter ? adapter.deliver(target, envelope, signal) : { status: "retry", retryAfterMs: 30_000, code: "host_unavailable" };
    }, (result) => this.core.store.events.complete(wait.waitId, wait.generation, delivery.attemptId!, result, this.core.clock()));
  }

  #dispatch(attempt: Delivery): void {
    const view = this.core.store.get(attempt.exchangeId)!;
    const exchange = view.exchange;
    const binding = this.core.store.binding(exchange.origin);
    const revision = exchange.revisions[attempt.revision - 1]!;
    this.#run(attempt.id, routeFor(exchange, attempt.lane), (signal) => {
      const latest = this.core.store.get(attempt.exchangeId)!.exchange;
      this.core.store.binding(exchange.origin);
      if (attempt.lane === "channel") {
        const readiness = channelReadiness(latest, attempt);
        if (readiness === "retire") return { status: "rejected", code: "superseded" };
        if (readiness === "defer") return { status: "retry", code: "awaiting_reconciliation", retryAfterMs: 1_000 };
        const adapter = this.channels.find((item) => item.id === exchange.recipient.channelId);
        if (!adapter) return { status: "retry", retryAfterMs: 30_000, code: "channel_unavailable" };
        return adapter.send({
          deliveryId: attempt.id, exchangeId: exchange.id, managerLabel: exchange.managerLabel,
          recipient: exchange.recipient, revision,
          ...(attempt.contextId ? { context: exchange.context.find((item) => item.id === attempt.contextId)! } : {}),
        }, signal);
      }
      const adapter = this.hosts.find((item) => item.id === binding.origin.hostId);
      if (!adapter) return { status: "retry", retryAfterMs: 30_000, code: "host_unavailable" };
      if (attempt.noticeOf) {
        const failed = view.deliveries.find((item) => item.id === attempt.noticeOf)!;
        return adapter.deliver({ ...binding, origin: exchange.origin }, {
          deliveryId: attempt.id, exchangeId: exchange.id, revision, requiresReconciliation: true,
          notice: { deliveryId: failed.id, state: failed.state as "unknown" | "rejected", code: failed.code ?? "contact_unconfirmed" },
        }, signal);
      }
      if (attempt.deferredEventId) {
        const deferred = view.deferredReplies!.find((item) => item.channelId === attempt.deferredChannelId && item.event.eventId === attempt.deferredEventId)!;
        return adapter.deliver({ ...binding, origin: exchange.origin }, { deliveryId: attempt.id, exchangeId: exchange.id, revision, deferred, requiresReconciliation: true }, signal);
      }
      const receipt = exchange.receipts.find((item) => item.id === attempt.receiptId)!;
      return adapter.deliver({ ...binding, origin: exchange.origin }, {
        deliveryId: attempt.id, exchangeId: exchange.id, revision, receipt,
        requiresReconciliation: exchange.state === "reconcile" || receipt.revision !== exchange.revision || Boolean(receipt.dispositionHistory?.length),
      }, signal);
    }, (result) => this.core.store.completeDelivery(attempt.id, attempt.attemptId!, result, this.core.clock()));
  }
}
