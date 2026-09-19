import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, HostAdapter, IngestResult, ManagerBinding } from "../src/contracts";
import { DeliveryPump } from "../src/core/delivery";
import { SeekerCore } from "../src/core/seeker";
import { SqliteExchangeStore } from "../src/store/sqlite";
import { LocalChannel, localRecipient } from "../src/local/channel";
import { limits } from "../src/core/validation";
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
  const deferred: string[] = [];
  const notices: string[] = [];
  const outcomes: IngestResult[] = [];
  const host: HostAdapter = { id: "test-host", deliver: async (binding, envelope) => {
    if ("receipt" in envelope) {
      returned.push(`${binding.origin.managerId}:${envelope.receipt.id}`);
      return { status: "accepted", reference: envelope.receipt.id };
    }
    if ("deferred" in envelope) deferred.push(`${binding.origin.managerId}:${envelope.deferred.event.eventId}`);
    else notices.push(`${binding.origin.managerId}:${envelope.notice.deliveryId}`);
    return { status: "accepted", reference: envelope.deliveryId };
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
  let pump = new DeliveryPump(core, [new LocalChannel(), channel], [host]);
  cleanup.push(() => { pump.stop(); store.close(); });
  function manager(id: string) {
    const port = core.manager({ hostId: "test-host", managerId: id, assignmentId: id, generation: 1 });
    return { ...port, get: (requestId: string) => {
      port.get(requestId);
      // Exercise the scoped port, then inspect durable state independently of wire paging.
      return store.get(requestId)!;
    } };
  }
  function bind(id: string, initialRecipient = recipient) {
    const binding: ManagerBinding = { id, label: id, recipient: initialRecipient, origin: { hostId: "test-host", managerId: id, assignmentId: id, generation: 1 } };
    core.bind(binding);
    return manager(id);
  }
  async function flush() {
    pump.tick();
    for (let i = 0; i < 200 && pump.inFlight; i++) await Bun.sleep(1);
    expect(pump.inFlight).toBe(0);
    expect(pump.lastError).toBeUndefined();
  }
  return { bind, manager, sent, updates, calls, returned, deferred, notices, outcomes, flush, filename,
    get store() { return store; }, get core() { return core; }, get channel() { return channel; },
    advance: (ms = 2_000) => { now += ms; },
    poll: () => {
      const ingress = core.channel(channel.id);
      return channel.pollOnce({ ...ingress, receive: (events, progress) => {
        const result = ingress.receive(events, progress);
        outcomes.push(...result);
        return result;
      } }, new AbortController().signal);
    },
    restart: () => {
      pump.stop(); store.close();
      store = new SqliteExchangeStore(filename); core = new SeekerCore(store, () => now);
      channel = makeChannel(); pump = new DeliveryPump(core, [new LocalChannel(), channel], [host]);
      store.recoverInterruptedDeliveries();
    },
  };
}

function reply(updateId: number, text: string, replyTo?: Record<string, unknown>) {
  return { update_id: updateId, message: { message_id: updateId + 1_000, date: 100, from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text, ...(replyTo ? { reply_to_message: replyTo } : {}) } };
}
function click(updateId: number, callbackId: string, message: Record<string, any>, index = 0) {
  return { update_id: updateId, callback_query: { id: callbackId, chat_instance: "fixture-chat", from: { id: 42, is_bot: false }, message, data: message.reply_markup.inline_keyboard[index][0].callback_data } };
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
  const resumed = f.manager("alpha");
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

test("editing a bare answer keeps its original manager after that request is handled", async () => {
  const f = await fixture();
  const alpha = f.bind("alpha");
  alpha.submit({ requestId: "alpha-request", decision: decision() });
  await f.flush();
  const original = reply(1, "Proceed with the preview");
  f.updates.push(original);
  await f.poll(); await f.flush();
  const receipt = alpha.get("alpha-request").exchange.receipts[0]!;
  alpha.update({ type: "acknowledge", requestId: "alpha-request", receiptId: receipt.id, status: "handled", resolvesExchange: true, evidenceRef: "controlled:handled", expectedVersion: alpha.get("alpha-request").exchange.version });
  expect(alpha.get("alpha-request").exchange.state).toBe("handled");
  const beta = f.bind("beta");
  beta.submit({ requestId: "beta-request", decision: decision() });
  f.advance(); await f.flush();
  f.restart();
  f.updates.push({ update_id: 2, edited_message: { ...original.message, text: "Stop; I changed my mind", edit_date: 101 } });
  await f.poll(); await f.flush();
  expect(f.store.get("alpha-request")!.exchange.receipts.at(-1)).toMatchObject({ kind: "correction", classification: "correction", text: "Stop; I changed my mind" });
  expect(f.store.get("beta-request")!.exchange.receipts).toHaveLength(0);
  expect(f.returned.at(-1)).toStartWith("alpha:");
});

test("late stop on an uncertain send remains correlated after its answer was handled", async () => {
  const f = await fixture(true);
  const manager = f.bind("alpha");
  manager.submit({ requestId: "lost-send", decision: decision() });
  await f.flush();
  const original = f.sent[0]!;
  f.updates.push(click(1, "answer-on-unknown-send", original));
  await f.poll(); await f.flush();
  const receipt = manager.get("lost-send").exchange.receipts[0]!;
  manager.update({ type: "acknowledge", requestId: "lost-send", receiptId: receipt.id, status: "handled", evidenceRef: "controlled:handled", expectedVersion: manager.get("lost-send").exchange.version });
  expect(f.core.channel(f.channel.id).pending(recipient)).toHaveLength(0);
  f.restart();
  f.updates.push(reply(2, "/stop Do not publish anything else", original));
  await f.poll(); await f.flush();
  expect(f.store.get("lost-send")!.exchange.receipts.at(-1)).toMatchObject({ kind: "stop", classification: "correction", revision: 1 });
  expect(f.store.get("lost-send")!.exchange.state).toBe("reconcile");
});

test("metadata-only edits stay quiet while A/B/A text edits remain distinct corrections", async () => {
  const f = await fixture();
  const manager = f.bind("alpha");
  manager.submit({ requestId: "edit-request", decision: decision() });
  await f.flush();
  const original = reply(1, "Proceed with the preview");
  f.updates.push(original);
  await f.poll(); await f.flush();
  const receipt = manager.get("edit-request").exchange.receipts[0]!;
  manager.update({ type: "acknowledge", requestId: "edit-request", receiptId: receipt.id, status: "handled", resolvesExchange: true, evidenceRef: "controlled:handled", expectedVersion: manager.get("edit-request").exchange.version });
  f.updates.push({ update_id: 2, edited_message: { ...original.message, edit_date: 101, link_preview_options: { is_disabled: true } } });
  await f.poll(); await f.flush();
  expect(manager.get("edit-request").exchange.receipts).toHaveLength(1);
  expect(manager.get("edit-request").exchange.state).toBe("handled");
  expect(f.returned).toHaveLength(1);
  f.updates.push({ update_id: 3, edited_message: { ...original.message, text: "Do not publish the preview", edit_date: 102 } });
  await f.poll();
  f.updates.push({ update_id: 4, edited_message: { ...original.message, edit_date: 103 } });
  await f.poll();
  expect(manager.get("edit-request").exchange.receipts.map((item) => item.text)).toEqual(["Proceed with the preview", "Do not publish the preview", "Proceed with the preview"]);
  expect(manager.get("edit-request").exchange.state).toBe("reconcile");
});

test("full exchanges retain input for manager review while another manager's reply commits", async () => {
  const f = await fixture();
  const alpha = f.bind("alpha");
  alpha.submit({ requestId: "full-request", decision: decision() });
  await f.flush();
  const original = f.sent[0]!;
  const handle = alpha.get("full-request").exchange.revisions[0]!.replyHandle;
  const channel = f.core.channel(f.channel.id);
  for (let i = 0; i < limits.receipts; i++) channel.receive([{ eventId: `seed-${i}`, actorId: "42", conversationId: "42", sourceRef: `seed-${i}`, replyHandle: handle, kind: "question", text: `Context ${i}?` }]);
  const beta = f.bind("beta");
  beta.submit({ requestId: "healthy-request", decision: decision() });
  f.advance(); await f.flush();
  const healthy = f.sent.find((message) => message.text.includes("healthy-request"))!;
  f.updates.push(reply(1, "/stop Please wait for my correction", original), reply(2, "Why?", healthy));
  await f.poll(); await f.flush();
  const full = alpha.get("full-request");
  expect(full.exchange.receipts).toHaveLength(limits.receipts);
  expect(full.deferredReplies?.[0]?.event.text).toBe("/stop Please wait for my correction");
  expect(f.deferred).toContain("alpha:1");
  expect(beta.get("healthy-request").exchange.receipts).toHaveLength(1);
  expect(f.sent.some((message) => message.text === "Saved for manager review; no decision applied.")).toBe(true);
  expect(channel.progress()?.cursor).toBe("3");
});

test("trusted local-to-Telegram routing affects new requests and preserves old local references", async () => {
  const f = await fixture();
  const manager = f.bind("alpha", localRecipient);
  manager.submit({ requestId: "old-local", decision: decision() });
  await f.flush();
  const oldReference = manager.get("old-local").deliveries[0]!.reference!;
  f.core.setRecipient("alpha", 1, recipient);
  manager.submit({ requestId: "new-telegram", decision: decision() });
  await f.flush();
  const message = f.sent.find((item) => item.text.includes("new-telegram"))!;
  expect(manager.get("old-local").exchange.recipient).toEqual(localRecipient);
  expect(manager.get("old-local").deliveries[0]!.reference).toBe(oldReference);
  expect(manager.get("new-telegram").exchange.recipient).toEqual(recipient);
  const local = f.core.channel(localRecipient.channelId).receive([{ eventId: "old-local-answer", actorId: localRecipient.actorId, conversationId: localRecipient.conversationId, sourceRef: "local-answer", replyToRef: oldReference, kind: "question", text: "Why?" }]);
  expect(local[0]!.status).toBe("recorded");
  f.updates.push(reply(1, "Why?", message));
  await f.poll(); await f.flush();
  expect(manager.get("old-local").exchange.receipts).toHaveLength(1);
  expect(manager.get("new-telegram").exchange.receipts).toHaveLength(1);
});

test("buffered and rounded bare replies cannot become answers to newer questions or revisions", async () => {
  const f = await fixture();
  const alpha = f.bind("alpha");
  alpha.submit({ requestId: "old-alpha", decision: decision() });
  await f.flush(); f.advance();
  alpha.update({ type: "cancel", requestId: "old-alpha", expectedVersion: 1, reason: "Handled elsewhere" });
  f.advance();
  const beta = f.bind("beta");
  beta.submit({ requestId: "new-beta", decision: decision() });
  await f.flush();
  const beforeQuestion = reply(1, "yes"); beforeQuestion.message.date = 1;
  f.updates.push(beforeQuestion); await f.poll();
  expect(f.outcomes.at(-1)).toMatchObject({ status: "unmatched", code: "predates_current_revision" });
  expect(beta.get("new-beta").exchange.receipts).toHaveLength(0);
  f.advance();
  beta.update({ type: "revise", requestId: "new-beta", expectedVersion: beta.get("new-beta").exchange.version, decision: decision("preview-two") });
  await f.flush();
  const beforeRevision = reply(2, "yes"); beforeRevision.message.date = 5;
  f.updates.push(beforeRevision); await f.poll();
  expect(f.outcomes.at(-1)).toMatchObject({ status: "unmatched", code: "predates_current_revision" });
  f.advance(1_500);
  beta.update({ type: "revise", requestId: "new-beta", expectedVersion: beta.get("new-beta").exchange.version, decision: decision("preview-three") });
  await f.flush();
  const sameSecond = Math.floor(f.core.clock() / 1_000);
  const uncertain = reply(3, "yes"); uncertain.message.date = sameSecond;
  f.updates.push(uncertain); await f.poll();
  expect(f.outcomes.at(-1)).toMatchObject({ status: "unmatched", code: "uncertain_chronology" });
  const current = f.sent.find((message) => message.text.includes("Publish to preview-three?"))!;
  const explicit = reply(4, "Only this preview", current); explicit.message.date = sameSecond;
  f.updates.push(explicit); await f.poll();
  expect(f.outcomes.at(-1)?.status).toBe("recorded");
  expect(beta.get("new-beta").exchange.receipts[0]!.source.occurredAtPrecisionMs).toBe(1_000);
  f.advance();
  const fresh = reply(5, "One additional condition"); fresh.message.date = Math.floor(f.core.clock() / 1_000);
  f.updates.push(fresh); await f.poll();
  expect(f.outcomes.at(-1)?.status).toBe("recorded");
  expect(beta.get("new-beta").exchange.receipts).toHaveLength(2);
});

test("forwarded text, external replies and selected quotes never become a bare owner answer", async () => {
  const f = await fixture();
  const manager = f.bind("alpha");
  manager.submit({ requestId: "direct-request", decision: decision() });
  await f.flush();
  const original = f.sent[0]!;
  const context = [
    { forward_origin: { type: "user", date: 1, sender_user: { id: 99, is_bot: false, first_name: "Fixture" } } },
    { external_reply: { origin: { type: "channel", date: 1 }, chat: { id: -99, type: "channel" }, message_id: 8 } },
    { quote: { text: "Only the quoted fragment", position: 0 }, reply_to_message: original },
  ];
  context.forEach((fields, index) => {
    const input = reply(index + 1, "Approve this");
    f.updates.push({ ...input, message: { ...input.message, ...fields } });
  });
  await f.poll();
  expect(manager.get("direct-request").exchange.receipts).toHaveLength(0);
  expect(f.sent.filter((message) => message.text.includes("ordinary direct reply"))).toHaveLength(3);
  f.updates.push(reply(4, "Use staging only", original));
  await f.poll();
  expect(manager.get("direct-request").exchange.receipts[0]?.text).toBe("Use staging only");
});

test("inaccessible callback messages retain authenticated handles while stale revisions remain rejected", async () => {
  const f = await fixture(true);
  const manager = f.bind("alpha");
  manager.submit({ requestId: "inaccessible-request", decision: decision() });
  await f.flush();
  const original = f.sent[0]!;
  const inaccessible = (id: number) => {
    const event = click(id, `inaccessible-${id}`, original);
    event.callback_query.message = { message_id: original.message_id, chat: original.chat, date: 0 };
    return event;
  };
  const wrongSender = inaccessible(1); wrongSender.callback_query.from.id = 99;
  const wrongChat = inaccessible(2); wrongChat.callback_query.message.chat = { id: 99, type: "private" };
  f.updates.push(wrongSender, wrongChat);
  await f.poll();
  expect(manager.get("inaccessible-request").exchange.receipts).toHaveLength(0);
  f.updates.push(inaccessible(3));
  await f.poll(); await f.flush();
  expect(manager.get("inaccessible-request").exchange.receipts).toHaveLength(1);
  manager.update({ type: "revise", requestId: "inaccessible-request", expectedVersion: manager.get("inaccessible-request").exchange.version, decision: decision("preview-two") });
  f.advance(); await f.flush();
  f.updates.push(inaccessible(4));
  await f.poll();
  expect(f.outcomes.at(-1)).toMatchObject({ status: "rejected", code: "stale_revision" });
  expect(manager.get("inaccessible-request").exchange.receipts).toHaveLength(1);
});
