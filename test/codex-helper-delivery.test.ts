import { afterEach, expect, test } from "bun:test";
import type { DeliveryResult, ReceiptEnvelope } from "../src/contracts.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { DesktopHelperDelivery } from "../src/hosts/codex/helper-delivery.ts";
import type { HelperConnection, HelperEvents, HelperRequestId } from "../src/hosts/codex/helper-rpc.ts";
import type { DesktopHelperRuntime } from "../src/hosts/codex/helper-runtime.ts";
import { fixtureBinding, fixtureDecision } from "../src/local/fixture.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function until(check: () => boolean, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error("condition not observed"); await Bun.sleep(2); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(hold = false, readyMs = 1_000) {
  let now = 1_000, events!: HelperEvents, expected!: { threadId: string; prompt: string };
  let preparations = 0, resets = 0, failPrepare = false, resetGate: Promise<void> | undefined;
  const prepared = deferred(), replies: { id: HelperRequestId; result: any }[] = [];
  const store = new SqliteExchangeStore(":memory:"), core = new SeekerCore(store, () => now);
  const binding = { ...fixtureBinding, origin: { ...fixtureBinding.origin, hostId: "codex-desktop" } };
  core.bind(binding);
  const manager = core.manager(binding.origin), initial = manager.submit({ requestId: "request", decision: fixtureDecision });
  const received = core.channel("local").receive([{ eventId: "reply", actorId: "owner", conversationId: "inbox", sourceRef: "local:reply", replyHandle: initial.current.replyHandle, kind: "question", text: "Why this option?" }])[0]!;
  const view = () => store.get("request")!;
  const envelope: ReceiptEnvelope = { deliveryId: view().deliveries.find((item) => item.receiptId === received.receiptId)!.id, exchangeId: "request", revision: view().exchange.revisions[0]!, receipt: view().exchange.receipts[0]!, requiresReconciliation: false };
  const rpc: HelperConnection = { connected: true, request: async () => ({}), notify: () => {}, respond: (id, result) => { replies.push({ id, result }); }, reject: (id) => { replies.push({ id, result: { rejected: true } }); }, close: async () => {} };
  const item = () => ({ type: "mcpToolCall", id: "native-item", server: "codex_app", tool: "send_message_to_thread", arguments: expected });
  const approval = (overrides: Record<string, unknown> = {}, id: HelperRequestId = 42) => events.request(id, "mcpServer/elicitation/request", { threadId: "helper", turnId: "helper-turn", serverName: "codex_app", mode: "form", _meta: { codex_approval_kind: "mcp_tool_call", tool_params: expected }, ...overrides });
  const runtime: DesktopHelperRuntime = {
    prepare: async (nextEvents) => {
      preparations++; events = nextEvents;
      if (failPrepare) { failPrepare = false; throw new Error("known prewrite startup failure"); }
      if (hold) await prepared.promise;
      return { rpc, threadId: "helper", start: async (prompt) => {
        expected = JSON.parse(prompt.split("\n").at(-1)!);
        events.notice("turn/started", { threadId: "helper", turn: { id: "helper-turn" } });
        events.notice("item/started", { threadId: "helper", turnId: "helper-turn", item: item() });
        approval(); return "helper-turn";
      } };
    },
    reset: async () => { resets++; await resetGate; },
    close: async () => { prepared.resolve(); },
  };
  const sender = new DesktopHelperDelivery(core, runtime, 2_000, 200, readyMs);
  cleanups.push(async () => { prepared.resolve(); await sender.close(); store.close(); });
  const deliver = (signal = new AbortController().signal) => sender.deliver(binding, envelope, signal);
  const nativeResult = (overrides: Record<string, unknown> = {}) => events.notice("item/completed", { threadId: "helper", turnId: "helper-turn", item: { ...item(), status: "completed", result: { content: [{ type: "text", text: JSON.stringify({ threadId: binding.origin.managerId }) }] }, ...overrides } });
  return { sender, runtime, core, store, binding, manager, envelope, view, deliver, nativeResult, approval, replies, prepared,
    now: (value: number) => { now = value; }, preparations: () => preparations, resets: () => resets,
    ready: async () => { await until(() => Boolean(expected)); await Bun.sleep(2); },
    failPreparation: () => { failPrepare = true; }, holdReset: (promise: Promise<void>) => { resetGate = promise; },
    lost: () => events.lost(),
  };
}

