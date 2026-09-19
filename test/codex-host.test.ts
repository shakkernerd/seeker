import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, ManagerBinding, ReceiptEnvelope } from "../src/contracts.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";
import { CodexHostAdapter, type CodexHostLifecycle } from "../src/hosts/codex/host.ts";
import { codexRoute, invocationFromMetadata } from "../src/hosts/codex/protocol.ts";
import { localRecipient } from "../src/local/channel.ts";

const credential = "a".repeat(64), humanCredential = "b".repeat(64);
const decision: Decision = { kind: "information", title: "Choose a label", question: "Which label?", context: "", target: "", effect: "", scope: "", conditions: "", options: [] };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture(clock: () => number = Date.now, lifecycle?: CodexHostLifecycle, deadlineMs = 1_000) {
  const directory = mkdtempSync(join(tmpdir(), "seeker-native-test-"));
  const store = new SqliteExchangeStore(join(directory, "store.sqlite"));
  const core = new SeekerCore(store, clock);
  let restorations = 0;
  const bindings = ["manager-one", "manager-two"].map((managerId): ManagerBinding => ({ id: managerId, label: managerId, origin: { hostId: "codex-test", managerId, assignmentId: `assignment-${managerId}`, generation: 1 }, recipient: localRecipient }));
  bindings.forEach((binding) => core.bind(binding));
  const host = new CodexHostAdapter("codex-test", credential, { binding: (id) => core.managerBinding("codex-test", id), manager: (origin) => core.manager(origin) }, deadlineMs, () => { restorations += 1; core.resumeHost("codex-test"); }, lifecycle);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => await host.handle(request) ?? new Response(null, { status: 404 }) });
  cleanups.push(async () => { host.close(); await server.stop(true); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const send = (path: string, body: unknown, token = credential, signal?: AbortSignal) => fetch(`http://127.0.0.1:${server.port}${codexRoute}/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const connect = async () => { const response = await send("connect", { protocol: 1, instanceId: randomUUID() }); expect(response.status).toBe(200); return (await response.json()).session as string; };
  const invoke = (session: string, managerId: string, operation: string, args: unknown) => send("invoke", { origin: { threadId: managerId, turnId: "native-turn", callId: "native-call" }, operation, arguments: args }, session);
  return { core, store, host, bindings, send, connect, invoke, restorations: () => restorations };
}
async function eventually(check: () => boolean | Promise<boolean>, timeout = 1_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) { if (Date.now() > deadline) throw new Error("condition not observed"); await Bun.sleep(5); }
}
function envelope(f: ReturnType<typeof fixture>, index = 0): { binding: ManagerBinding; envelope: ReceiptEnvelope } {
  const binding = f.bindings[index]!;
  const origin = { ...binding.origin, turnId: "submit-turn", callId: "submit-call" };
  const view = f.core.manager(origin).submit({ requestId: `request-${index}`, decision });
  const reply = f.core.channel("local").receive([{ eventId: `owner-${index}`, actorId: "owner", conversationId: "inbox", sourceRef: `owner:${index}`, replyHandle: view.current.replyHandle, kind: "question", text: "Why that label?" }])[0]!;
  const current = f.store.get(view.exchange.id)!;
  return { binding: { ...binding, origin }, envelope: { deliveryId: `delivery-${index}`, exchangeId: view.exchange.id, revision: current.exchange.revisions[0]!, receipt: current.exchange.receipts.find((item) => item.id === reply.receiptId)!, requiresReconciliation: false } };
}

describe("native caller admission", () => {
  test("the shared host connection admits exact managers and denies workers and forged tool fields", async () => {
    const f = fixture();
    expect((await f.send("connect", { protocol: 1, instanceId: "caller" }, humanCredential)).status).toBe(401);
    const session = await f.connect();
    for (const worker of ["lead-one", "nested-worker"]) expect((await f.invoke(session, worker, "submit", { requestId: worker, decision, managerId: "manager-one", role: "manager" })).status).toBe(403);
    expect((await f.invoke(session, "manager-one", "submit", { requestId: "forged", decision, origin: { threadId: "manager-two" } })).status).toBe(400);
    expect((await f.invoke(session, "manager-one", "submit", { requestId: "first", decision })).status).toBe(200);
    expect((await f.invoke(session, "manager-two", "submit", { requestId: "second", decision })).status).toBe(200);
    expect((await f.invoke(session, "manager-two", "get", { requestId: "first" })).status).toBe(403);
    expect(f.store.get("first")?.exchange.origin).toMatchObject({ managerId: "manager-one", turnId: "native-turn", callId: "native-call" });
    expect(f.store.get("nested-worker")).toBeUndefined();
  });

  test("individual host metadata wins over the shared session tree and malformed identities fail closed", () => {
    const metadata = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "nested-worker", turn_id: "turn" }), threadId: "nested-worker", sessionId: "manager-one", callId: "call" };
    expect(invocationFromMetadata(metadata)).toEqual({ threadId: "nested-worker", turnId: "turn", callId: "call" });
    expect(() => invocationFromMetadata({ ...metadata, threadId: "manager-one" })).toThrow();
    expect(() => invocationFromMetadata({ threadId: "manager-one", role: "manager" })).toThrow();
  });

  test("an established connection cannot adopt a changed owner generation", async () => {
    const f = fixture(), session = await f.connect();
    expect((await f.invoke(session, "manager-one", "pending", {})).status).toBe(200);
    f.store.transfer("manager-one", 1, { ...f.bindings[0]!.origin, generation: 2 });
    expect((await f.invoke(session, "manager-one", "pending", {})).status).toBe(409);
  });

  test("natural input is handled independently from explicit resolution through the real manager port", async () => {
    const f = fixture(), session = await f.connect();
    const port = f.core.manager({ ...f.bindings[0]!.origin, turnId: "submit-turn", callId: "submit-call" });
    const initial = port.submit({ requestId: "natural-flow", decision });
    // Ordinary local free text uses answer for both clarification and an actual answer.
    const question = f.core.channel("local").receive([{ eventId: "natural-why", actorId: "owner", conversationId: "inbox", sourceRef: "local:why", replyHandle: initial.current.replyHandle, kind: "answer", text: "Why?" }])[0]!;
    let view = port.get(initial.exchange.id);
    expect((await f.invoke(session, "manager-one", "update", { type: "acknowledge", requestId: view.exchange.id, receiptId: question.receiptId, expectedVersion: view.exchange.version, status: "handled" })).status).toBe(200);
    expect(port.get(view.exchange.id).exchange.state).toBe("waiting");
    const answer = f.core.channel("local").receive([{ eventId: "conditional-answer", actorId: "owner", conversationId: "inbox", sourceRef: "local:answer", replyHandle: initial.current.replyHandle, kind: "answer", text: "Use A, only for the demo.", conditions: "No repository work." }])[0]!;
    view = port.get(view.exchange.id);
    expect((await f.invoke(session, "manager-one", "update", { type: "acknowledge", requestId: view.exchange.id, receiptId: answer.receiptId, expectedVersion: view.exchange.version, status: "handled", resolvesExchange: true, evidenceRef: "forged" })).status).toBe(400);
    expect((await f.invoke(session, "manager-one", "update", { type: "acknowledge", requestId: view.exchange.id, receiptId: answer.receiptId, expectedVersion: view.exchange.version, status: "handled", resolvesExchange: true })).status).toBe(200);
    const receipt = f.store.get(view.exchange.id)!.exchange.receipts.find((item) => item.id === answer.receiptId)!;
    expect(receipt.disposition.resolvesExchange).toBe(true);
    expect(receipt.conditions).toBe("No repository work.");
    expect(receipt.disposition.evidenceRef).toBe("codex:manager-one:native-turn:native-call");
    expect(port.get(view.exchange.id).exchange.state).toBe("handled");
  });
});

describe("native return transport", () => {
  test("offline recovery is coalesced and slow host startup never becomes uncertain delivery", async () => {
    const resumed: { binding: ManagerBinding; signal: AbortSignal }[] = [];
    const f = fixture(Date.now, {
      connected: async () => {},
      resume: async (binding, signal) => { resumed.push({ binding, signal }); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); },
    });
    const first = envelope(f), second = envelope(f, 1), controller = new AbortController();
    const started = Date.now();
    for (const value of [first, second, first]) expect(await f.host.deliver(value.binding, value.envelope, controller.signal)).toMatchObject({ status: "retry", code: "host_offline" });
    expect(Date.now() - started).toBeLessThan(200);
    await eventually(() => resumed.length === 1, 1_500);
    expect(resumed[0]!.binding.origin).toEqual(first.binding.origin);
    for (let index = 0; index < 5; index += 1) expect((await f.host.deliver(first.binding, first.envelope, controller.signal)).status).toBe("retry");
    expect(resumed).toHaveLength(1);
    f.host.close();
    expect(resumed[0]!.signal.aborted).toBe(true);
  });

  test("a busy native sender and a normal polling gap do not reopen Desktop", async () => {
    let resumed = 0;
    const f = fixture(Date.now, { connected: async () => {}, resume: async () => { resumed += 1; } }, 3_000);
    const first = envelope(f), second = envelope(f, 1), session = await f.connect();
    const polling = f.send("poll", {}, session);
    await eventually(() => f.restorations() === 1);
    const sending = f.host.deliver(first.binding, first.envelope, new AbortController().signal);
    const packet = await (await polling).json();
    expect((await f.host.deliver(second.binding, second.envelope, new AbortController().signal)).status).toBe("retry");
    await Bun.sleep(1_100);
    expect(resumed).toBe(0);
    await f.send("result", { attemptId: packet.attemptId, result: { status: "accepted", reference: "native-busy" } }, session);
    expect((await sending).status).toBe("accepted");
    const nextPoll = f.send("poll", {}, session);
    await Bun.sleep(1_100);
    expect(resumed).toBe(0);
    await f.send("disconnect", {}, session); await nextPoll;
  });

  test("cancelled, replaced and closed owners cannot start a delayed recovery", async () => {
    let resumed = 0;
    const lifecycle = { connected: async () => {}, resume: async () => { resumed += 1; } };
    const cancelled = fixture(Date.now, lifecycle), replaced = fixture(Date.now, lifecycle), closed = fixture(Date.now, lifecycle);
    const controller = new AbortController();
    for (const f of [cancelled, replaced, closed]) {
      const value = envelope(f);
      expect((await f.host.deliver(value.binding, value.envelope, f === cancelled ? controller.signal : new AbortController().signal)).status).toBe("retry");
    }
    controller.abort();
    replaced.store.transfer("manager-one", 1, { ...replaced.bindings[0]!.origin, generation: 2 });
    closed.host.close();
    await Bun.sleep(1_100);
    expect(resumed).toBe(0);
  });

  test("interleaved managers keep targets and host acceptance does not manufacture consumption", async () => {
    const f = fixture(), session = await f.connect();
    const first = envelope(f), second = envelope(f, 1);
    for (const delivery of [second, first]) {
      const polling = f.send("poll", {}, session);
      let sent: Promise<unknown> | undefined;
      await eventually(async () => {
        const result = f.host.deliver(delivery.binding, delivery.envelope, new AbortController().signal);
        const fast = await Promise.race([result, Bun.sleep(5).then(() => null)]);
        if (fast === null) { sent = result; return true; }
        expect((fast as { status: string }).status).toBe("retry"); return false;
      });
      const packet = await (await polling).json();
      expect(packet.binding.origin.managerId).toBe(delivery.binding.origin.managerId);
      expect(packet.binding.origin.turnId).toBe("submit-turn");
      const result = { status: "accepted", reference: `native:${delivery.envelope.deliveryId}` };
      expect((await f.send("result", { attemptId: packet.attemptId, result }, session)).status).toBe(200);
      expect(await sent).toEqual(result);
      expect((await f.send("result", { attemptId: packet.attemptId, result }, session)).status).toBe(200);
      expect(f.store.get(delivery.envelope.exchangeId)!.exchange.receipts[0]!.disposition.status).toBe("pending");
      const current = f.store.get(delivery.envelope.exchangeId)!;
      const acknowledgement = await f.invoke(session, delivery.binding.origin.managerId, "update", { type: "acknowledge", requestId: current.exchange.id, receiptId: delivery.envelope.receipt.id, expectedVersion: current.exchange.version, status: "received" });
      expect(acknowledgement.status).toBe(200);
      expect(f.store.get(current.exchange.id)!.exchange.receipts[0]!.disposition.evidenceRef).toBe(`codex:${delivery.binding.origin.managerId}:native-turn:native-call`);
    }
  });

  test("offline is retryable; disconnect after leasing is uncertain and old callbacks cannot change it", async () => {
    const f = fixture(), value = envelope(f), signal = new AbortController();
    expect((await f.host.deliver(value.binding, value.envelope, signal.signal)).status).toBe("retry");
    const session = await f.connect(), polling = f.send("poll", {}, session);
    await Bun.sleep(10);
    const result = f.host.deliver(value.binding, value.envelope, signal.signal);
    const packet = await (await polling).json();
    await f.send("disconnect", {}, session);
    expect(await result).toMatchObject({ status: "unknown" });
    const restored = await f.connect();
    expect((await f.send("result", { attemptId: packet.attemptId, result: { status: "accepted", reference: "late" } }, restored)).status).toBe(409);
    expect((await f.host.deliver(value.binding, value.envelope, signal.signal)).status).toBe("retry");
  });

  test("only a restored authenticated receiver triggers recovery, not every connection or poll", async () => {
    const f = fixture();
    expect((await f.send("connect", { protocol: 1, instanceId: "forged" }, humanCredential)).status).toBe(401);
    expect(f.restorations()).toBe(0);
    const first = await f.connect(), second = await f.connect();
    expect(f.restorations()).toBe(0);
    const initialPoll = f.send("poll", {}, first);
    await eventually(() => f.restorations() === 1);
    const value = envelope(f);
    const delivered = f.host.deliver(value.binding, value.envelope, new AbortController().signal);
    const packet = await (await initialPoll).json();
    await f.send("result", { attemptId: packet.attemptId, result: { status: "accepted", reference: "native-accepted" } }, first);
    expect((await delivered).status).toBe("accepted");
    const nextPoll = f.send("poll", {}, first);
    await f.invoke(second, "manager-one", "pending", {});
    expect(f.restorations()).toBe(1);
    await f.send("disconnect", {}, first); await f.send("disconnect", {}, second);
    await nextPoll;
    const third = await f.connect(), restoredPoll = f.send("poll", {}, third);
    await eventually(() => f.restorations() === 2);
    await f.send("disconnect", {}, third); await restoredPoll;
  });

  test("an abruptly lost receiver cannot strand exhausted offline deliveries behind its stale session", async () => {
    let now = 1_000;
    const f = fixture(() => now), value = envelope(f);
    const oldSession = await f.connect(), controller = new AbortController();
    const oldPoll = f.send("poll", {}, oldSession, controller.signal).catch(() => undefined);
    await eventually(() => f.restorations() === 1);
    controller.abort(); await oldPoll; await Bun.sleep(10);
    // The disconnected HTTP receiver leaves an authenticated session until pruning.
    expect((await f.invoke(oldSession, "manager-one", "pending", {})).status).toBe(200);
    for (let index = 0; index < 5; index += 1) {
      const attempts = f.store.claimDeliveries(4, now);
      for (const attempt of attempts) {
        const result = attempt.lane === "channel" ? { status: "accepted" as const, reference: "local-presented" }
          : await f.host.deliver(value.binding, { ...value.envelope, deliveryId: attempt.id }, new AbortController().signal);
        if (attempt.lane === "host") expect(result).toMatchObject({ status: "retry", code: "host_offline" });
        f.store.completeDelivery(attempt.id, attempt.attemptId!, result, now);
      }
      now += 1_000;
    }
    const failed = f.store.get(value.envelope.exchangeId)!.deliveries.find((item) => item.lane === "host")!;
    expect(failed).toMatchObject({ state: "rejected", code: "retry_exhausted", attempts: 5 });
    const restored = await f.connect();
    expect(f.restorations()).toBe(1);
    const polling = f.send("poll", {}, restored);
    await eventually(() => f.restorations() === 2);
    const [attempt] = f.store.claimDeliveries(4, now);
    expect(attempt).toMatchObject({ id: failed.id, state: "sending", attempts: 1 });
    const delivery = f.host.deliver(value.binding, { ...value.envelope, deliveryId: attempt!.id }, new AbortController().signal);
    const packet = await (await polling).json();
    expect(packet.envelope.deliveryId).toBe(failed.id);
    await f.send("result", { attemptId: packet.attemptId, result: { status: "accepted", reference: "native-restored" } }, restored);
    f.store.completeDelivery(attempt!.id, attempt!.attemptId!, await delivery, now);
    expect(f.store.get(value.envelope.exchangeId)!.deliveries.find((item) => item.id === failed.id)?.state).toBe("accepted");
    expect(f.store.get(value.envelope.exchangeId)!.exchange.receipts[0]!.disposition.status).toBe("pending");
  });

  test("known-offline work resumes even before an older uncertain native attempt finishes", async () => {
    let now = 1_000;
    const f = fixture(() => now), first = envelope(f), old = await f.connect();
    const oldPoll = f.send("poll", {}, old);
    await eventually(() => f.restorations() === 1);
    const firstAttempts = f.store.claimDeliveries(4, now);
    for (const attempt of firstAttempts.filter((item) => item.lane === "channel")) f.store.completeDelivery(attempt.id, attempt.attemptId!, { status: "accepted", reference: "first-presented" }, now);
    const firstAttempt = firstAttempts.find((item) => item.lane === "host")!, lost = new AbortController();
    const uncertain = f.host.deliver(first.binding, { ...first.envelope, deliveryId: firstAttempt.id }, lost.signal);
    await oldPoll; // The old receiver took the packet, then disappeared without a result.
    const second = envelope(f, 1);
    for (let index = 0; index < 5; index += 1) {
      for (const attempt of f.store.claimDeliveries(4, now)) {
        const result = attempt.lane === "channel" ? { status: "accepted" as const, reference: "second-presented" }
          : await f.host.deliver(second.binding, { ...second.envelope, deliveryId: attempt.id }, new AbortController().signal);
        f.store.completeDelivery(attempt.id, attempt.attemptId!, result, now);
      }
      now += 1_000;
    }
    expect(f.store.get(second.envelope.exchangeId)!.deliveries.find((item) => item.lane === "host")).toMatchObject({ state: "rejected", code: "retry_exhausted" });
    const fresh = await f.connect(), poll = f.send("poll", {}, fresh);
    await eventually(() => f.restorations() === 2);
    expect(f.store.get(first.envelope.exchangeId)!.deliveries.find((item) => item.id === firstAttempt.id)?.state).toBe("sending");
    const [retry] = f.store.claimDeliveries(4, now);
    expect(retry?.exchangeId).toBe(second.envelope.exchangeId);
    const recovered = f.host.deliver(second.binding, { ...second.envelope, deliveryId: retry!.id }, new AbortController().signal);
    const packet = await (await poll).json();
    await f.send("result", { attemptId: packet.attemptId, result: { status: "accepted", reference: "second-restored" } }, fresh);
    f.store.completeDelivery(retry!.id, retry!.attemptId!, await recovered, now);
    lost.abort();
    f.store.completeDelivery(firstAttempt.id, firstAttempt.attemptId!, await uncertain, now);
    expect(f.store.get(first.envelope.exchangeId)!.deliveries.find((item) => item.id === firstAttempt.id)?.state).toBe("unknown");
    expect(f.store.get(second.envelope.exchangeId)!.deliveries.find((item) => item.id === retry!.id)?.state).toBe("accepted");
  });
});
