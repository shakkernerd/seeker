import type { Delivery, Exchange } from "../contracts.ts";
import { isAnswer } from "./lifecycle.ts";

export function routeFor(exchange: Exchange, lane: Delivery["lane"]): string {
  return lane === "channel" ? `channel:${exchange.recipient.channelId}` : `host:${exchange.origin.hostId}:${exchange.bindingId}`;
}

export function channelReadiness(exchange: Exchange, attempt: Delivery): "send" | "defer" | "retire" {
  if (exchange.cancellation || attempt.revision !== exchange.revision) return "retire";
  if (attempt.contextId) return "send";
  if (exchange.receipts.some((item) => item.revision === exchange.revision && isAnswer(item, exchange))) return "retire";
  return exchange.state === "reconcile" ? "defer" : "send";
}
