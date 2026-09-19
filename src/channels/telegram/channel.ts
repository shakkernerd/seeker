import type { ChannelIngress, ChannelMessage, DeliveryResult, InboundReply, MessagingChannel, Recipient, ReplyKind } from "../../contracts";
import { createHash } from "node:crypto";
import { isRecord, TelegramApi, TelegramError, telegramId } from "./api";
import { validId, type TelegramOwner } from "./enrollment";
import { claimReceiver } from "./receiver-lock";
import { pollUpdates } from "./updates";

type Feedback = { updateId: string; messageId?: string; callbackId?: string; text?: string };
type Runtime = {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  claim: (botId: string) => Promise<() => Promise<void>>;
  report: (message: string) => void;
};

export class TelegramChannel implements MessagingChannel {
  readonly id: string;
  readonly #api: TelegramApi;
  readonly #recipient: Recipient;
  readonly #runtime: Runtime;
  #nextSendAt = 0;
  #nextCallbackAt = 0;
  #running = false;
  #receiverFailed = false;

  constructor(api: TelegramApi, owner: TelegramOwner, runtime: Partial<Runtime> = {}) {
    if (!validId(owner.actorId) || !validId(owner.conversationId)) throw new Error("Invalid Telegram owner binding");
    this.id = `telegram:${api.botId}`;
    this.#api = api;
    this.#recipient = { channelId: this.id, ...owner };
    this.#runtime = { now: Date.now, sleep: delay, claim: claimReceiver, report: () => {}, ...runtime };
  }

  async send(message: ChannelMessage, signal: AbortSignal): Promise<DeliveryResult> {
    if (this.#receiverFailed) return { status: "rejected", code: "telegram-receiver-stopped" };
    if (!sameRecipient(message.recipient, this.#recipient)) return { status: "rejected", code: "telegram-recipient-mismatch" };
    const rendered = render(message);
    if (!rendered) return { status: "rejected", code: "telegram-message-too-large" };
    return this.#sendText(rendered, signal);
  }

  async #sendText(body: Record<string, unknown>, signal: AbortSignal): Promise<DeliveryResult> {
    if (signal.aborted) return { status: "rejected", code: "telegram-cancelled" };
    const wait = this.#nextSendAt - this.#runtime.now();
    if (wait > 0) return { status: "retry", retryAfterMs: wait, code: "telegram-rate-limit" };
    this.#nextSendAt = this.#runtime.now() + 1_000;
    try {
      const result = await this.#api.call("sendMessage", {
        ...body,
        chat_id: this.#recipient.conversationId,
        link_preview_options: { is_disabled: true },
      }, signal);
      if (!isRecord(result) || !telegramId(result.message_id) || !isRecord(result.chat) || telegramId(result.chat.id) !== this.#recipient.conversationId || result.chat.type !== "private") {
        return { status: "unknown", code: "telegram-invalid-send-result" };
      }
      return { status: "accepted", reference: String(result.message_id) };
    } catch (error) {
      if (!(error instanceof TelegramError)) return { status: "unknown", code: "telegram-send-failed" };
      if (error.retryAfterSeconds !== undefined) {
        const wait = error.retryAfterSeconds * 1_000;
        this.#nextSendAt = Math.max(this.#nextSendAt, this.#runtime.now() + wait);
        return { status: "retry", retryAfterMs: wait, code: "telegram-rate-limit" };
      }
      return { status: error.outcome, code: `telegram-${error.code}${error.status === undefined ? "" : `-${error.status}`}` };
    }
  }

  /** One owned long-polling receiver. Core commits each complete batch before another offset is sent. */
  async run(ingress: ChannelIngress, signal: AbortSignal, ready?: () => void): Promise<void> {
    if (this.#running) throw new Error("Telegram receiver is already running");
    this.#running = true;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await this.#runtime.claim(this.#api.botId);
      await verifyBot(this.#api, signal);
      this.#receiverFailed = false;
      ready?.();
      let failures = 0;
      while (!signal.aborted) {
        try {
          await this.pollOnce(ingress, signal);
          failures = 0;
        } catch (error) {
          if (signal.aborted) break;
          if (!(error instanceof TelegramError)) throw new Error("Telegram inbound acceptance failed; receiver stopped before acknowledgement");
          if (error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 429) throw error;
          this.#runtime.report(error.message);
          const wait = error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1_000 : Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5));
          await this.#runtime.sleep(wait, signal);
        }
      }
    } catch (error) {
      if (!signal.aborted) { this.#receiverFailed = true; throw error; }
    } finally {
      this.#running = false;
      await release?.();
    }
  }

