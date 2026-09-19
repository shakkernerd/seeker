import type { ReadCollection, ReadOptions } from "../contracts.ts";
import { fail, id, integer, object, text } from "./validation.ts";

export function readSelection(options: ReadOptions = {}) {
  object(options);
  const collection: ReadCollection = options.collection ?? "receipts";
  if (!["receipts", "deferred", "context", "revisions", "deliveries"].includes(collection)) fail("invalid_read", "Unknown read collection.");
  if (options.itemId && options.cursor) fail("invalid_read", "Choose an exact item or a page cursor.");
  let position = 0;
  if (options.cursor !== undefined) {
    text(options.cursor, "Read cursor", 128);
    const parts = options.cursor.split(":");
    if (parts.length !== 2 || parts[0] !== collection || !/^[0-9]+$/.test(parts[1]!)) fail("invalid_cursor", "Use this collection's returned cursor.");
    position = integer(Number(parts[1]), "Read position", 0);
  }
  if (options.itemId !== undefined) id(options.itemId, "Read item");
  if (options.channelId !== undefined) id(options.channelId, "Read channel");
  if (collection === "deferred" && options.itemId && !options.channelId) fail("invalid_read", "A deferred event needs its original channel identity.");
  return { collection, position, itemId: options.itemId, channelId: options.channelId };
}
