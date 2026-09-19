import { afterEach, expect, test } from "bun:test";
import type { ChannelIngress, ReceiveProgress, Recipient } from "../src/contracts";
import { TelegramApi } from "../src/channels/telegram/api";
import { pairTelegram } from "../src/channels/telegram/pairing";

const TOKEN = "123456789:TEST_TOKEN_NOT_REAL_0123456789ABCDE";
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

async function attempt(confirm: boolean, rejectSave = false, priorCursor?: string) {
  let nonce = "";
  let sentCode = "";
  let saved: Recipient | undefined;
  const initialProgress: ReceiveProgress | undefined = priorCursor ? { cursor: priorCursor, lastReceivedAt: 0, continuity: "continuous" } : undefined;
  let progress = initialProgress;
  let released = false;
  const statuses: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const method = new URL(request.url).pathname.split("/").at(-1);
    const body = await request.json() as Record<string, unknown>;
    if (method === "getMe") return Response.json({ ok: true, result: { id: 123456789, is_bot: true, username: "seeker_test_bot" } });
    if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
    if (method === "getUpdates") return Response.json({ ok: true, result: [{ update_id: 1, message: { message_id: 10, from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text: `/start ${nonce}` } }] });
    if (method === "sendMessage") {
      expect(saved).toBeUndefined();
      expect(progress).toEqual(initialProgress);
      expect(body.chat_id).toBe("42");
      sentCode = String(body.text).match(/code: (\d{6})/)![1]!;
      return Response.json({ ok: true, result: { message_id: 11, chat: { id: 42, type: "private" } } });
    }
    return Response.json({ ok: false, error_code: 400 }, { status: 400 });
  } });
  servers.push(server);
  const api = new TelegramApi(TOKEN, (url, init) => fetch(new URL(new URL(url).pathname, server.url), init));
  const ingress: ChannelIngress = { progress: () => progress, receive: (_events, next) => { progress = next; return []; }, resolveMessage: () => undefined, pending: () => [] };
  const result = await pairTelegram(api, ingress, {
    invitation: (url) => { nonce = new URL(url).searchParams.get("start")!; },
    readCode: async () => {
      expect(saved).toBeUndefined();
      expect(sentCode).not.toBe("");
      expect(statuses.join(" ")).not.toContain(sentCode);
      return confirm ? sentCode : "not the code";
    }, status: (text) => statuses.push(text),
  }, (recipient) => {
    if (rejectSave) throw new Error("disk full");
    saved = recipient;
  }, new AbortController().signal, { claim: async () => async () => { released = true; } }).catch((error: unknown) => error);
  return { result, saved, progress, released };
}

test("actual provider exchange saves owner only after code from that chat is confirmed locally", async () => {
  const result = await attempt(true);
  expect(result.result).toEqual({ channelId: "telegram:123456789", actorId: "42", conversationId: "42" });
  expect(result.saved).toEqual({ channelId: "telegram:123456789", actorId: "42", conversationId: "42" });
  expect(result.progress?.cursor).toBe("2");
  expect(result.released).toBe(true);
});

test("a stranger with an invitation cannot become owner without local confirmation", async () => {
  const result = await attempt(false);
  expect(result.result).toBeInstanceOf(Error);
  expect(result.saved).toBeUndefined();
  expect(result.progress).toBeUndefined();
  expect(result.released).toBe(true);
});

test("failed durable binding prevents pairing completion and polling ACK", async () => {
  const result = await attempt(true, true);
  expect(result.result).toBeInstanceOf(Error);
  expect(result.saved).toBeUndefined();
  expect(result.progress).toBeUndefined();
  expect(result.released).toBe(true);
});

test("pairing commits a new lower update ID after the provider resets its sequence", async () => {
  const result = await attempt(true, false, "900000001");
  expect(result.saved).toBeDefined();
  expect(result.progress?.cursor).toBe("2");
});
