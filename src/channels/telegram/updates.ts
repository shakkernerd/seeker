import { isRecord, TelegramApi, TelegramError } from "./api";

/** Collection does not acknowledge this batch; the caller first commits its returned cursor. */
export async function pollUpdates(api: TelegramApi, cursor: string | undefined, allowed: string[], signal: AbortSignal) {
  const offset = cursor === undefined ? undefined : Number(cursor);
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error("Invalid stored Telegram polling cursor");
  const result = await api.call("getUpdates", {
    ...(offset === undefined ? {} : { offset }), limit: 100, timeout: 30, allowed_updates: allowed,
  }, signal);
  if (!Array.isArray(result) || result.length > 100 || result.some((update) => !isRecord(update) || !Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0 || Number(update.update_id) >= Number.MAX_SAFE_INTEGER)) {
    throw new TelegramError("invalid-response", "unknown");
  }
  const updates = (result as Record<string, unknown>[]).sort((left, right) => Number(left.update_id) - Number(right.update_id));
  // After a quiet week Telegram may choose a new, lower update ID. A nonempty
  // batch replaces the old cursor; treating it as a monotonic watermark loops forever.
  const next = updates.length ? String(Number(updates.at(-1)!.update_id) + 1) : cursor;
  return { updates, cursor: next };
}
