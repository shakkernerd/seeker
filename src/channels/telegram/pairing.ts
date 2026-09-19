import type { ChannelIngress, ReceiveProgress, Recipient } from "../../contracts";
import { isRecord, TelegramApi, TelegramError, telegramId } from "./api";
import { delay, verifyBot } from "./channel";
import { TelegramEnrollment, type TelegramOwner } from "./enrollment";
import { claimReceiver } from "./receiver-lock";
import { pollUpdates } from "./updates";

export interface PairingInteraction {
  invitation(url: string, expiresAt: number): void;
  readCode(signal: AbortSignal): Promise<string>;
  status(message: string): void;
}

/** Trusted local setup only. Human confirmation and network I/O are outside store transactions. */
export async function pairTelegram(
  api: TelegramApi,
  ingress: ChannelIngress,
  interaction: PairingInteraction,
  save: (recipient: Recipient) => void,
  signal: AbortSignal,
  internal: {
    expected?: TelegramOwner;
    now?: () => number;
    claim?: (botId: string) => Promise<() => Promise<void>>;
    sleep?: typeof delay;
  } = {},
): Promise<Recipient> {
  const now = internal.now ?? Date.now;
  const sleep = internal.sleep ?? delay;
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
  const enrollment = new TelegramEnrollment(internal.expected, now());
  const release = await (internal.claim ?? claimReceiver)(api.botId);
  try {
    const bot = await verifyBot(api, lifetime);
    const invitation = enrollment.invitation(bot.username);
    interaction.invitation(invitation.url, invitation.expiresAt);
    while (!lifetime.aborted && now() < invitation.expiresAt) {
      const previous = ingress.progress();
      let batch: Awaited<ReturnType<typeof pollUpdates>>;
      try {
        batch = await pollUpdates(api, previous?.cursor, ["message"], lifetime);
      } catch (error) {
        if (error instanceof TelegramError && error.retryAfterSeconds !== undefined) { await sleep(error.retryAfterSeconds * 1_000, lifetime); continue; }
        throw error;
      }
      let candidate: TelegramOwner | undefined;
      for (const update of batch.updates) {
        candidate ??= enrollment.match(update.message, now());
      }
      const progress: ReceiveProgress = {
        ...(batch.cursor === undefined ? {} : { cursor: batch.cursor }), lastReceivedAt: now(),
        continuity: previous?.continuity === "possible-gap" || (previous && now() - previous.lastReceivedAt > 24 * 60 * 60_000) ? "possible-gap" : "continuous",
      };
      if (!candidate) {
        ingress.receive([], progress);
        continue;
      }
      const code = enrollment.challenge(candidate);
      while (!lifetime.aborted && now() < invitation.expiresAt) {
        try {
          const sent = await api.call("sendMessage", {
            chat_id: candidate.conversationId,
            text: `Seeker pairing code: ${code}\n\nEnter this code only in the local Seeker setup you started. This account is not paired until you confirm there. The invitation expires after ten minutes.`,
            link_preview_options: { is_disabled: true },
          }, lifetime);
          if (!isRecord(sent) || !telegramId(sent.message_id) || !isRecord(sent.chat) || telegramId(sent.chat.id) !== candidate.conversationId || sent.chat.type !== "private") throw new TelegramError("invalid-response", "unknown");
          break;
        } catch (error) {
          if (error instanceof TelegramError && error.retryAfterSeconds !== undefined) { await sleep(error.retryAfterSeconds * 1_000, lifetime); continue; }
          throw error;
        }
      }
      if (lifetime.aborted || now() >= invitation.expiresAt) throw new Error("Telegram enrollment expired or was cancelled; start a new pairing invitation");
      interaction.status("A code was sent to the account that opened the invitation. Confirm only if you can see it in your intended Telegram chat.");
      for (let attempt = 0; attempt < 3 && !lifetime.aborted; attempt++) {
        const confirmed = enrollment.confirm(await interaction.readCode(lifetime), now());
        if (!confirmed) { interaction.status("That confirmation was not accepted. Check the code and invitation expiry."); continue; }
        if (lifetime.aborted) throw new Error("Telegram enrollment was cancelled");
        const recipient: Recipient = { channelId: `telegram:${api.botId}`, ...confirmed };
        save(recipient);
        enrollment.consume();
        ingress.receive([], progress);
        return recipient;
      }
      throw new Error("Telegram enrollment was not confirmed; start a new pairing invitation");
    }
    throw new Error("Telegram enrollment expired or was cancelled; start a new pairing invitation");
  } finally {
    await release();
  }
}