test("slow preparation exhausts normal retries, then a native approval and receipt complete one fresh attempt", async () => {
  const f = fixture(true);
  for (let n = 0; n < 5; n++) {
    f.now(1_000 + n * 1_000);
    const attempts = f.store.claimDeliveries(4, 1_000 + n * 1_000);
    for (const attempt of attempts) {
      const result: DeliveryResult = attempt.lane === "host" ? await f.deliver() : { status: "accepted", reference: "shown" };
      f.store.completeDelivery(attempt.id, attempt.attemptId!, result, 1_000 + n * 1_000);
    }
  }
  expect(f.view().deliveries.find((item) => item.id === f.envelope.deliveryId)).toMatchObject({ state: "rejected", code: "retry_exhausted" });
  expect(f.preparations()).toBe(1); expect(f.replies).toHaveLength(0);
  f.now(7_000); f.prepared.resolve(); await f.ready();
  await until(() => f.view().deliveries.some((item) => item.id === f.envelope.deliveryId && item.state === "retry"));
  const attempt = f.store.claimDeliveries(4, 7_000).find((item) => item.id === f.envelope.deliveryId)!;
  const result = f.deliver();
  expect(f.replies).toEqual([{ id: 42, result: { action: "accept", content: null, _meta: null } }]);
  f.nativeResult(); const accepted = await result;
  expect(accepted.status).toBe("accepted");
  f.store.completeDelivery(attempt.id, attempt.attemptId!, accepted, 7_001);
  expect((await f.deliver()).status).toBe("accepted"); expect(f.replies).toHaveLength(1);
});

test("transfer, acknowledgement and cancellation while the call waits produce no affirmative approval", async () => {
  for (const change of ["transfer", "acknowledge", "cancel"] as const) {
    const f = fixture(); await f.deliver(); await f.ready();
    if (change === "transfer") f.store.transfer(f.binding.id, 1, { ...f.binding.origin, generation: 2 });
    else if (change === "acknowledge") f.manager.update({ type: "acknowledge", requestId: "request", receiptId: f.envelope.receipt.id, status: "received", evidenceRef: "native:read", expectedVersion: f.view().exchange.version });
    else f.manager.update({ type: "cancel", requestId: "request", reason: "Stop", expectedVersion: f.view().exchange.version });
    expect((await f.deliver()).status).toBe("rejected");
    await f.sender.close(); expect(f.replies.some((entry) => entry.result.action === "accept")).toBe(false);
  }
});

test("duplicate or missing-turn approvals cannot grant a call", async () => {
  for (const override of [{}, { turnId: null }, { _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { threadId: "other", prompt: "wrong" } } }]) {
    const f = fixture(); await f.deliver(); await f.ready();
    f.approval(override, 43);
    expect(f.replies.some((entry) => entry.result.action === "accept")).toBe(false);
    expect(f.replies.some((entry) => entry.result.action === "cancel")).toBe(true);
  }
});

test("ready expiry is cleared at grant; completion is the native receipt, not model text", async () => {
  const f = fixture(false, 40); await f.deliver(); await f.ready();
  await Bun.sleep(25);
  const result = f.deliver(); await Bun.sleep(30);
  f.nativeResult(); expect((await result).status).toBe("accepted");
});

test("post-approval cancellation and malformed target evidence remain uncertain and never replay", async () => {
  for (const mode of ["cancel", "wrong-target", "lost"] as const) {
    const f = fixture(); await f.deliver(); await f.ready();
    const controller = new AbortController(), result = f.deliver(controller.signal);
    if (mode === "cancel") controller.abort();
    else if (mode === "lost") f.lost();
    else f.nativeResult({ result: { content: [{ type: "text", text: '{"threadId":"different"}' }] } });
    expect((await result).status).toBe("unknown");
    expect((await f.deliver()).status).toBe("unknown");
    expect(f.replies.filter((entry) => entry.result.action === "accept")).toHaveLength(1);
  }
});

test("known prewrite failure can prepare again, but cannot reuse a still-settling native turn", async () => {
  const f = fixture(), reset = deferred(); f.holdReset(reset.promise); f.failPreparation();
  await f.deliver(); await until(() => f.resets() === 1);
  await f.deliver(); expect(f.preparations()).toBe(1);
  reset.resolve(); await Bun.sleep(1_020);
  await f.deliver(); await f.ready(); expect(f.preparations()).toBe(2);
  const result = f.deliver(); f.nativeResult(); expect((await result).status).toBe("accepted");
});

