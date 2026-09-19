import { afterEach, expect, test } from "bun:test";
import type { ExchangeRead, InboundReply, ReadCollection } from "../src/contracts.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { fixtureBinding, fixtureDecision } from "../src/local/fixture.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";

const stores: SqliteExchangeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function setup() {
  const store = new SqliteExchangeStore(":memory:"); stores.push(store);
  const core = new SeekerCore(store, () => 1_000);
  core.bind(fixtureBinding);
  const manager = core.manager(fixtureBinding.origin);
  const created = manager.submit({ requestId: "request", decision: fixtureDecision });
  const reply = (eventId: string, overrides: Partial<InboundReply> = {}): InboundReply => ({
    eventId, actorId: "owner", conversationId: "inbox", sourceRef: `message:${eventId}`,
    replyHandle: created.current.replyHandle, kind: "answer", text: "A complete answer", ...overrides,
  });
  return { store, core, manager, reply, channel: core.channel("local") };
}

// Include both common MCP result representations and JSON string escaping.
function wireBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } }));
}

test("a backlog larger than a native frame remains fully readable and mutable through bounded pages", () => {
  const { store, manager, channel, reply } = setup();
  const expected = new Map<string, string>();
  const conditions = "Only the named target; preserve this entire condition.";
  for (let index = 0; index < 150; index += 1) {
    const eventId = `reply-${index}`, text = `${"x".repeat(7_900)}${String(index).padStart(3, "0")}`;
    expected.set(eventId, text);
    expect(["recorded", "deferred"]).toContain(channel.receive([reply(eventId, { text, conditions })])[0]!.status);
  }
  expect(Buffer.byteLength(JSON.stringify(store.get("request")))).toBeGreaterThan(1_048_576);
  const before = manager.get("request");
  expect(before.counts.receipts + before.counts.deferred).toBe(150);
  expect(before.counts.deferred).toBeGreaterThan(0);
  expect(before.exchange).not.toHaveProperty("receipts");
  const found = new Map<string, string>();
  let deferredEventId = "";
  for (const collection of ["receipts", "deferred"] satisfies ReadCollection[]) {
    let cursor: string | undefined;
    do {
      const page: ExchangeRead = manager.get("request", { collection, cursor });
      expect(page.items).toHaveLength(1);
      expect(wireBytes(page)).toBeLessThan(1_048_576);
      const item = page.items[0]!;
      if ("event" in item) {
        expect(item.event.conditions).toBe(conditions);
        expect(found.has(item.event.eventId)).toBe(false);
        found.set(item.event.eventId, item.event.text);
        deferredEventId = item.event.eventId;
      } else if ("source" in item) {
        expect(item.conditions).toBe(conditions);
        expect(found.has(item.source.eventId)).toBe(false);
        found.set(item.source.eventId, item.text);
      } else throw new Error("Unexpected read collection");
      cursor = page.nextCursor;
    } while (cursor);
  }
  expect(found).toEqual(expected);
  expect(manager.get("request").exchange.version).toBe(before.exchange.version);
  expect(wireBytes(manager.submit({ requestId: "request", decision: fixtureDecision }))).toBeLessThan(1_048_576);
  const focused = manager.get("request", { collection: "deferred", itemId: deferredEventId, channelId: "local" });
  expect(focused.items).toHaveLength(1);
  const updated = manager.update({ type: "reconcile-input", requestId: "request", expectedVersion: before.exchange.version,
    channelId: "local", eventId: deferredEventId, evidenceRef: "proof:reviewed-entire-input" });
  expect(wireBytes(updated)).toBeLessThan(1_048_576);
  expect(updated.counts.pendingDeferred).toBe(before.counts.pendingDeferred - 1);
  expect(updated.counts.deferred).toBe(before.counts.deferred);
  const handled = manager.get("request", { collection: "deferred", itemId: deferredEventId, channelId: "local" }).items[0]!;
  expect("event" in handled && handled.event.text).toBe(expected.get(deferredEventId)!);
  expect("disposition" in handled && handled.disposition.status).toBe("handled");
  expect(() => manager.get("request", { collection: "deferred", itemId: deferredEventId })).toThrow("original channel");
  expect(() => manager.get("request", { collection: "context", cursor: before.nextCursor })).toThrow("returned cursor");
});

