import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, DeliveryResult, ManagerBinding, ReceiptEnvelope } from "../src/contracts.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";
import { localRecipient } from "../src/local/channel.ts";
import { invocationFromMetadata, nativeWakeup, type NativeInvocation } from "../src/hosts/codex/protocol.ts";
import { cliHostId, cliRoute } from "../src/hosts/codex-cli/config.ts";
import { CodexCliHost } from "../src/hosts/codex-cli/host.ts";
import type { CliOwner, RegisteredCliOwner } from "../src/hosts/codex-cli/owner.ts";
import { NativeRpcError } from "../src/hosts/codex-cli/rpc.ts";
import type { CliRuntime, NativeCliConnection } from "../src/hosts/codex-cli/runtime.ts";
import { readCliRegistration, saveCliRegistration } from "../src/hosts/codex-cli/state.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const credential = "a".repeat(64);
const decision: Decision = { kind: "information", title: "Choose a label", question: "Which label?", context: "", target: "", effect: "", scope: "", conditions: "", options: [] };
const managerId = "00000000-0000-7000-8000-000000000001", otherManagerId = "00000000-0000-7000-8000-000000000002";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
// Flush the host's queued readiness callback, without polling or a timing margin.
const readinessTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
interface NativeCall { method: string; params: unknown; signal: AbortSignal }

