import { expect, test } from "bun:test";
import type { MessagingChannel } from "../src/contracts.ts";
import { DeliveryPump } from "../src/core/delivery.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";
import { fixtureBinding, fixtureDecision } from "../src/local/fixture.ts";
import { LocalChannel } from "../src/local/channel.ts";

test("one stuck adapter is quarantined without starving healthy adapters or spawning replacements", async () => {
  const store = new SqliteExchangeStore(":memory:");
  const core = new SeekerCore(store);
  const pending: (() => void)[] = [];
  let blockedCalls = 0, healthyCalls = 0;
  const channels: MessagingChannel[] = [
    { id: "stuck", send: () => { blockedCalls += 1; return new Promise((resolve) => pending.push(() => resolve({ status: "accepted", reference: "late-message" }))); } },
    { id: "healthy", send: async () => { healthyCalls += 1; return { status: "accepted", reference: `healthy-${healthyCalls}` }; } },
  ];
  for (const channel of channels) {
    const binding = { ...fixtureBinding, id: channel.id, origin: { ...fixtureBinding.origin, managerId: channel.id }, recipient: { ...fixtureBinding.recipient, channelId: channel.id } };
    core.bind(binding);
    for (let i = 0; i < 5; i += 1) core.manager(binding.origin).submit({ requestId: `${channel.id}-${i}`, decision: fixtureDecision });
  }
  const pump = new DeliveryPump(core, channels, [], 20);
  try {
    pump.start();
    await Bun.sleep(100);
    expect(blockedCalls).toBe(1);
    expect(healthyCalls).toBe(5);
    expect(store.get("stuck-0")!.deliveries[0]!.state).toBe("unknown");
    expect(store.get("stuck-1")!.deliveries[0]!.attempts).toBe(0);
    expect(pump.inFlight).toBe(0);
    pump.stop();
    for (const settle of pending) settle();
    await Bun.sleep(0);
  } finally { pump.stop(); store.close(); }
});

test("terminal channel failure notifies the original manager without making a human receipt or notice loop", async () => {
  const store = new SqliteExchangeStore(":memory:");
  const core = new SeekerCore(store);
  core.bind({ ...fixtureBinding, recipient: { ...fixtureBinding.recipient, channelId: "unavailable" } });
  core.manager(fixtureBinding.origin).submit({ requestId: "contact-failure", decision: fixtureDecision });
  let notices = 0;
  const pump = new DeliveryPump(core, [{ id: "unavailable", send: async () => ({ status: "unknown", code: "connection_lost" }) }], [{
    id: "fixture", deliver: async (binding, envelope) => {
      expect(binding.origin.managerId).toBe(fixtureBinding.origin.managerId);
      expect("notice" in envelope).toBe(true);
      notices += 1;
      return { status: "unknown", code: "host_connection_lost" };
    },
  }]);
  try {
    pump.start(); await Bun.sleep(30);
    const view = store.get("contact-failure")!;
    expect(notices).toBe(1);
    expect(view.exchange.receipts).toHaveLength(0);
    expect(view.deliveries).toHaveLength(2);
    expect(view.exchange.state).toBe("waiting");
  } finally { pump.stop(); store.close(); }
});

test("a stuck task does not block another binding on the same host adapter", async () => {
  const store = new SqliteExchangeStore(":memory:");
  const core = new SeekerCore(store);
  let blockedCalls = 0, healthyCalls = 0;
  let settle: (() => void) | undefined;
  for (const name of ["stuck", "healthy"]) {
    const binding = { ...fixtureBinding, id: name, origin: { ...fixtureBinding.origin, managerId: name, assignmentId: `work-${name}` } };
    core.bind(binding);
    const request = core.manager(binding.origin).submit({ requestId: name, decision: fixtureDecision });
    for (let index = 0; index < 4; index += 1) core.channel("local").receive([{
      eventId: `${name}-${index}`, actorId: "owner", conversationId: "inbox", sourceRef: `${name}:${index}`,
      replyHandle: request.exchange.revisions[0]!.replyHandle, kind: "question", text: `Question ${index}?`,
    }]);
  }
  const pump = new DeliveryPump(core, [new LocalChannel()], [{
    id: "fixture",
    deliver(binding) {
      if (binding.id === "stuck") { blockedCalls += 1; return new Promise((resolve) => { settle = () => resolve({ status: "accepted", reference: "late" }); }); }
      healthyCalls += 1; return Promise.resolve({ status: "accepted", reference: `healthy-${healthyCalls}` });
    },
  }], 20);
  try {
    pump.start(); await Bun.sleep(100);
    expect(blockedCalls).toBe(1); expect(healthyCalls).toBe(4);
    expect(pump.inFlight).toBe(0);
    pump.stop(); settle?.(); await Bun.sleep(0);
  } finally { pump.stop(); store.close(); }
});

test("a verified successor progresses while the predecessor's aborted operation remains quarantined", async () => {
  const store = new SqliteExchangeStore(":memory:");
  const core = new SeekerCore(store);
  core.bind(fixtureBinding);
  const request = core.manager(fixtureBinding.origin).submit({ requestId: "transfer", decision: fixtureDecision });
  core.channel("local").receive([{ eventId: "answer", actorId: "owner", conversationId: "inbox", sourceRef: "local:answer", replyHandle: request.exchange.revisions[0]!.replyHandle, kind: "answer", text: "Keep it local." }]);
  let predecessorCalls = 0, successorCalls = 0;
  let settle: (() => void) | undefined;
  const pump = new DeliveryPump(core, [new LocalChannel()], [{ id: "fixture", deliver: (binding, envelope) => {
    if (binding.origin.generation === 1) {
      predecessorCalls += 1;
      return new Promise((resolve) => { settle = () => resolve({ status: "accepted", reference: "predecessor" }); });
    }
    successorCalls += 1;
    expect(envelope.requiresReconciliation).toBe(true);
    return Promise.resolve({ status: "accepted", reference: "successor" });
  } }], 20);
  try {
    pump.start(); await Bun.sleep(40);
    store.transfer(fixtureBinding.id, 1, { ...fixtureBinding.origin, managerId: "successor", generation: 2 });
    await Bun.sleep(240);
    expect(predecessorCalls).toBe(1); expect(successorCalls).toBe(1);
    pump.stop(); settle?.(); await Bun.sleep(0);
  } finally { pump.stop(); store.close(); }
});
