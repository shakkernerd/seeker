import { afterEach, expect, test } from "bun:test";
import type { ChannelIngress, ChannelMessage, InboundReply, ReceiveProgress } from "../src/contracts";
import { TelegramApi } from "../src/channels/telegram/api";
import { TelegramChannel } from "../src/channels/telegram/channel";

const TOKEN = "123456789:TEST_TOKEN_NOT_REAL_0123456789ABCDE";
const owner = { actorId: "42", conversationId: "42" };
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function setup(handler?: (method: string, body: Record<string, unknown>) => Response | undefined) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const method = new URL(request.url).pathname.split("/").at(-1)!;
    const body = await request.json() as Record<string, unknown>;
    calls.push({ method, body });
    const custom = handler?.(method, body);
    if (custom) return custom;
    return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: 101, chat: { id: 42, type: "private" } } : method === "getUpdates" ? [] : true });
  } });
  servers.push(server);
  let now = 1_000;
  const api = new TelegramApi(TOKEN, (url, init) => {
    expect(new URL(url).origin).toBe("https://api.telegram.org");
    return fetch(new URL(new URL(url).pathname, server.url), init);
  });
  const reports: string[] = [];
  const channel = new TelegramChannel(api, owner, { now: () => now, sleep: async (ms) => { now += ms; }, report: (message) => reports.push(message) });
  return { channel, calls, reports, advance: (ms: number) => { now += ms; } };
}

function request(): ChannelMessage {
  return {
    deliveryId: "delivery-one", exchangeId: "question-one", managerLabel: "Build manager",
    recipient: { channelId: "telegram:123456789", ...owner },
    revision: { number: 1, createdAt: 1, replyHandle: "opaque-revision-handle", decision: {
      kind: "decision", title: "Choose target", question: "Use staging?", context: "A preview is ready.",
      target: "staging", effect: "Publish the preview", scope: "This preview only", conditions: "Keep production untouched",
      recommendation: "Use staging", options: [{ id: "use-staging", label: "Use staging", meaning: "Publish this preview to staging", kind: "approve" }],
    } },
  };
}

test("sends complete bounded context to only the paired owner and binds accepted reference", async () => {
  const { channel, calls } = setup();
  const signal = new AbortController().signal;
  const message = request();
  expect(await channel.send(message, signal)).toEqual({ status: "accepted", reference: "101" });
  const body = calls[0]!.body;
  expect(body.chat_id).toBe("42");
  expect(body.parse_mode).toBeUndefined();
  expect(body.link_preview_options).toEqual({ is_disabled: true });
  for (const value of ["Build manager", "question-one", "Use staging?", "Keep production untouched", "This preview only", "A preview is ready."]) expect(body.text).toContain(value);
  expect(body.reply_markup).toMatchObject({ inline_keyboard: [[{ text: "Use staging", callback_data: "opaque-revision-handle:a:use-staging" }], [{ callback_data: "opaque-revision-handle:q" }]] });
  expect(await channel.send({ ...message, recipient: { ...message.recipient, actorId: "99" } }, signal)).toMatchObject({ status: "rejected" });
  expect(calls).toHaveLength(1);
});

test("does not truncate material context, and honors per-chat and provider backoff", async () => {
  const { channel, calls, advance } = setup((method) => method === "sendMessage" ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 17 } }, { status: 429 }) : undefined);
  const signal = new AbortController().signal;
  const tooLarge = request();
  tooLarge.revision.decision.conditions = "c".repeat(4_096);
  expect(await channel.send(tooLarge, signal)).toMatchObject({ status: "rejected", code: "telegram-message-too-large" });
  expect(calls).toHaveLength(0);
  expect(await channel.send(request(), signal)).toMatchObject({ status: "retry", retryAfterMs: 17_000 });
  advance(1_000);
  expect(await channel.send(request(), signal)).toMatchObject({ status: "retry", retryAfterMs: 16_000 });
  expect(calls).toHaveLength(1);
});

