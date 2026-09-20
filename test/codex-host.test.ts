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
function fixture(clock: () => number = Date.now, lifecycle?: CodexHostLifecycle) {
  const directory = mkdtempSync(join(tmpdir(), "seeker-native-test-"));
  const store = new SqliteExchangeStore(join(directory, "store.sqlite"));
  const core = new SeekerCore(store, clock);
  let restorations = 0;
  const bindings = ["manager-one", "manager-two"].map((managerId): ManagerBinding => ({ id: managerId, label: managerId, origin: { hostId: "codex-test", managerId, assignmentId: `assignment-${managerId}`, generation: 1 }, recipient: localRecipient }));
  bindings.forEach((binding) => core.bind(binding));
  const host = new CodexHostAdapter("codex-test", credential, { binding: (id) => core.managerBinding("codex-test", id), manager: (origin) => core.manager(origin) }, lifecycle, { deliver: async () => ({ status: "retry", retryAfterMs: 1_000, code: "helper_preparing" }), restored: () => { restorations += 1; core.resumeHost("codex-test"); }, close: async () => {} });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => await host.handle(request) ?? new Response(null, { status: 404 }) });
  cleanups.push(async () => { await host.close(); await server.stop(true); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const send = (path: string, body: unknown, token = credential, signal?: AbortSignal) => fetch(`http://127.0.0.1:${server.port}${codexRoute}/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const connect = async (desktop?: unknown) => { const response = await send("connect", { protocol: 1, instanceId: randomUUID(), ...(desktop === undefined ? {} : { desktop }) }); expect(response.status).toBe(200); return (await response.json()).session as string; };
  const invoke = (session: string, managerId: string, operation: string, args: unknown) => send("invoke", { origin: { threadId: managerId, turnId: "native-turn", callId: "native-call" }, operation, arguments: args }, session);
  return { core, store, host, bindings, send, connect, invoke, restorations: () => restorations };
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

describe("native input ownership", () => {
  test("existing loaded connectors retain tools and idle polls without receiving native input", async () => {
    const f = fixture(), session = await f.connect(), controller = new AbortController();
    const polling = f.send("poll", {}, session, controller.signal).catch(() => undefined);
    await Bun.sleep(5);
    const value = envelope(f);
    expect(await f.host.deliver(value.binding, value.envelope, new AbortController().signal)).toMatchObject({ status: "retry", code: "helper_preparing" });
    expect((await f.invoke(session, "manager-one", "get", { requestId: value.envelope.exchangeId })).status).toBe(200);
    expect(f.restorations()).toBe(1);
    expect((await f.send("result", { attemptId: "unleased", result: { status: "accepted", reference: "forged" } }, session)).status).toBe(409);
    controller.abort(); await polling;
  });

  test("a stale connector cannot borrow the newly registered owner", async () => {
    let registered = false;
    const f = fixture(Date.now, {
      connected: async () => {},
      admitted: async (desktop) => { if (desktop === "qualified") registered = true; },
      ready: (desktop) => { if (registered && desktop !== "qualified") throw new Error("stale owner"); },
    });
    const old = await f.connect(), qualified = await f.connect("qualified");
    expect((await f.invoke(qualified, "manager-one", "pending", {})).status).toBe(200);
    expect((await f.invoke(old, "manager-one", "pending", {})).status).toBe(400);
  });
});
