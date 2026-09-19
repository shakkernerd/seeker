import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Recipient } from "../../contracts";
import { SeekerError } from "../../core/validation";
import { ensureDataDir } from "../../local/config";
import { isRecord, TelegramApi } from "./api";
import { validId } from "./enrollment";

export interface TelegramConfig {
  version: 1;
  botId: string;
  actorId: string;
  conversationId: string;
  tokenFile: string;
}

export function loadTelegramConfig(dataDir: string): TelegramConfig | undefined {
  const path = join(dataDir, "telegram.json");
  let value: unknown;
  try { value = JSON.parse(readPrivateFile(path, 4_096)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new SeekerError("telegram_config", "Telegram configuration must be a valid private regular file (mode 600).");
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.botId !== "string" || !validId(value.botId) || typeof value.actorId !== "string" || !validId(value.actorId) || typeof value.conversationId !== "string" || !validId(value.conversationId) || typeof value.tokenFile !== "string" || !isAbsolute(value.tokenFile) || value.tokenFile.includes("\0")) {
    throw new SeekerError("telegram_config", "Telegram configuration is invalid. Preserve the existing pairing and consult the Telegram setup guide.");
  }
  return { version: 1, botId: value.botId, actorId: value.actorId, conversationId: value.conversationId, tokenFile: value.tokenFile };
}

export function loadTelegramRecipient(dataDir: string): Recipient | undefined {
  const config = loadTelegramConfig(dataDir);
  return config ? { channelId: `telegram:${config.botId}`, actorId: config.actorId, conversationId: config.conversationId } : undefined;
}

export function readTelegramToken(path: string): string {
  try {
    const token = readPrivateFile(path, 256).trim();
    new TelegramApi(token);
    return token;
  } catch { throw new SeekerError("telegram_token", "Telegram needs a valid bot token in a private regular file (mode 600), owned by your user."); }
}

export function saveTelegramConfig(dataDir: string, recipient: Recipient, tokenFile: string): void {
  const directory = ensureDataDir(dataDir);
  const botId = new TelegramApi(readTelegramToken(tokenFile)).botId;
  if (recipient.channelId !== `telegram:${botId}` || !validId(recipient.actorId) || !validId(recipient.conversationId)) throw new SeekerError("telegram_config", "Telegram pairing does not match the configured bot.");
  const value: TelegramConfig = { version: 1, botId, actorId: recipient.actorId, conversationId: recipient.conversationId, tokenFile: resolve(tokenFile) };
  const temporary = join(directory, `.telegram-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    try {
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    // Atomic create without replacing a concurrently written or existing owner binding.
    linkSync(temporary, join(directory, "telegram.json"));
    const parent = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch { throw new SeekerError("telegram_config", "Could not save Telegram pairing. Existing configuration was preserved; check the private data directory."); }
  finally { unlinkSync(temporary); }
}

function readPrivateFile(path: string, maxBytes: number): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe Telegram configuration file");
    return readFileSync(descriptor, "utf8");
  } finally { closeSync(descriptor); }
}
