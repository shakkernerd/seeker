import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramEnrollment } from "../src/channels/telegram/enrollment";
import { claimReceiver } from "../src/channels/telegram/receiver-lock";

describe("deliberate Telegram enrollment", () => {
  test("only the expected private account/chat can use the one-use invitation", () => {
    const enrollment = new TelegramEnrollment({ actorId: "42", conversationId: "42" }, 1_000);
    const invite = enrollment.invitation("seeker_test_bot");
    const nonce = new URL(invite.url).searchParams.get("start");
    const message = { from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text: `/start ${nonce}` };
    expect(invite.expiresAt).toBe(601_000);
    expect(enrollment.match({ ...message, from: { id: 99, is_bot: false, username: "owner" } }, 1_001)).toBeUndefined();
    expect(enrollment.match({ ...message, chat: { id: 99, type: "private" } }, 1_001)).toBeUndefined();
    expect(enrollment.match({ ...message, chat: { id: 42, type: "group" } }, 1_001)).toBeUndefined();
    expect(enrollment.match({ ...message, from: { id: 42, is_bot: true } }, 1_001)).toBeUndefined();
    expect(enrollment.match({ ...message, text: "/start wrong" }, 1_001)).toBeUndefined();
    expect(enrollment.match(message, 1_001)).toEqual({ actorId: "42", conversationId: "42" });
    enrollment.consume();
    expect(enrollment.match(message, 1_002)).toBeUndefined();
    expect(JSON.stringify(enrollment)).not.toContain(nonce);
  });

  test("expired and pre-restart invitations cannot enroll an owner", () => {
    const old = new TelegramEnrollment({ actorId: "42", conversationId: "42" }, 1_000);
    const nonce = new URL(old.invitation("seeker_test_bot").url).searchParams.get("start");
    const message = { from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text: `/start ${nonce}` };
    expect(old.match(message, 601_000)).toBeUndefined();
    const restarted = new TelegramEnrollment({ actorId: "42", conversationId: "42" }, 1_001);
    expect(restarted.match(message, 1_002)).toBeUndefined();
  });

  test("one receiver per bot is owned until release, including different store callers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeker-telegram-lock-"));
    try {
      const release = await claimReceiver("123456789", directory);
      expect(JSON.parse(await readFile(join(directory, "123456789.lock"), "utf8"))).toEqual({ pid: process.pid });
      await expect(claimReceiver("123456789", directory)).rejects.toThrow("Cannot claim Telegram receiver");
      await release();
      await release();
      const restarted = await claimReceiver("123456789", directory);
      await restarted();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
