import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, HostAdapter, ManagerBinding } from "../src/contracts";
import { DeliveryPump } from "../src/core/delivery";
import { SeekerCore } from "../src/core/seeker";
import { SqliteExchangeStore } from "../src/store/sqlite";
import { TelegramApi } from "../src/channels/telegram/api";
import { TelegramChannel } from "../src/channels/telegram/channel";

const TOKEN = "123456789:TEST_TOKEN_NOT_REAL_0123456789ABCDE";
const recipient = { channelId: "telegram:123456789", actorId: "42", conversationId: "42" };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function decision(target = "staging"): Decision {
  return { kind: "decision", title: "Preview target", question: `Publish to ${target}?`, context: "Preview is ready.", target,
    effect: "Publish a preview", scope: "This preview only", conditions: "Keep production untouched", options: [
      { id: "publish", label: "Publish", meaning: `Publish to ${target}`, kind: "approve" },
      { id: "wait", label: "Wait", meaning: "Do not publish", kind: "decline" },
    ] };
}

async function fixture(dropSendResponse = false) {
  const directory = await mkdtemp(join(tmpdir(), "seeker-telegram-store-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "exchanges.sqlite");
  let store = new SqliteExchangeStore(filename);
  let now = 1_000;
  let core = new SeekerCore(store, () => now);
  const updates: unknown[] = [];
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const sent: Record<string, any>[] = [];
  const returned: string[] = [];
  const host: HostAdapter = { id: "test-host", deliver: async (binding, envelope) => {
    returned.push(`${binding.origin.managerId}:${envelope.receipt.id}`);
    return { status: "accepted", reference: envelope.receipt.id };
  } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const method = new URL(request.url).pathname.split("/").at(-1)!;
    const body = await request.json() as Record<string, unknown>;
    calls.push({ method, body });
    if (method === "getUpdates") return Response.json({ ok: true, result: updates.splice(0) });
    if (method === "getMe") return Response.json({ ok: true, result: { id: 123456789, is_bot: true, username: "seeker_test_bot" } });
    if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
    if (method === "sendMessage") {
      const message = { ...body, message_id: sent.length + 101, date: Math.floor(now / 1_000), chat: { id: 42, type: "private" }, from: { id: 123456789, is_bot: true } };
      sent.push(message);
      return Response.json({ ok: true, result: message });
    }
    return Response.json({ ok: true, result: true });
  } });
  cleanup.push(() => server.stop(true));
  let loseNext = dropSendResponse;
  const api = new TelegramApi(TOKEN, async (url, init) => {
    const response = await fetch(new URL(new URL(url).pathname, server.url), init);
    if (loseNext && url.endsWith("/sendMessage")) {
      loseNext = false;
      await response.arrayBuffer();
      throw new Error("Controlled connection loss after provider accepted send");
    }
    return response;
  });
  const makeChannel = () => new TelegramChannel(api, recipient, { now: () => now, sleep: async (ms) => { now += ms; } });
  let channel = makeChannel();
  let pump = new DeliveryPump(core, [channel], [host]);
  cleanup.push(() => { pump.stop(); store.close(); });
  function bind(id: string) {
    const binding: ManagerBinding = { id, label: id, recipient, origin: { hostId: "test-host", managerId: id, assignmentId: id, generation: 1 } };
    core.bind(binding);
    return core.manager(binding.origin);
  }
  async function flush() {
    pump.tick();
    for (let i = 0; i < 200 && pump.inFlight; i++) await Bun.sleep(1);
    expect(pump.inFlight).toBe(0);
    expect(pump.lastError).toBeUndefined();
  }
  return { bind, sent, updates, calls, returned, flush, filename,
    get store() { return store; }, get core() { return core; }, get channel() { return channel; },
    advance: () => { now += 2_000; },
    poll: () => channel.pollOnce(core.channel(channel.id), new AbortController().signal),
    restart: () => {
      pump.stop(); store.close();
      store = new SqliteExchangeStore(filename); core = new SeekerCore(store, () => now);
      channel = makeChannel(); pump = new DeliveryPump(core, [channel], [host]);
      store.recoverInterruptedDeliveries();
    },
  };
}

function reply(updateId: number, text: string, replyTo?: Record<string, unknown>) {
  return { update_id: updateId, message: { message_id: updateId + 1_000, date: 100, from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text, ...(replyTo ? { reply_to_message: replyTo } : {}) } };
}
function click(updateId: number, callbackId: string, message: Record<string, any>, index = 0) {
  return { update_id: updateId, callback_query: { id: callbackId, from: { id: 42, is_bot: false }, message, data: message.reply_markup.inline_keyboard[index][0].callback_data } };
}

