import type { ChannelIngress, ExchangeStore, ExchangeView, InboundReply, ManagerBinding, ManagerOrigin, ManagerPort, Recipient } from "../contracts.ts";
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

  resumeHost(hostId: string): number { return this.store.resumeRoute("host", id(hostId, "Host"), this.clock()); }
  resumeChannel(channelId: string): number { return this.store.resumeRoute("channel", id(channelId, "Channel"), this.clock()); }

  manager(input: ManagerOrigin): ManagerPort {
    const origin = Object.freeze(validateOrigin(input));
    this.store.binding(origin);
    return {
      submit: (input) => this.store.execute(origin, { type: "submit", requestId: input.requestId, decision: input.decision }, this.clock()),
      get: (requestId) => {
        const binding = this.store.binding(origin);
        const view = this.store.get(id(requestId, "Request"));
        if (!view) fail("not_found", "Exchange not found.", 404);
        if (view.exchange.bindingId !== binding.id) fail("origin_denied", "This exchange belongs to another manager.", 403);
        return view;
      },
      listPending: () => this.store.list({ bindingId: this.store.binding(origin).id, pendingOnly: true }),
      update: (command) => this.store.execute(origin, command, this.clock()),
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