test("a second failed preparation releases exhausted work for another manager without retrying uncertain input", async () => {
  const f = fixture(), failures = [deferred(), deferred()], prepare = f.runtime.prepare;
  f.runtime.prepare = async (...args) => {
    const helper = await prepare(...args), failure = failures[f.preparations() - 1];
    if (failure) { await failure.promise; throw new Error("known prewrite preparation failure"); }
    return helper;
  };
  cleanups.push(async () => { for (const failure of failures) failure.resolve(); });
  const binding = { ...f.binding, id: "other-binding", origin: { ...f.binding.origin, managerId: "other-manager", assignmentId: "other-assignment" } };
  f.core.bind(binding);
  const initial = f.core.manager(binding.origin).submit({ requestId: "other-request", decision: fixtureDecision });
  const received = f.core.channel("local").receive([{ eventId: "other-reply", actorId: "owner", conversationId: "inbox", sourceRef: "local:other-reply", replyHandle: initial.current.replyHandle, kind: "question", text: "What about my request?" }])[0]!;
  const view = f.store.get(initial.exchange.id)!;
  const envelope: ReceiptEnvelope = {
    deliveryId: view.deliveries.find((item) => item.receiptId === received.receiptId)!.id, exchangeId: initial.exchange.id,
    revision: view.exchange.revisions[0]!, receipt: view.exchange.receipts[0]!, requiresReconciliation: false,
  };
  const saved = (value: ReceiptEnvelope) => f.store.get(value.exchangeId)!.deliveries.find((item) => item.id === value.deliveryId)!;
  let now = 1_000;
  const attemptRound = async (loseResponse = false) => {
    f.now(now);
    for (const attempt of f.store.claimDeliveries(4, now)) {
      let result: DeliveryResult = { status: "accepted", reference: `shown:${attempt.id}` };
      if (attempt.lane === "host") {
        const other = attempt.id === envelope.deliveryId;
        const delivery = f.sender.deliver(other ? binding : f.binding, other ? envelope : f.envelope, new AbortController().signal);
        if (other && loseResponse) {
          expect(f.replies.filter((entry) => entry.result.action === "accept")).toHaveLength(1);
          f.lost();
        }
        result = await delivery;
        if (other && !loseResponse && f.preparations() <= 2) expect(result).toMatchObject({ status: "retry", code: "desktop_helper_busy" });
      }
      f.store.completeDelivery(attempt.id, attempt.attemptId!, result, now);
    }
    now += 1_000;
  };
  for (let failure = 0; failure < 2; failure++) {
    for (let attempt = 0; attempt < 5; attempt++) await attemptRound();
    expect(f.preparations()).toBe(failure + 1);
    expect(saved(f.envelope)).toMatchObject({ state: "rejected", code: "retry_exhausted", attempts: 5 });
    expect(saved(envelope)).toMatchObject({ state: "rejected", code: "retry_exhausted", attempts: 5 });
    expect(f.replies).toHaveLength(0);
    failures[failure]!.resolve();
    await until(() => saved(envelope).state === "retry");
    expect(f.resets()).toBe(failure + 1);
  }
  expect(await f.deliver()).toMatchObject({ status: "retry", code: "desktop_helper_preparation_failed" });
  await attemptRound(); await f.ready();
  expect(f.preparations()).toBe(3);
  await attemptRound(true);
  expect(saved(envelope)).toMatchObject({ state: "unknown", code: "desktop_input_uncertain" });
  expect(f.core.resumeHost(binding.origin.hostId)).toBe(0);
  await attemptRound();
  expect((await f.sender.deliver(binding, envelope, new AbortController().signal)).status).toBe("unknown");
  expect(await f.deliver()).toMatchObject({ status: "retry", code: "desktop_helper_preparation_failed" });
  expect(f.preparations()).toBe(3);
  expect(f.replies.filter((entry) => entry.result.action === "accept")).toHaveLength(1);
  expect(saved(envelope).state).toBe("unknown");
});

test("shutdown cancels pending preparation and late callbacks cannot access a closed store", async () => {
  const f = fixture(true); await f.deliver();
  const closing = f.sender.close(); f.prepared.resolve(); await closing;
  f.store.close(); f.lost();
  expect(f.replies.some((entry) => entry.result.action === "accept")).toBe(false);
});
