import type { ChannelMessage, DeliveryResult, MessagingChannel, Recipient } from "../contracts.ts";

export const localRecipient: Recipient = { channelId: "local", actorId: "owner", conversationId: "inbox" };

/** The authenticated inbox reads the same durable exchange. No second message store. */
export class LocalChannel implements MessagingChannel {
  readonly id = "local";
  async send(message: ChannelMessage, signal: AbortSignal): Promise<DeliveryResult> {
    if (signal.aborted) return { status: "unknown", code: "aborted" };
    return { status: "accepted", reference: `local:${message.exchangeId}:${message.revision.number}:${message.context?.id ?? "question"}` };
  }
}
