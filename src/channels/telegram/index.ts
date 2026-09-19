import type { ChannelIngress, MessagingChannel } from "../../contracts";
import { TelegramApi } from "./api";
import { TelegramChannel } from "./channel";
import type { TelegramOwner } from "./enrollment";

export interface TelegramReceiver extends MessagingChannel {
  run(ingress: ChannelIngress, signal: AbortSignal): Promise<void>;
}

/** Called only by trusted setup/runtime composition, never an agent-facing tool. */
export function createTelegramChannel(token: string, owner: TelegramOwner, report: (message: string) => void): TelegramReceiver {
  return new TelegramChannel(new TelegramApi(token), owner, { report });
}