  async pollOnce(ingress: ChannelIngress, signal: AbortSignal): Promise<void> {
    const previous = ingress.progress();
    const batch = await pollUpdates(this.#api, previous?.cursor, ["message", "edited_message", "callback_query"], signal);
    const events: InboundReply[] = [];
    const feedback: Feedback[] = [];
    for (const update of batch.updates) {
      const updateId = String(update.update_id);
      const parsed = this.#parse(update, ingress);
      const eventId = isRecord(update.callback_query) && typeof update.callback_query.id === "string" ? callbackReference(update.callback_query.id) : updateId;
      if (parsed.event) events.push({ ...parsed.event, eventId });
      if (parsed.feedback) feedback.push({ ...parsed.feedback, updateId: eventId });
    }
    const now = this.#runtime.now();
    const continuity = previous?.continuity === "possible-gap" || (previous && now - previous.lastReceivedAt > 24 * 60 * 60_000) ? "possible-gap" : "continuous";
    const results = ingress.receive(events, {
      ...(batch.cursor === undefined ? {} : { cursor: batch.cursor }),
      lastReceivedAt: now, continuity,
    });
    if (continuity === "possible-gap" && previous?.continuity !== "possible-gap") this.#runtime.report("Telegram receiver was offline beyond update retention; some input may be missing");
    // Callback acknowledgements and support replies never claim manager consumption or approval.
    for (const item of feedback) {
      if (signal.aborted) break;
      const result = results.find((entry) => entry.eventId === item.updateId);
      const text = item.text ?? feedbackText(result?.status, result?.code);
      if (item.callbackId) {
        if (this.#runtime.now() < this.#nextCallbackAt) continue;
        try {
          await this.#api.call("answerCallbackQuery", { callback_query_id: item.callbackId, text, cache_time: 0 }, signal);
        } catch (error) {
          if (error instanceof TelegramError && error.retryAfterSeconds !== undefined) this.#nextCallbackAt = this.#runtime.now() + error.retryAfterSeconds * 1_000;
          if (!signal.aborted) this.#runtime.report("Telegram callback feedback was not confirmed");
        }
      } else if (text && result?.status !== "duplicate") {
        await this.#feedback({ text, ...(item.messageId ? { reply_parameters: { message_id: Number(item.messageId) } } : {}) }, signal);
      }
    }
  }

  async #feedback(body: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
      await this.#runtime.sleep(Math.max(0, this.#nextSendAt - this.#runtime.now()), signal);
      const sent = await this.#sendText(body, signal);
      if (sent.status === "accepted") return;
      if (sent.status === "retry" && attempt < 2) continue;
      if (!signal.aborted) this.#runtime.report(`Telegram support reply ${sent.status}; use the original manager conversation if it did not arrive`);
      return;
    }
  }