function fixture(registered = true) {
  const directory = mkdtempSync(join(tmpdir(), "seeker-cli-test-")), statePath = join(directory, "owner.json");
  const store = new SqliteExchangeStore(":memory:");
  let now = Date.now(), sequence = 0;
  const core = new SeekerCore(store, () => now);
  const bindings = [managerId, otherManagerId].map((id): ManagerBinding => ({ id, label: id, origin: { hostId: cliHostId, managerId: id, assignmentId: id, generation: 1 }, recipient: localRecipient }));
  bindings.forEach((binding) => core.bind(binding));
  const owner: CliOwner = {
    process: { pid: 41001, parentPid: 1, uid: process.getuid!(), startedAt: "Sat Sep 19 10:00:00 2026", executable: "/private/fixture/codex" },
    codexHome: "/private/fixture/home", sqliteHome: "/private/fixture/sqlite", cwd: "/private/fixture/work",
    listen: "unix:///private/fixture/native.sock", socketPath: "/private/fixture/native.sock",
    executableFile: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  };
  const registration: RegisteredCliOwner = { version: 1, owner, remoteControl: "disabled" };
  if (registered) saveCliRegistration(statePath, registration);
  const calls: NativeCall[] = [], connections: CliOwner[] = [], restorations: number[] = [];
  const defaultResponse = (call: NativeCall): unknown => {
    if (call.method === "remoteControl/status/read") return { status: "disabled" };
    if (call.method === "thread/read" || call.method === "thread/resume") return { thread: { id: (call.params as { threadId: string }).threadId, status: { type: "idle" } } };
    if (call.method === "turn/start") return { turn: { id: "native-return-turn" } };
    throw new Error(`Unexpected native method: ${call.method}`);
  };
  const behavior = { request: async (call: NativeCall): Promise<unknown> => defaultResponse(call), restored: (_count: number) => {} };
  const rpc: NativeCliConnection & { connected: boolean } = {
    connected: true,
    async request<T>(method: string, params: unknown, signal: AbortSignal): Promise<T> {
      signal.throwIfAborted();
      const call = { method, params, signal }; calls.push(call);
      return await behavior.request(call) as T;
    },
    close() { this.connected = false; },
  };
  const runtime: CliRuntime = {
    verify: async (_owner, signal) => { signal.throwIfAborted(); },
    gone: async (_owner, signal) => { signal.throwIfAborted(); return false; },
    connect: async (value, signal) => { signal.throwIfAborted(); connections.push(value); return rpc; },
    restart: async () => { throw new Error("Unexpected native restart"); },
  };
  const resumeHost = core.resumeHost.bind(core);
  core.resumeHost = (id) => { const count = resumeHost(id); restorations.push(count); behavior.restored(count); return count; };
  const host = new CodexCliHost(core, credential, statePath, runtime);
  cleanups.push(async () => { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const invoke = (origin: NativeInvocation, operation: string, args: unknown) => host.handle(new Request(`http://localhost${cliRoute}`, {
    method: "POST", headers: { authorization: `Bearer ${credential}` }, body: JSON.stringify({ owner, origin, operation, arguments: args }),
  }));
  return { host, core, store, bindings, owner, registration, statePath, runtime, rpc, calls, connections, behavior, defaultResponse, restorations, invoke,
    advance: () => { now += 10_000; }, nextId: () => `cli-request-${++sequence}` };
}
type Fixture = ReturnType<typeof fixture>;
const invocation = (threadId = managerId): NativeInvocation => invocationFromMetadata({
  "x-codex-turn-metadata": { thread_id: threadId, turn_id: "native-turn" }, threadId, sessionId: managerId, callId: "native-call",
});
function reply(f: Fixture, binding = f.bindings[0]!): { binding: ManagerBinding; envelope: ReceiptEnvelope } {
  const view = f.core.manager(binding.origin).submit({ requestId: f.nextId(), decision });
  const received = f.core.channel("local").receive([{ eventId: view.exchange.id, actorId: "owner", conversationId: "inbox", sourceRef: `local:${view.exchange.id}`, replyHandle: view.current.replyHandle, kind: "answer", text: "Use A, only for this fixture.", conditions: "No repository work." }])[0]!;
  const saved = f.store.get(view.exchange.id)!, receipt = saved.exchange.receipts.find((item) => item.id === received.receiptId)!;
  const delivery = saved.deliveries.find((item) => item.lane === "host" && item.receiptId === receipt.id)!;
  return { binding, envelope: { deliveryId: delivery.id, exchangeId: saved.exchange.id, revision: saved.exchange.revisions[receipt.revision - 1]!, receipt, requiresReconciliation: false } };
}
const send = (f: Fixture, value: ReturnType<typeof reply>, signal = new AbortController().signal) => f.host.deliver(value.binding, value.envelope, signal);
async function prepare(f: Fixture, value: ReturnType<typeof reply>): Promise<void> {
  const ready = deferred<number>(); f.behavior.restored = ready.resolve;
  expect((await send(f, value)).status).toBe("retry");
  await ready.promise;
}
async function attempt(f: Fixture, value: ReturnType<typeof reply>): Promise<DeliveryResult> {
  const claimed = f.store.claimDeliveries(8, f.core.clock());
  for (const delivery of claimed.filter((item) => item.lane === "channel")) f.store.completeDelivery(delivery.id, delivery.attemptId!, { status: "accepted", reference: `local:${delivery.id}` }, f.core.clock());
  const delivery = claimed.find((item) => item.id === value.envelope.deliveryId);
  expect(delivery?.lane).toBe("host");
  const result = await send(f, value);
  f.store.completeDelivery(delivery!.id, delivery!.attemptId!, result, f.core.clock());
  return result;
}
const storedDelivery = (f: Fixture, value: ReturnType<typeof reply>) => f.store.get(value.envelope.exchangeId)!.deliveries.find((item) => item.id === value.envelope.deliveryId)!;

test("native per-call identity admits registered managers, never a worker's shared root session or tool identity fields", async () => {
  const f = fixture(false);
  expect((await f.invoke(invocation(), "submit", { requestId: "manager-request", decision })).status).toBe(200);
  expect(f.store.get("manager-request")!.exchange.origin).toMatchObject({ managerId, turnId: "native-turn", callId: "native-call" });
  expect(readCliRegistration(f.statePath)).toEqual(f.registration);
  const beforeWorker = f.calls.length;
  const worker = invocation("00000000-0000-7000-8000-000000000003");
  expect((await f.invoke(worker, "submit", { requestId: "worker-request", decision, managerId, role: "manager" })).status).toBe(403);
  expect(f.calls).toHaveLength(beforeWorker);
  expect(f.store.get("worker-request")).toBeUndefined();
  expect(() => invocationFromMetadata({ "x-codex-turn-metadata": { thread_id: worker.threadId, turn_id: worker.turnId }, threadId: managerId, sessionId: managerId, callId: "spoof" })).toThrow();
  for (const identity of [{ managerId }, { origin: invocation() }, { sessionId: managerId }, { role: "manager" }]) {
    expect((await f.invoke(invocation(), "submit", { requestId: "forged-request", decision, ...identity })).status).toBe(400);
  }
  expect(f.store.get("forged-request")).toBeUndefined();
  expect((await f.invoke(invocation(otherManagerId), "get", { requestId: "manager-request" })).status).toBe(403);
});

test("a disabled notice outranks an older enabled snapshot on fresh and reused connections and survives recovery", async () => {
  const f = fixture(false);
  for (const _connection of ["fresh", "reused"]) {
    const reading = deferred<void>(), release = deferred<void>();
    let snapshots = 0;
    f.behavior.request = async (call) => {
      if (call.method === "remoteControl/status/read" && ++snapshots === 1) {
        reading.resolve(); await abortable(release.promise, call.signal);
        return { status: "connected" };
      }
      return f.defaultResponse(call);
    };
    const admission = f.invoke(invocation(), "pending", {});
    await reading.promise;
    f.rpc.onNotice?.("remoteControl/status/changed", { status: "disabled" });
    release.resolve();
    expect((await admission).status).toBe(200);
    expect(readCliRegistration(f.statePath)?.remoteControl).toBe("disabled");
    expect(snapshots).toBe(2);
    expect(f.connections).toHaveLength(1);
  }
  await readinessTurn();
  f.behavior.request = async (call) => f.defaultResponse(call);
  f.rpc.close();
  const restarted: CliOwner = { ...f.owner, process: { ...f.owner.process, pid: 41002, startedAt: "Sat Sep 19 10:00:10 2026" } };
  const recoveryRpc: NativeCliConnection & { connected: boolean } = { ...f.rpc, connected: true, onNotice: undefined };
  const starts: RegisteredCliOwner[] = [];
  f.runtime.gone = async (owner) => owner.process.pid === f.owner.process.pid;
  f.runtime.restart = async (registration) => { starts.push(registration); return restarted; };
  f.runtime.connect = async (owner, signal) => { signal.throwIfAborted(); f.connections.push(owner); return recoveryRpc; };
  const value = reply(f); await prepare(f, value);
  expect(starts).toEqual([{ ...f.registration, remoteControl: "disabled" }]);
  expect(readCliRegistration(f.statePath)).toEqual({ ...f.registration, owner: restarted, remoteControl: "disabled" });
  expect((await attempt(f, value)).status).toBe("accepted");
});

test("preparation returns known retry before native readiness, coalescing connection and each manager resume without input", async () => {
  const f = fixture(), first = reply(f), second = reply(f, f.bindings[1]!);
  const connecting = deferred<void>(), connection = deferred<NativeCliConnection>(), resumed = deferred<void>(), release = deferred<void>();
  let connects = 0;
  f.runtime.connect = async (_owner, signal) => { connects += 1; connecting.resolve(); return abortable(connection.promise, signal); };
  f.behavior.request = async (call) => {
    if (call.method === "thread/resume") {
      if (f.calls.filter((item) => item.method === "thread/resume").length === 2) resumed.resolve();
      await abortable(release.promise, call.signal);
    }
    return f.defaultResponse(call);
  };
  const results = await Promise.all([send(f, first), send(f, first), send(f, second)]);
  for (const result of results) expect(result).toEqual({ status: "retry", retryAfterMs: 1_000, code: "cli_preparing" });
  await connecting.promise; expect(connects).toBe(1);
  connection.resolve(f.rpc); await resumed.promise;
  expect(f.calls.filter((call) => call.method === "thread/resume").map((call) => call.params)).toEqual([
    { threadId: managerId, excludeTurns: true }, { threadId: otherManagerId, excludeTurns: true },
  ]);
  expect(f.calls.some((call) => call.method === "turn/start")).toBe(false);
  const ready = deferred<number>(); f.behavior.restored = ready.resolve; release.resolve(); await ready.promise;
  expect(f.calls.some((call) => call.method === "turn/start")).toBe(false);
});

test.each(["generation", "exchange cancellation", "delivery cancellation"] as const)("%s during preparation cannot send input", async (change) => {
  const f = fixture(), value = reply(f), controller = new AbortController(), entered = deferred<void>(), release = deferred<void>();
  f.behavior.request = async (call) => {
    if (call.method === "thread/resume") { entered.resolve(); await abortable(release.promise, call.signal); }
    return f.defaultResponse(call);
  };
  expect((await send(f, value, controller.signal)).status).toBe("retry"); await entered.promise;
  if (change === "generation") f.store.transfer(value.binding.id, 1, { ...value.binding.origin, generation: 2 });
  else if (change === "exchange cancellation") {
    const port = f.core.manager(value.binding.origin), current = port.get(value.envelope.exchangeId);
    port.update({ type: "cancel", requestId: current.exchange.id, expectedVersion: current.exchange.version, reason: "No longer needed." });
  } else controller.abort();
  release.resolve(); await readinessTurn();
  expect((await send(f, value, controller.signal)).status).toBe(change === "delivery cancellation" ? "retry" : "rejected");
  expect(f.calls.some((call) => call.method === "turn/start")).toBe(false);
});

test("cold recovery retains the registered profile and saved UUID, without model or permission overrides", async () => {
  const f = fixture(), value = reply(f), restarted = { ...f.owner, process: { ...f.owner.process, pid: 41002 } };
  const starts: RegisteredCliOwner[] = [];
  f.runtime.gone = async (owner) => owner.process.pid === f.owner.process.pid;
  f.runtime.restart = async (registration) => { starts.push(registration); return restarted; };
  await prepare(f, value);
  expect(starts).toEqual([f.registration]);
  expect(f.connections).toEqual([restarted]);
  expect(readCliRegistration(f.statePath)).toEqual({ ...f.registration, owner: restarted });
  expect(f.calls.filter((call) => call.method === "thread/resume").map((call) => call.params)).toEqual([{ threadId: managerId, excludeTurns: true }]);
  expect((await attempt(f, value)).status).toBe("accepted");
  const input = f.calls.find((call) => call.method === "turn/start")!;
  expect(input.params).toEqual({ threadId: managerId, input: [{ type: "text", text: nativeWakeup({ attemptId: "fixture", binding: value.binding, envelope: value.envelope }) }] });
  expect(f.calls.some((call) => call.method === "thread/start")).toBe(false);
});

test("shutdown retains a restarted owner first verified during starter settlement, without sending input", async () => {
  const f = fixture(), value = reply(f), entered = deferred<AbortSignal>(), never = deferred<never>();
  const restarted: CliOwner = { ...f.owner, process: { ...f.owner.process, pid: 41002, startedAt: "Sat Sep 19 10:00:10 2026" } };
  f.runtime.gone = async () => true;
  f.runtime.restart = async (_registration, signal) => {
    entered.resolve(signal);
    try { await abortable(never.promise, signal); } catch { /* The starter becomes verifiable during cancellation settlement. */ }
    return restarted;
  };
  expect((await send(f, value)).status).toBe("retry");
  const signal = await entered.promise;
  await f.host.close();
  expect(signal.aborted).toBe(true);
  expect(readCliRegistration(f.statePath)).toEqual({ ...f.registration, owner: restarted });
  expect(f.connections).toHaveLength(0);
  expect(f.calls.some((call) => call.method === "turn/start")).toBe(false);
});

test("a successor generation of the same UUID recovers exhausted delivery while the predecessor resume is still waiting", async () => {
  const f = fixture(), predecessor = reply(f), oldEntered = deferred<void>(), oldRelease = deferred<void>(), newRelease = deferred<void>();
  let resumes = 0;
  f.behavior.request = async (call) => {
    if (call.method === "thread/resume") {
      resumes += 1;
      if (resumes === 1) { oldEntered.resolve(); await abortable(oldRelease.promise, call.signal); }
      else await abortable(newRelease.promise, call.signal);
    }
    return f.defaultResponse(call);
  };
  expect((await attempt(f, predecessor)).status).toBe("retry"); await oldEntered.promise;
  f.store.transfer(predecessor.binding.id, 1, { ...predecessor.binding.origin, generation: 2 }); f.advance();
  const saved = f.store.get(predecessor.envelope.exchangeId)!;
  const delivery = saved.deliveries.find((item) => item.lane === "host" && item.receiptId === predecessor.envelope.receipt.id && item.state === "queued")!;
  const successor = {
    binding: f.core.managerBinding(cliHostId, managerId)!,
    envelope: { ...predecessor.envelope, deliveryId: delivery.id, receipt: saved.exchange.receipts[0]!, requiresReconciliation: true },
  };
  for (let i = 0; i < 5; i += 1) { expect((await attempt(f, successor)).status).toBe("retry"); f.advance(); }
  expect(resumes).toBe(2);
  expect(f.connections).toHaveLength(1);
  expect(storedDelivery(f, successor)).toMatchObject({ state: "rejected", code: "retry_exhausted", attempts: 5, ownerGeneration: 2 });
  expect(f.calls.some((call) => call.method === "turn/start")).toBe(false);
  const ready = deferred<number>(); f.behavior.restored = ready.resolve; newRelease.resolve();
  expect(await ready.promise).toBe(1);
  expect(storedDelivery(f, successor)).toMatchObject({ state: "retry", attempts: 0 });
  expect((await attempt(f, successor)).status).toBe("accepted");
  expect((await send(f, predecessor)).status).toBe("rejected");
  oldRelease.resolve(); await readinessTurn();
  expect((await send(f, predecessor)).status).toBe("rejected");
  expect(f.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  expect(f.restorations).toEqual([1]);
});

test("a prewrite failure retries, while accepted input is sent once and does not claim manager handling", async () => {
  const f = fixture(), value = reply(f); await prepare(f, value);
  let starts = 0;
  f.behavior.request = async (call) => {
    if (call.method === "turn/start" && ++starts === 1) throw new NativeRpcError(false, "native_capacity");
    return f.defaultResponse(call);
  };
  expect(await attempt(f, value)).toEqual({ status: "retry", code: "native_capacity", retryAfterMs: 1_000 });
  expect(storedDelivery(f, value).state).toBe("retry");
  f.advance();
  const accepted: DeliveryResult = { status: "accepted", reference: `cli:${managerId}:native-return-turn` };
  expect(await attempt(f, value)).toEqual(accepted);
  expect(await send(f, value)).toEqual(accepted);
  expect(starts).toBe(2);
  expect(storedDelivery(f, value).state).toBe("accepted");
  expect(f.store.get(value.envelope.exchangeId)!.exchange.receipts[0]!.disposition.status).toBe("pending");
});

test.each(["lost response", "unrecognized response"] as const)("%s after write stays uncertain and is never automatically replayed", async (failure) => {
  const f = fixture(), value = reply(f); await prepare(f, value);
  f.behavior.request = async (call) => {
    if (call.method !== "turn/start") return f.defaultResponse(call);
    if (failure === "lost response") throw new NativeRpcError(true, "native_connection_lost");
    return { turn: {} };
  };
  const result = await attempt(f, value);
  expect(result).toEqual({ status: "unknown", code: failure === "lost response" ? "cli_input_uncertain" : "cli_response_unrecognized" });
  expect(storedDelivery(f, value).state).toBe("unknown");
  expect(f.core.resumeHost(cliHostId)).toBe(0);
  f.advance(); expect(f.store.claimDeliveries(8, f.core.clock())).toEqual([]);
  expect(await send(f, value)).toEqual(result);
  expect(f.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
});

test("one readiness transition revives exhausted retries; repeated admitted reads cannot keep reopening them", async () => {
  const f = fixture(false), admitted = deferred<number>(); f.behavior.restored = admitted.resolve;
  expect((await f.invoke(invocation(), "pending", {})).status).toBe(200); await admitted.promise;
  const value = reply(f), release = deferred<void>();
  f.behavior.request = async (call) => {
    if (call.method === "thread/resume") await abortable(release.promise, call.signal);
    if (call.method === "turn/start") throw new NativeRpcError(false, "native_capacity");
    return f.defaultResponse(call);
  };
  for (let i = 0; i < 5; i += 1) { expect((await attempt(f, value)).status).toBe("retry"); f.advance(); }
  expect(storedDelivery(f, value)).toMatchObject({ state: "rejected", code: "retry_exhausted", attempts: 5 });
  expect(f.calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
  expect(f.calls.some((call) => call.method === "turn/start")).toBe(false);
  const ready = deferred<number>(); f.behavior.restored = ready.resolve; release.resolve(); expect(await ready.promise).toBe(1);
  expect(storedDelivery(f, value)).toMatchObject({ state: "retry", attempts: 0 });
  for (let i = 0; i < 5; i += 1) { await attempt(f, value); f.advance(); }
  for (let i = 0; i < 2; i += 1) expect((await f.invoke(invocation(), "pending", {})).status).toBe(200);
  await readinessTurn();
  expect(f.restorations).toEqual([0, 1]);
  expect(storedDelivery(f, value)).toMatchObject({ state: "rejected", code: "retry_exhausted", attempts: 5 });
});

test.each(["preparation", "input"] as const)("shutdown aborts and settles outstanding %s", async (stage) => {
  const f = fixture(), value = reply(f), entered = deferred<AbortSignal>(), never = deferred<never>();
  let settled = false;
  const hold = async (signal: AbortSignal) => { entered.resolve(signal); try { return await abortable(never.promise, signal); } finally { settled = true; } };
  if (stage === "preparation") {
    f.runtime.gone = async () => true;
    f.runtime.restart = async (_registration, signal) => hold(signal);
  } else {
    await prepare(f, value);
    f.behavior.request = async (call) => {
      if (call.method === "turn/start") { await hold(call.signal); }
      return f.defaultResponse(call);
    };
  }
  const delivery = send(f, value), signal = await entered.promise;
  await f.host.close();
  expect(signal.aborted).toBe(true); expect(settled).toBe(true);
  expect((await delivery).status).toBe(stage === "preparation" ? "retry" : "unknown");
  expect((await send(f, value)).status).toBe("retry");
  if (stage === "preparation") expect(f.connections).toHaveLength(0);
  else expect(f.rpc.connected).toBe(false);
});