test("real store routes two managers, natural discussion, stale choices and late corrections across restart", async () => {
  const f = await fixture();
  const alpha = f.bind("alpha");
  const beta = f.bind("beta");
  alpha.submit({ requestId: "alpha-request", decision: decision() });
  beta.submit({ requestId: "beta-request", decision: decision() });
  await f.flush(); f.advance(); await f.flush();
  const alphaMessage = f.sent.find((message) => message.text.includes("alpha-request"))!;
  const betaMessage = f.sent.find((message) => message.text.includes("beta-request"))!;
  expect(alphaMessage).toBeDefined(); expect(betaMessage).toBeDefined();
  f.updates.push(reply(3, "yes"), reply(2, "Why is that needed?", alphaMessage));
  await f.poll(); await f.flush();
  expect(alpha.get("alpha-request").exchange.receipts).toHaveLength(1);
  expect(beta.get("beta-request").exchange.receipts).toHaveLength(0);
  expect(alpha.get("alpha-request").exchange.state).toBe("waiting");
  expect(f.returned[0]).toStartWith("alpha:");
  alpha.update({ type: "context", requestId: "alpha-request", messageId: "context-one", expectedVersion: alpha.get("alpha-request").exchange.version, text: "The preview will let us inspect the result before production." });
  f.advance(); await f.flush();
  const context = f.sent.find((message) => message.text.includes("inspect the result before production"))!;
  expect(context).toBeDefined();
  expect(f.core.channel(f.channel.id).resolveMessage("42", String(context.message_id))).toBe(alpha.get("alpha-request").exchange.revisions[0]!.replyHandle);
  const betaClick = click(4, "one-callback", betaMessage);
  f.updates.push(betaClick, click(5, "one-callback", betaMessage), click(6, "second-click", betaMessage));
  await f.poll(); await f.flush();
  expect(beta.get("beta-request").exchange.receipts).toHaveLength(1);
  expect(f.returned.filter((entry) => entry.startsWith("beta:"))).toHaveLength(1);
  f.restart();
  f.updates.push(betaClick);
  await f.poll(); await f.flush();
  expect(f.calls.filter((call) => call.method === "getUpdates").at(-1)!.body.offset).toBe(7);
  expect(f.store.get("beta-request")!.exchange.receipts).toHaveLength(1);
  const resumed = f.core.manager({ hostId: "test-host", managerId: "alpha", assignmentId: "alpha", generation: 1 });
  resumed.update({ type: "revise", requestId: "alpha-request", expectedVersion: resumed.get("alpha-request").exchange.version, decision: decision("preview-two") });
  f.advance(); await f.flush();
  f.updates.push(click(7, "stale-click", alphaMessage), reply(8, "yes", alphaMessage));
  await f.poll();
  expect(resumed.get("alpha-request").exchange.receipts).toHaveLength(1);
  f.updates.push(reply(9, "Actually do not publish anything yet", alphaMessage));
  await f.poll(); await f.flush();
  const correction = resumed.get("alpha-request").exchange.receipts.at(-1)!;
  expect(correction.classification).toBe("correction");
  expect(correction.revision).toBe(1);
  expect(correction.text).toBe("Actually do not publish anything yet");
  expect(resumed.get("alpha-request").exchange.state).toBe("reconcile");
  expect(JSON.stringify(f.store.get("alpha-request"))).not.toContain(TOKEN);
});

test("lost send response remains unknown without retry, but an authenticated reply recovers its durable handle", async () => {
  const f = await fixture(true);
  const manager = f.bind("alpha");
  manager.submit({ requestId: "lost-send", decision: decision() });
  await f.flush();
  expect(f.store.get("lost-send")!.deliveries[0]!.state).toBe("unknown");
  const original = f.sent[0]!;
  f.restart(); f.advance(); await f.flush();
  expect(f.sent).toHaveLength(1);
  f.updates.push(reply(1, "Why do we need this?", original));
  await f.poll(); await f.flush();
  expect(f.store.get("lost-send")!.exchange.receipts).toHaveLength(1);
  expect(f.store.get("lost-send")!.exchange.receipts[0]!.kind).toBe("question");
  expect(f.returned[0]).toStartWith("alpha:");
});
