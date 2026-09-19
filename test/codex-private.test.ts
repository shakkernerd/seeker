import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExchangeRead, PendingPage } from "../src/contracts.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";
import { CodexConnector } from "../src/hosts/codex/connector.ts";
import { readConnectorConfig, readConnectorCredential } from "../src/hosts/codex/config.ts";
import { CodexNativeClient } from "../src/hosts/codex/native.ts";
import { privateRequest } from "../src/hosts/codex/private-http.ts";
import { loadCodexHost, setupCodex } from "../src/hosts/codex/setup.ts";
import { codexRoute, maxWireBytes } from "../src/hosts/codex/protocol.ts";
import { localRecipient } from "../src/local/channel.ts";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sk-private-")));
  const project = join(root, "project"), pkg = join(root, "package"), data = join(root, "data");
  mkdirSync(project); mkdirSync(join(pkg, "bin"), { recursive: true }); mkdirSync(join(pkg, "dist"));
  writeFileSync(join(pkg, "bin", "seeker-codex"), "fixture"); writeFileSync(join(pkg, "dist", "codex-connector.mjs"), "fixture");
  const store = new SqliteExchangeStore(":memory:"), core = new SeekerCore(store);
  const configured = setupCodex({ core, dataDir: data, projectDirectory: project, packageDirectory: pkg, threadId: "00000000-0000-7000-8000-000000000001", label: "Native test manager", recipient: localRecipient });
  const config = readConnectorConfig(configured.configPath), credential = readConnectorCredential(config.credentialFile);
  closers.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, core, store, data, config, credential, configured, project, pkg };
}

test("trusted native setup selects only the future route and keeps old owner replies authentic", () => {
  const value = setup(), origin = { ...value.configured.binding.origin, turnId: "turn", callId: "call" };
  const decision = { kind: "information" as const, title: "Demo", question: "A or B?", context: "", target: "", effect: "", scope: "", conditions: "", options: [] };
  const old = value.core.manager(origin).submit({ requestId: "old-route", decision });
  const recipient = { channelId: "configured-channel", actorId: "paired-owner", conversationId: "paired-conversation" };
  setupCodex({ core: value.core, dataDir: value.data, projectDirectory: value.project, packageDirectory: value.pkg, threadId: origin.managerId, label: "Native test manager", recipient });
  const next = value.core.manager(origin).submit({ requestId: "new-route", decision });
  expect(next.exchange.recipient).toEqual(recipient);
  expect(value.core.manager(origin).get(old.exchange.id).exchange.recipient).toEqual(localRecipient);
  expect(value.core.channel("local").receive([{ eventId: "old-owner-reply", actorId: "owner", conversationId: "inbox", sourceRef: "local:old", replyHandle: old.current.replyHandle, kind: "question", text: "Why?" }])[0]!.status).toBe("recorded");
});

test("private listener preserves admission, closes pending polls and is removed on close", async () => {
  const value = setup(), native = (await loadCodexHost(value.core, value.data))!;
  closers.push(() => native.close());
  expect(lstatSync(value.config.socketPath).mode & 0o777).toBe(0o600);
  const response = await privateRequest(value.config.socketPath, `${codexRoute}/connect`, value.credential, { protocol: 1, instanceId: "private-client" }, AbortSignal.timeout(1_000));
  expect(response.status).toBe(200);
  const session = JSON.parse(response.text).session;
  const origin = { threadId: value.configured.binding.origin.managerId, turnId: "native-turn", callId: "native-call" };
  const allowed = await privateRequest(value.config.socketPath, `${codexRoute}/invoke`, session, { origin, operation: "pending", arguments: {} }, AbortSignal.timeout(1_000));
  expect(allowed.status).toBe(200);
  const denied = await privateRequest(value.config.socketPath, `${codexRoute}/invoke`, session, { origin: { ...origin, threadId: "worker" }, operation: "pending", arguments: {} }, AbortSignal.timeout(1_000));
  expect(denied.status).toBe(403);
  const controller = new AbortController();
  const polling = privateRequest(value.config.socketPath, `${codexRoute}/poll`, session, {}, controller.signal).catch(() => undefined);
  await Bun.sleep(10);
  await native.close();
  await polling;
  expect(existsSync(value.config.socketPath)).toBe(false);
  const restored = (await loadCodexHost(value.core, value.data))!;
  closers.push(() => restored.close());
  expect(existsSync(value.config.socketPath)).toBe(true);
  rmSync(value.config.socketPath);
  writeFileSync(value.config.socketPath, "replacement must survive", { mode: 0o600 });
  await restored.close();
  expect(readFileSync(value.config.socketPath, "utf8")).toBe("replacement must survive");
});

