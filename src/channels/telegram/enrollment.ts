import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { isRecord, telegramId } from "./api";

export type TelegramOwner = { actorId: string; conversationId: string };

/** Pending enrollment is deliberately ephemeral. Restart requires a new invitation. */
export class TelegramEnrollment {
  readonly #nonce = randomBytes(32).toString("base64url");
  readonly #expected?: TelegramOwner;
  readonly #expiresAt: number;
  #candidate?: TelegramOwner;
  #confirmation?: string;
  #consumed = false;

  constructor(expected?: TelegramOwner, now = Date.now()) {
    if (expected && (!validId(expected.actorId) || !validId(expected.conversationId))) {
      throw new Error("Telegram enrollment requires trusted numeric user and private chat IDs");
    }
    this.#expected = expected ? { ...expected } : undefined;
    this.#expiresAt = now + 10 * 60_000;
  }

  invitation(botUsername: string): { url: string; expiresAt: number } {
    if (!/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) throw new Error("Invalid Telegram bot username");
    return { url: `https://t.me/${botUsername}?start=${this.#nonce}`, expiresAt: this.#expiresAt };
  }

  match(message: unknown, now = Date.now()): TelegramOwner | undefined {
    if (this.#consumed || now >= this.#expiresAt || !isRecord(message)) return;
    if (!isRecord(message.from) || message.from.is_bot !== false || !isRecord(message.chat)) return;
    const actorId = telegramId(message.from.id);
    const conversationId = telegramId(message.chat.id);
    if (message.chat.type !== "private" || !actorId || !conversationId) return;
    if (this.#expected && (actorId !== this.#expected.actorId || conversationId !== this.#expected.conversationId)) return;
    if (typeof message.text !== "string" || !message.text.startsWith("/start ")) return;
    const supplied = Buffer.from(message.text.slice(7));
    const expected = Buffer.from(this.#nonce);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return;
    if (this.#candidate && (actorId !== this.#candidate.actorId || conversationId !== this.#candidate.conversationId)) return;
    return { actorId, conversationId };
  }

  /** Code is sent only into the observed chat, never displayed in the local terminal. */
  challenge(owner: TelegramOwner): string {
    if (this.#candidate || this.#consumed) throw new Error("Telegram enrollment already has a candidate");
    this.#candidate = { ...owner };
    this.#confirmation = String(randomInt(100_000, 1_000_000));
    return this.#confirmation;
  }

  confirm(code: string, now = Date.now()): TelegramOwner | undefined {
    if (this.#consumed || now >= this.#expiresAt || !this.#candidate || !this.#confirmation) return;
    const supplied = Buffer.from(code.trim());
    const expected = Buffer.from(this.#confirmation);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return;
    return { ...this.#candidate };
  }

  /** Call only after trusted setup has durably saved the fixed recipient. */
  consume(): void { this.#consumed = true; }
  get expired(): boolean { return this.#consumed || Date.now() >= this.#expiresAt; }
}

export function validId(value: string): boolean {
  return /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}
