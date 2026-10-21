import type { EventOwner, EventPort } from "../events.ts";
import { eventOwner } from "./events.ts";
import type { ChannelIngress, ExchangeStore, ExchangeView, InboundReply, ManagerBinding, ManagerOrigin, ManagerPort, ReadOptions, Recipient } from "../contracts.ts";
import { fail, id, origin as validateOrigin, sameRecipient } from "./validation.ts";

/** Trusted composition owns this object. Expose only a bound ManagerPort to agent tools. */
export class SeekerCore {
  constructor(readonly store: ExchangeStore, readonly clock: () => number = Date.now) {}

  bind(binding: ManagerBinding): void { this.store.bind(binding); }
  setRecipient(bindingId: string, expectedGeneration: number, recipient: Recipient): void {
    this.store.setRecipient(bindingId, expectedGeneration, recipient);
  }

  managerBinding(hostId: string, managerId: string): ManagerBinding | undefined {
    return this.store.findBinding(hostId, managerId);
  }

  resumeHost(hostId: string): number { const host = id(hostId, "Host"); return this.store.resumeRoute("host", host, this.clock()) + this.store.events.resumeHost(host, this.clock()); }
  resumeChannel(channelId: string): number { return this.store.resumeRoute("channel", id(channelId, "Channel"), this.clock()); }

  manager(input: ManagerOrigin): ManagerPort {
    const origin = Object.freeze(validateOrigin(input));
    this.store.binding(origin);
    const read = (requestId: string, options?: ReadOptions) => {
      const binding = this.store.binding(origin);
      const result = this.store.read(id(requestId, "Request"), binding.id, options);
      if (!result) fail("not_found", "Exchange not found.", 404);
      if (result.exchange.bindingId !== binding.id) fail("origin_denied", "This exchange belongs to another manager.", 403);
      return result;
    };
    return {
      submit: (input) => {
        this.store.execute(origin, { type: "submit", requestId: input.requestId, decision: input.decision }, this.clock());
        return read(input.requestId);
      },
      get: read,
      listPending: (options) => this.store.pending(this.store.binding(origin).id, options?.cursor),
      update: (command) => {
        this.store.execute(origin, command, this.clock());
        return read(command.requestId);
      },
    };
  }

  /** Trusted host composition supplies this identity; event access never grants ManagerPort. */
  events(input: EventOwner): EventPort {
    const origin = eventOwner(input);
    const binding = this.managerBinding(origin.hostId, origin.taskId);
    if (binding) { origin.bindingId = binding.id; origin.ownerGeneration = binding.origin.generation; }
    const current = () => {
      const live = this.managerBinding(origin.hostId, origin.taskId);
      if ((live?.id !== origin.bindingId) || (live?.origin.generation !== origin.ownerGeneration)) fail("owner_changed", "This event port's native assignment changed. Reconnect from the current owner.", 409);
    };
    const mutate: (address: Parameters<EventPort["cancel"]>[0], expectedVersion: number, command: Parameters<ExchangeStore["events"]["mutate"]>[3]) => ReturnType<EventPort["get"]> =
      (address, expectedVersion, command) => { current(); return this.store.events.mutate(origin, address, expectedVersion, command, this.clock()); };
    return {
      arm: (value) => { current(); return this.store.events.arm(origin, value, this.clock()); },
      watch: (value) => { current(); return this.store.events.watch(origin, value, this.clock()); },
      get: (address) => { current(); return this.store.events.get(origin, address, this.clock()); },
      pending: () => { current(); return this.store.events.pending(origin, this.clock()).map(({ waitId, generation, revision, title, expiresAt, version, state, updatedAt, reason, receipt, watch }) => ({ waitId, generation, revision, title, expiresAt, version, state, updatedAt, ...(reason ? { reason } : {}), ...(receipt ? { receiptId: receipt.id } : {}), ...(watch ? { watch } : {}) })); },
      cancel: (address, version) => mutate(address, version, { type: "cancel" }),
      acknowledge: (address, version, receiptId, status) => mutate(address, version, { type: "acknowledge", receiptId, status }),
      clear: (address, version) => mutate(address, version, { type: "clear" }),
    };
  }

  channel(channelId: string): ChannelIngress {
    id(channelId, "Channel");
    if (channelId.startsWith("native:")) fail("origin_denied", "Native sources use the trusted host adapter port.", 403);
    return {
      receive: (events, progress) => this.store.ingest(channelId, events, progress, this.clock()),
      progress: () => this.store.progress(channelId),
      pending: (recipient) => {
        if (recipient.channelId !== channelId) fail("recipient_denied", "Wrong channel for this recipient.", 403);
        return this.store.list({ recipient, pendingOnly: true });
      },
      resolveMessage: (conversationId, reference) => this.store.resolveMessage(channelId, conversationId, reference),
    };
  }

  /** Only a host-verified original human message may reach this separate ingress. */
  receiveNative(origin: ManagerOrigin, requestId: string, revision: number, reply: InboundReply) {
    return this.store.ingestNative(origin, requestId, revision, reply, this.clock());
  }

  inbox(recipient: Recipient): ExchangeView[] { return this.store.list({ recipient }); }
  history(recipient: Recipient, cursor?: string) { return this.store.history(recipient, cursor); }
  forRecipient(requestId: string, recipient: Recipient): ExchangeView {
    const view = this.store.get(id(requestId, "Request"));
    if (!view || !sameRecipient(view.exchange.recipient, recipient)) fail("not_found", "Exchange not found.", 404);
    return view;
  }
}