test("commits whole out-of-order batch before cursor ACK and authenticates actor plus chat", async () => {
  let progress: ReceiveProgress | undefined;
  const received: InboundReply[][] = [];
  const ingress: ChannelIngress = {
    progress: () => progress,
    receive: (events, next) => { received.push(events); progress = next; return events.map((event) => ({ eventId: event.eventId, status: "recorded" })); },
    pending: () => [], resolveMessage: () => undefined,
  };
  const incoming = (id: number, from = 42, chat = 42, text = "Why is this needed?") => ({ update_id: id, message: { message_id: id + 10, from: { id: from, is_bot: false }, chat: { id: chat, type: "private" }, text, date: 1 } });
  const { channel, calls } = setup((method, body) => {
    if (method !== "getUpdates") return;
    if (body.offset === undefined) return Response.json({ ok: true, result: [incoming(9), incoming(7, 99), incoming(8, 42, 99), incoming(6)] });
    expect(progress?.cursor).toBe("10");
    expect(received[0]?.map((event) => event.eventId)).toEqual(["6", "9"]);
    return Response.json({ ok: true, result: [] });
  });
  await channel.pollOnce(ingress, new AbortController().signal);
  expect(received[0]!.every((event) => event.kind === "question")).toBe(true);
  await channel.pollOnce(ingress, new AbortController().signal);
  expect(calls.filter((call) => call.method === "getUpdates").map((call) => call.body.offset)).toEqual([undefined, 10]);
});

test("durability failure prevents offset advancement and callback acknowledgement", async () => {
  const { channel, calls } = setup((method) => method === "getUpdates" ? Response.json({ ok: true, result: [{ update_id: 3, message: { message_id: 3, from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text: "yes" } }] }) : undefined);
  const ingress: ChannelIngress = { progress: () => undefined, receive: () => { throw new Error("disk full"); }, pending: () => [], resolveMessage: () => undefined };
  await expect(channel.pollOnce(ingress, new AbortController().signal)).rejects.toThrow("disk full");
  expect(calls.map((call) => call.method)).toEqual(["getUpdates"]);
});

test("a lower update ID after a quiet week replaces the old cursor and can be acknowledged", async () => {
  let progress: ReceiveProgress = { cursor: "900000001", lastReceivedAt: 0, continuity: "continuous" };
  const received: InboundReply[] = [];
  const { channel, calls } = setup((method, body) => method === "getUpdates" ? Response.json({ ok: true, result: body.offset === 300000001 ? [] : [{ update_id: 300000000, message: { message_id: 99, from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text: "Why?" } }] }) : undefined);
  const ingress: ChannelIngress = { progress: () => progress, receive: (events, next) => { received.push(...events); progress = next!; return events.map((event) => ({ eventId: event.eventId, status: "recorded" })); }, pending: () => [], resolveMessage: () => undefined };
  await channel.pollOnce(ingress, new AbortController().signal);
  await channel.pollOnce(ingress, new AbortController().signal);
  expect(progress.cursor).toBe("300000001");
  expect(received).toHaveLength(1);
  expect(calls.filter((call) => call.method === "getUpdates").map((call) => call.body.offset)).toEqual([900000001, 300000001]);
});

test("unsupported media gets an honest text path, never a human decision", async () => {
  const { channel, calls } = setup((method) => method === "getUpdates" ? Response.json({ ok: true, result: [{ update_id: 3, message: { message_id: 3, from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, voice: { file_id: "fake" } } }] }) : undefined);
  const events: InboundReply[] = [];
  const ingress: ChannelIngress = { progress: () => undefined, receive: (batch) => { events.push(...batch); return []; }, pending: () => [], resolveMessage: () => undefined };
  await channel.pollOnce(ingress, new AbortController().signal);
  expect(events).toHaveLength(0);
  expect(calls.find((call) => call.method === "sendMessage")?.body.text).toContain("supports text replies only");
});

test("definitely rate-limited support replies retry after backoff, uncertain sends do not", async () => {
  for (const uncertain of [false, true]) {
    let sends = 0;
    const { channel, calls, reports } = setup((method) => {
      if (method === "getUpdates") return Response.json({ ok: true, result: [{ update_id: 3, message: { message_id: 3, from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, voice: { file_id: "fake" } } }] });
      if (method === "sendMessage" && sends++ === 0) return uncertain ? new Response("lost response") : Response.json({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, { status: 429 });
    });
    const ingress: ChannelIngress = { progress: () => undefined, receive: () => [], pending: () => [], resolveMessage: () => undefined };
    await channel.pollOnce(ingress, new AbortController().signal);
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(uncertain ? 1 : 2);
    expect(reports.length).toBe(uncertain ? 1 : 0);
  }
});