  #parse(update: Record<string, unknown>, ingress: ChannelIngress): { event?: Omit<InboundReply, "eventId">; feedback?: Omit<Feedback, "updateId"> } {
    const callback = isRecord(update.callback_query) ? update.callback_query : undefined;
    const message = callback ? callback.message : update.message ?? update.edited_message;
    if (!isRecord(message) || !isRecord(message.chat) || message.chat.type !== "private") return {};
    const from = callback?.from ?? message.from;
    if (!isRecord(from) || from.is_bot !== false || telegramId(from.id) !== this.#recipient.actorId || telegramId(message.chat.id) !== this.#recipient.conversationId) return {};
    const messageId = telegramId(message.message_id);
    if (!messageId) return {};
    const common = { actorId: this.#recipient.actorId, conversationId: this.#recipient.conversationId, sourceRef: messageId,
      ...(!callback && providerTime(message) !== undefined ? { occurredAt: providerTime(message) } : {}),
    };
    if (callback) {
      if (typeof callback.id !== "string" || callback.id.length > 256) return {};
      const feedback = { callbackId: callback.id };
      if (typeof callback.data !== "string" || callback.data.length > 64 || !isRecord(message.from) || message.from.is_bot !== true || telegramId(message.from.id) !== this.#api.botId) return { feedback: { ...feedback, text: "This action is unavailable. Reply to the request in text." } };
      const parsed = /^([A-Za-z0-9][A-Za-z0-9_-]{1,60}):(q|[adr]:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}))$/.exec(callback.data);
      const handle = parsed?.[1];
      const action = parsed?.[2];
      const known = ingress.resolveMessage(this.#recipient.conversationId, messageId);
      if (!handle || !action || (known && known !== handle)) return { feedback: { ...feedback, text: "This action does not match the request." } };
      if (action === "q") return { event: { ...common, sourceRef: callbackReference(callback.id), replyHandle: handle, kind: "question", text: "Could you provide more context?" }, feedback };
      const kind = action[0] === "a" ? "approve" : action[0] === "d" ? "decline" : "answer";
      // Core validates both the choice and kind against the immutable revision and
      // supplies its meaning. Closed exchanges still accept authentic corrections.
      return { event: { ...common, sourceRef: callbackReference(callback.id), replyHandle: handle, kind, optionId: parsed![3]!, text: "" }, feedback };
    }
    const feedback = { messageId };
    if (typeof message.text !== "string" || !message.text.trim() || message.text.includes("\0") || message.text.length > 4_096) return { feedback: { ...feedback, text: "Seeker supports text replies only (up to 4,096 characters). Please type your answer or question; this input was not interpreted." } };
    const text = message.text.trim();
    if (text === "/start" || text.startsWith("/start ") || text === "/help") return { feedback: { ...feedback, text: "Reply to a Seeker request to answer or ask a question. Use /pending to see open requests. Use /correct or /stop for a correction to an old request. Text only." } };
    if (text === "/pending") {
      const pending = ingress.pending(this.#recipient);
      const lines: string[] = [];
      let size = 0;
      for (const { exchange } of pending) {
        const line = `${exchange.managerLabel}: ${exchange.revisions.at(-1)?.decision.title} (${exchange.id})`;
        if (size + line.length > 3_600 || lines.length >= 15) break;
        lines.push(line);
        size += line.length + 1;
      }
      return { feedback: { ...feedback, text: lines.length ? `Open requests:\n${lines.join("\n")}\nReply to the original request to choose its manager.${pending.length > lines.length ? " Further requests remain with their originating managers." : ""}` : pending.length ? "Requests remain open. Reply to the original Telegram request or use its manager conversation." : "No open requests." } };
    }
    const reply = isRecord(message.reply_to_message) ? message.reply_to_message : undefined;
    const original = update.edited_message ? ingress.resolveMessage(this.#recipient.conversationId, messageId) : undefined;
    let replyToRef = reply && isRecord(reply.chat) && telegramId(reply.chat.id) === this.#recipient.conversationId ? telegramId(reply.message_id) : undefined;
    // An edit is never a new bare answer to whichever manager happens to be pending.
    if (update.edited_message && (original || !reply)) replyToRef = messageId;
    if (message.reply_to_message !== undefined && !replyToRef) return { feedback: { ...feedback, text: "That reply could not be matched. Reply directly to a Seeker request." } };
    // A send may have succeeded while its response was lost. The bot-authored reply
    // keyboard still carries the durable revision handle; never infer it from prose.
    const known = replyToRef ? ingress.resolveMessage(this.#recipient.conversationId, replyToRef) : undefined;
    const recovered = !known && reply && isRecord(reply.from) && reply.from.is_bot === true && telegramId(reply.from.id) === this.#api.botId ? keyboardHandle(reply.reply_markup) : undefined;
    const replyHandle = recovered;
    const kind: ReplyKind = update.edited_message ? "correction" : replyKind(text);
    return { event: { ...common, ...(replyToRef ? { replyToRef } : {}), ...(replyHandle ? { replyHandle } : {}), kind, text }, feedback };
  }
}

function render(message: ChannelMessage): Record<string, unknown> | undefined {
  const { decision, replyHandle } = message.revision;
  const heading = `${message.managerLabel} · ${message.exchangeId} · revision ${message.revision.number}`;
  const text = message.context
    ? `${heading}\n\n${message.context.text}\n\nReply to ask a question or clarify your answer.`
    : [heading, decision.title, decision.question, `Context: ${decision.context}`, `Target: ${decision.target}`, `Effect: ${decision.effect}`, `Scope: ${decision.scope}`, `Conditions: ${decision.conditions || "None stated"}`,
      ...(decision.recommendation ? [`Recommendation: ${decision.recommendation}`] : []),
      ...decision.options.map((option) => `${option.label}: ${option.meaning}`), "Reply naturally to answer or ask a question."].join("\n\n");
  const buttons = [
    ...(message.context ? [] : decision.options.map((option) => ({ text: option.label, callback_data: `${replyHandle}:${option.kind === "approve" ? "a" : option.kind === "decline" ? "d" : "r"}:${option.id}` }))),
    { text: "More context", callback_data: `${replyHandle}:q` },
  ];
  if (text.length > 4_096 || buttons.some((button) => new TextEncoder().encode(button.callback_data).length > 64)) return;
  return { text, reply_markup: { inline_keyboard: buttons.map((button) => [button]) } };
}

export async function verifyBot(api: TelegramApi, signal: AbortSignal): Promise<{ username: string }> {
  const bot = await api.call("getMe", {}, signal);
  if (!isRecord(bot) || bot.is_bot !== true || telegramId(bot.id) !== api.botId || typeof bot.username !== "string" || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username)) throw new Error("Telegram returned an invalid bot identity");
  const webhook = await api.call("getWebhookInfo", {}, signal);
  if (!isRecord(webhook) || typeof webhook.url !== "string") throw new Error("Telegram returned invalid webhook status");
  if (webhook.url !== "") throw new Error("This Telegram bot has a webhook. Use a dedicated bot with no other receiver.");
  return { username: bot.username };
}

function sameRecipient(left: Recipient, right: Recipient): boolean {
  return left.channelId === right.channelId && left.actorId === right.actorId && left.conversationId === right.conversationId;
}

function callbackReference(id: string): string {
  return `callback:${createHash("sha256").update(id).digest("hex")}`;
}

function providerTime(message: Record<string, unknown>): number | undefined {
  const value = message.edit_date ?? message.date;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value * 1_000) ? value * 1_000 : undefined;
}

function keyboardHandle(markup: unknown): string | undefined {
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard) || markup.inline_keyboard.length > 7) return;
  let handle: string | undefined;
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row) || row.length !== 1 || !isRecord(row[0]) || typeof row[0].callback_data !== "string") return;
    const match = /^([A-Za-z0-9][A-Za-z0-9_-]{1,60}):(?:q|[adr]:[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(row[0].callback_data);
    if (!match || (handle && handle !== match[1])) return;
    handle = match[1];
  }
  return handle;
}

function replyKind(text: string): ReplyKind {
  if (/^(\/stop\b|stop\b|cancel\b|don't\b|do not\b)/i.test(text)) return "stop";
  if (/^(\/correct\b|correction\b|actually\b|wait\b)/i.test(text)) return "correction";
  if (text.endsWith("?") || /^\/question\b/i.test(text)) return "question";
  return "answer";
}

function feedbackText(status?: string, code?: string): string {
  if (status === "deferred") return "Saved for manager review; no decision applied.";
  if (status === "recorded") return "Response saved for the originating manager. The manager still needs to handle it.";
  if (status === "duplicate") return "This response is already recorded.";
  if (status === "unmatched" || code === "ambiguous") return "Please reply to the specific Seeker request so I can identify its manager. Use /pending to see open requests.";
  if (code?.includes("stale")) return "That request has changed. Reply to the current request; use /correct or /stop to send a correction.";
  return "This response was not accepted. Reply to the current Seeker request in text.";
}

export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  for (let remaining = ms; remaining > 0 && !signal.aborted;) {
    const interval = Math.min(remaining, 2_147_483_647);
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, interval);
      signal.addEventListener("abort", finish, { once: true });
    });
    remaining -= interval;
  }
}