test("a backlog larger than the private wire frame stays fully readable through native tools", async () => {
  const value = setup(), native = (await loadCodexHost(value.core, value.data))!;
  closers.push(() => native.close());
  const origin = { threadId: value.configured.binding.origin.managerId, turnId: "turn", callId: "call" };
  const connection = await privateRequest(value.config.socketPath, `${codexRoute}/connect`, value.credential, { protocol: 1, instanceId: "backlog-client" }, AbortSignal.timeout(1_000));
  const session = JSON.parse(connection.text).session;
  const invoke = async <T>(operation: string, args: unknown): Promise<T> => {
    const response = await privateRequest(value.config.socketPath, `${codexRoute}/invoke`, session, { origin, operation, arguments: args }, AbortSignal.timeout(1_000));
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: response.text }] }))).toBeLessThan(maxWireBytes);
    return JSON.parse(response.text) as T;
  };
  const decision = { kind: "information", title: "Read the complete saved answer", question: "Which label?", context: "", target: "", effect: "", scope: "", conditions: "", options: [] };
  const created = await invoke<ExchangeRead>("submit", { requestId: "backlog", decision });
  const expected = new Map<string, string>(), conditions = "Keep the entire original condition.";
  for (let index = 0; index < 150; index += 1) {
    const eventId = `reply-${index}`, text = `${"x".repeat(7_900)}${index}`;
    expected.set(eventId, text);
    value.core.channel("local").receive([{ eventId, actorId: "owner", conversationId: "inbox", sourceRef: `local:${eventId}`, replyHandle: created.current.replyHandle, kind: "answer", text, conditions }]);
  }
  expect(Buffer.byteLength(JSON.stringify(value.store.get("backlog")))).toBeGreaterThan(maxWireBytes);
  const found = new Map<string, string>();
  let deferredEventId = "";
  for (const collection of ["receipts", "deferred"] as const) {
    let cursor: string | undefined;
    do {
      const page = await invoke<ExchangeRead>("get", { requestId: "backlog", collection, cursor });
      const item = page.items[0]!;
      if ("event" in item) {
        expect(item.event.conditions).toBe(conditions);
        found.set(item.event.eventId, item.event.text);
        deferredEventId = item.event.eventId;
      } else if ("source" in item) {
        expect(item.conditions).toBe(conditions);
        found.set(item.source.eventId, item.text);
      } else throw new Error("Expected a complete saved owner reply");
      cursor = page.nextCursor;
    } while (cursor);
  }
  expect(found).toEqual(expected);
  const focused = await invoke<ExchangeRead>("get", { requestId: "backlog", collection: "deferred", itemId: deferredEventId, channelId: "local" });
  expect(focused.items[0]).toMatchObject({ event: { eventId: deferredEventId, text: expected.get(deferredEventId), conditions } });
  await invoke<ExchangeRead>("update", { type: "reconcile-input", requestId: "backlog", expectedVersion: focused.exchange.version, channelId: "local", eventId: deferredEventId });
  await invoke<ExchangeRead>("submit", { requestId: "backlog", decision });
  for (let index = 0; index < 20; index += 1) await invoke<ExchangeRead>("submit", { requestId: `another-${index}`, decision });
  const first = await invoke<PendingPage>("pending", {});
  expect(first.total).toBe(21);
  expect(first.items).toHaveLength(20);
  expect(first.nextCursor).toBeDefined();
  const last = await invoke<PendingPage>("pending", { cursor: first.nextCursor });
  expect(last.items).toHaveLength(1);
  expect(last.nextCursor).toBeUndefined();
});

test("downtime and an old TCP registration cannot expose the connector credential to an impostor", async () => {
  const value = setup(); let tcpRequests = 0;
  const impostor = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { tcpRequests += 1; return Response.json({ protocol: 1, hostId: "codex-desktop", session: "a".repeat(64) }); } });
  closers.push(async () => { await impostor.stop(true); });
  const old = join(value.data, "old.json");
  writeFileSync(old, JSON.stringify({ version: 1, hostId: "codex-desktop", endpoint: `http://127.0.0.1:${impostor.port}`, credentialFile: value.config.credentialFile }), { mode: 0o600 });
  expect(() => readConnectorConfig(old)).toThrow("Re-run");
  const connector = new CodexConnector(value.config, value.credential, new CodexNativeClient("unused"));
  await expect(connector.invoke({ threadId: "manager", turnId: "turn", callId: "call" }, "pending", {})).rejects.toThrow();
  expect(tcpRequests).toBe(0);
  await connector.close();
});

test("unsafe address replacement is rejected before any request and unrelated socket-path data survives", async () => {
  const value = setup(); let received = 0;
  const missing = join(value.root, "missing.sock");
  symlinkSync(missing, value.config.socketPath);
  await expect(loadCodexHost(value.core, value.data)).rejects.toThrow("unrelated data");
  expect(lstatSync(value.config.socketPath).isSymbolicLink()).toBe(true);
  expect(existsSync(missing)).toBe(false);
  rmSync(value.config.socketPath);
  const elsewhere = join(value.root, "elsewhere.sock");
  const impostor = Bun.serve({ unix: elsewhere, fetch() { received += 1; return Response.json({}); } });
  closers.push(async () => { await impostor.stop(true); });
  symlinkSync(elsewhere, value.config.socketPath);
  expect(() => privateRequest(value.config.socketPath, `${codexRoute}/connect`, value.credential, {}, AbortSignal.timeout(1_000))).toThrow("private and owned");
  await expect(loadCodexHost(value.core, value.data)).rejects.toThrow("unrelated data");
  expect(lstatSync(value.config.socketPath).isSymbolicLink()).toBe(true);
  expect(received).toBe(0);
  rmSync(value.config.socketPath);
  writeFileSync(value.config.socketPath, "retained unrelated file", { mode: 0o600 });
  await expect(loadCodexHost(value.core, value.data)).rejects.toThrow("unrelated data");
  expect(readFileSync(value.config.socketPath, "utf8")).toBe("retained unrelated file");
  chmodSync(value.data, 0o755);
  expect(() => readConnectorConfig(value.configured.configPath)).toThrow("private directory");
});