test("focused reads retain the original proposal, escaped text and conditions with current ownership fences", () => {
  const { core, manager, channel, reply } = setup();
  let view = manager.update({ type: "context", requestId: "request", expectedVersion: 1, messageId: "explanation", text: "Complete original explanation" });
  const original = view.current;
  view = manager.update({ type: "revise", requestId: "request", expectedVersion: view.exchange.version,
    decision: { ...fixtureDecision, target: "A different target" } });
  const text = "\u0001".repeat(8_000), conditions = '"\\'.repeat(1_000);
  const input = channel.receive([reply("old-stop", { kind: "stop", text, conditions })])[0]!;
  view = manager.get("request", { itemId: input.receiptId });
  expect(view.items[0]).toMatchObject({ text, conditions, revision: 1 });
  expect(view.itemRevision).toEqual(original);
  expect(view.current.number).toBe(2);
  expect(wireBytes(view)).toBeLessThan(1_048_576);
  const context = manager.get("request", { collection: "context", itemId: "explanation" });
  expect(context.itemRevision).toEqual(original);
  expect(context.items[0]).toMatchObject({ text: "Complete original explanation" });
  expect(manager.get("request", { collection: "revisions", itemId: "1" }).items).toEqual([original]);
  const deliveries = manager.get("request", { collection: "deliveries" });
  expect(deliveries.nextCursor).toBeDefined();
  const delivery = deliveries.items[0]!;
  if (!("lane" in delivery)) throw new Error("Expected delivery");
  expect(manager.get("request", { collection: "deliveries", itemId: delivery.id }).items).toEqual([delivery]);
  expect(manager.get("request", { collection: "deliveries", cursor: deliveries.nextCursor }).items).not.toEqual([delivery]);
  const other = { ...fixtureBinding.origin, managerId: "other", assignmentId: "other-work" };
  core.bind({ ...fixtureBinding, id: "other-binding", origin: other });
  expect(() => core.manager(other).get("request", { itemId: input.receiptId })).toThrow("another manager");
  expect(() => manager.get("request", { collection: "context", itemId: input.receiptId })).toThrow("not found");
  const successor = { ...fixtureBinding.origin, managerId: "successor", generation: 2 };
  core.store.transfer(fixtureBinding.id, 1, successor);
  expect(() => manager.get("request")).toThrow("not bound");
  expect(() => manager.listPending()).toThrow("not bound");
  expect(core.manager(successor).get("request", { itemId: input.receiptId }).items[0]).toMatchObject({ text, conditions });
});

test("pending summaries page across one manager without embedding conversations or including closed work", () => {
  const { core, manager } = setup();
  const expected = ["request"];
  for (let index = 0; index < 23; index += 1) {
    const requestId = `pending-${String(index).padStart(2, "0")}`;
    manager.submit({ requestId, decision: fixtureDecision });
    expected.push(requestId);
  }
  manager.update({ type: "cancel", requestId: "request", expectedVersion: 1, reason: "Finished" });
  expected.splice(expected.indexOf("request"), 1);
  const other = { ...fixtureBinding.origin, managerId: "other", assignmentId: "other-work" };
  core.bind({ ...fixtureBinding, id: "other-binding", origin: other });
  core.manager(other).submit({ requestId: "other-request", decision: fixtureDecision });
  const first = manager.listPending();
  expect(first.items).toHaveLength(20);
  expect(first.total).toBe(23);
  expect(first.nextCursor).toBeDefined();
  const second = manager.listPending({ cursor: first.nextCursor });
  expect(second.items).toHaveLength(3);
  expect(second.nextCursor).toBeUndefined();
  expect([...first.items, ...second.items].map((item) => item.id)).toEqual(expected.sort());
  expect(first.items[0]).toEqual({ id: expected[0]!, title: fixtureDecision.title, kind: "decision", version: 1,
    revision: 1, state: "waiting", pendingInputs: 0, updatedAt: 1_000 });
  expect(wireBytes(first)).toBeLessThan(16_384);
});
