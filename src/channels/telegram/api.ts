import { Api, GrammyError, type RawApi } from "grammy/web";

/** The credential boundary. SDK errors may contain payloads; never expose them or their causes. */
export class TelegramError extends Error {
  constructor(
    readonly code: "cancelled" | "transport" | "invalid-response" | "rejected" | "rate-limited",
    readonly outcome: "rejected" | "unknown",
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram ${code}${status === undefined ? "" : ` (${status})`}`);
    this.name = "TelegramError";
  }
}

// Internal injection seam: production configuration cannot change the provider origin.
export type TelegramTransport = (url: string, init: RequestInit) => Promise<Response>;
export type TelegramMethod = "getMe" | "getWebhookInfo" | "getUpdates" | "sendMessage" | "answerCallbackQuery";

export class TelegramApi {
  readonly #api: Api;
  readonly botId: string;

  constructor(token: string, transport: TelegramTransport = fetch) {
    if (!/^[1-9]\d{0,15}:[A-Za-z0-9_-]{20,100}$/.test(token)) {
      throw new Error("Invalid Telegram bot token format");
    }
    this.botId = token.slice(0, token.indexOf(":"));
    this.#api = new Api(token, {
      sensitiveLogs: false,
      timeoutSeconds: 40,
      baseFetchConfig: { redirect: "error" },
      // Use Bun's fetch in production. Only this internal seam is replaced by tests.
      fetch: ((input, init) => transport(String(input), init ?? {})) as typeof fetch,
    });
  }

  async call(method: TelegramMethod, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new TelegramError("cancelled", "rejected");
    const timeout = AbortSignal.timeout(method === "getUpdates" ? 40_000 : 15_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // The web runtime uses native signals; grammY's shared declarations name its Node polyfill.
    const sdkSignal = requestSignal as unknown as Parameters<RawApi["getMe"]>[0];
    try {
      const value = method === "getMe" || method === "getWebhookInfo"
        ? await this.#api.raw[method](sdkSignal)
        : await (this.#api.raw[method] as (payload: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>)(body, requestSignal);
      if (value === undefined) throw new TelegramError("invalid-response", "unknown");
      return value;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      if (error instanceof GrammyError) {
        const status = Number.isSafeInteger(error.error_code) ? error.error_code : undefined;
        if (status === 429) {
          const retry = error.parameters?.retry_after ?? 1;
          if (!Number.isSafeInteger(retry) || retry <= 0 || !Number.isSafeInteger(retry * 1_000)) throw new TelegramError("invalid-response", "unknown", status);
          throw new TelegramError("rate-limited", "rejected", status, retry);
        }
        // An explicit server failure still does not prove a send was never applied.
        throw new TelegramError("rejected", status !== undefined && status >= 400 && status < 500 ? "rejected" : "unknown", status);
      }
      // Once fetch starts, cancellation/timeouts may follow provider acceptance.
      throw new TelegramError(signal?.aborted ? "cancelled" : "transport", "unknown");
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function telegramId(value: unknown): string | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
}
