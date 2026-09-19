import { expect, test } from "bun:test";
import type { MessagingChannel } from "../src/contracts.ts";
import { DeliveryPump } from "../src/core/delivery.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";
import { fixtureBinding, fixtureDecision } from "../src/local/fixture.ts";

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
