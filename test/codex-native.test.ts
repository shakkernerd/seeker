import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexNativeClient } from "../src/hosts/codex/native.ts";
import { installSection } from "../src/hosts/codex/setup.ts";
import type { NativeDelivery } from "../src/hosts/codex/protocol.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function delivery(): NativeDelivery {
  return {
    attemptId: "attempt-one",
    binding: { id: "binding-one", label: "Manager", origin: { hostId: "native", managerId: "task-one", assignmentId: "assignment", generation: 1, turnId: "original-turn", callId: "original-call" }, recipient: { channelId: "local", actorId: "owner", conversationId: "inbox" } },
    envelope: { deliveryId: "delivery-one", exchangeId: "request-one", revision: { number: 1, replyHandle: "handle-one", createdAt: 1, decision: { kind: "information", title: "A question", question: "A or B?", context: "", target: "", effect: "", scope: "", conditions: "", options: [] } }, receipt: { id: "receipt-one", revision: 1, kind: "question", text: "Explain B", conditions: "", classification: "response", source: { channelId: "local", actorId: "owner", conversationId: "inbox", eventId: "event-one", reference: "local:event", recordedAt: 2, verification: "channel" }, disposition: { status: "pending" } }, requiresReconciliation: false },
  };
}

async function nativeFixture(mode: "accepted" | "drop" | "wrong-target" | "bad-frame" = "accepted") {
  const path = join(tmpdir(), `sk-${randomUUID().slice(0, 8)}.sock`);
  const requests: Record<string, any>[] = [], sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (pending.length < 4 || pending.length < pending.readUInt32LE(0) + 4) return;
      const request = JSON.parse(pending.subarray(4, pending.readUInt32LE(0) + 4).toString());
      requests.push(request);
      if (request.method === "tools/call" && mode === "drop") { socket.destroy(); return; }
      if (request.method === "tools/call" && mode === "bad-frame") { const header = Buffer.alloc(4); header.writeUInt32LE(0xffffffff); socket.end(header); return; }
      const result = request.method === "tools/list"
        ? { tools: [{ name: "send_message_to_thread", namespace: "codex_app", inputSchema: { type: "object", properties: { threadId: { type: "string" }, prompt: { type: "string" } } } }] }
        : { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ threadId: mode === "wrong-target" ? "different-task" : request.params.arguments.threadId }) }] };
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      const frame = Buffer.alloc(4 + body.length); frame.writeUInt32LE(body.length); body.copy(frame, 4);
      socket.write(frame.subarray(0, 2)); socket.write(frame.subarray(2, 9)); socket.end(frame.subarray(9));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  cleanup.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  return { path, requests };
}

describe("native input boundary", () => {
  test("uses the exact existing target and supplies no execution setting overrides", async () => {
    const fixture = await nativeFixture();
    const result = await new CodexNativeClient(fixture.path).deliver(delivery());
    expect(result).toEqual({ status: "accepted", reference: "codex:delivery-one" });
    const call = fixture.requests.find((request) => request.method === "tools/call")!;
    expect(call.params.tool).toBe("send_message_to_thread");
    expect(call.params.threadId).toBe("task-one");
    expect(call.params.turnId).toBe("original-turn");
    expect(Object.keys(call.params.arguments).sort()).toEqual(["prompt", "threadId"]);
    expect(call.params.arguments.prompt).toContain("receipt-one");
    expect(call.params.arguments.prompt).toContain('"collection":"receipts","itemId":"receipt-one"');
    expect(call.params.arguments.prompt).toContain("not an approval");
    expect(fixture.requests.some((request) => /thread\/(start|resume|fork)|approval/.test(request.method))).toBe(false);
  });

  test("uncertain writes, wrong targets and oversized frames never become retryable success", async () => {
    for (const mode of ["drop", "wrong-target", "bad-frame"] as const) {
      const fixture = await nativeFixture(mode);
      expect((await new CodexNativeClient(fixture.path).deliver(delivery())).status).toBe("unknown");
      expect(fixture.requests.filter((request) => request.method === "tools/call")).toHaveLength(1);
    }
    expect((await new CodexNativeClient(join(tmpdir(), `missing-${randomUUID()}.sock`)).deliver(delivery())).status).toBe("retry");
  });

  test("missing original provenance cannot invent a native caller", async () => {
    const value = delivery(); delete value.binding.origin.turnId;
    expect(await new CodexNativeClient("unused").deliver(value)).toMatchObject({ status: "retry", code: "native_origin_required" });
  });

  test("saved input and service failure notices use native input without impersonating an owner decision", async () => {
    const fixture = await nativeFixture(), native = new CodexNativeClient(fixture.path), value = delivery();
    const shared = { deliveryId: "deferred-delivery", exchangeId: value.envelope.exchangeId, revision: value.envelope.revision, requiresReconciliation: true as const };
    value.envelope = { ...shared, deferred: { channelId: "local", event: { eventId: "saved-event", actorId: "owner", conversationId: "inbox", sourceRef: "local:event", kind: "answer", text: "Only for the demo", conditions: "No real work" }, exchangeId: shared.exchangeId, revision: 1, recordedAt: 1, verification: "channel", disposition: { status: "pending" } } };
    expect((await native.deliver(value)).status).toBe("accepted");
    value.envelope = { ...shared, deliveryId: "notice-delivery", notice: { deliveryId: "failed-channel-delivery", state: "unknown", code: "transport_lost" } };
    expect((await native.deliver(value)).status).toBe("accepted");
    const messages = fixture.requests.filter((request) => request.method === "tools/call").map((request) => request.params.arguments.prompt as string);
    expect(messages[0]).toContain("reconcile-input");
    expect(messages[0]).toContain('"collection":"deferred","itemId":"saved-event","channelId":"local"');
    expect(messages[0]).toContain("not an accepted approval");
    expect(messages[1]).toContain("not a human reply");
    expect(messages[1]).toContain("native attention path");
    expect(messages[1]).toContain('"collection":"deliveries","itemId":"failed-channel-delivery"');
    expect(messages[1]).not.toContain("acknowledge this receipt");
  });
});

describe("scoped native setup", () => {
  test("preserves existing permission settings and other servers on install and repeat setup", () => {
    const previous = '[permissions]\ndefault = "read-only"\n\n[mcp_servers.existing]\ncommand = "other-tool"\n';
    const installed = installSection(previous, "/opt/seeker/bin/seeker-codex", "/private/seeker/connector.json");
    expect(installed.startsWith(previous)).toBe(true);
    expect(Bun.TOML.parse(installed)).toMatchObject({ permissions: { default: "read-only" }, mcp_servers: { existing: { command: "other-tool" }, seeker: { required: false, env_vars: ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_SQLITE_HOME"] } } });
    expect(installSection(installed, "/opt/seeker/bin/seeker-codex", "/private/seeker/connector.json")).toBe(installed);
    expect(installed).not.toContain("approval_mode");
    const configured = installed.replace("enabled = true", "enabled = false").replace("required = false", "required = true").replace("tool_timeout_sec = 15", "tool_timeout_sec = 45");
    const refreshed = installSection(configured, "/opt/new-seeker/bin/seeker-codex", "/private/seeker/connector.json");
    expect(Bun.TOML.parse(refreshed)).toMatchObject({ mcp_servers: { seeker: { command: "/opt/new-seeker/bin/seeker-codex", enabled: false, required: true, tool_timeout_sec: 45 } } });
    const legacy = configured.replace(',"CODEX_HOME","CODEX_ELECTRON_USER_DATA_PATH","CODEX_SQLITE_HOME"', "");
    expect(installSection(legacy, "/opt/new-seeker/bin/seeker-codex", "/private/seeker/connector.json")).toBe(refreshed);
    expect(() => installSection(installed, "/opt/new-seeker/bin/seeker-codex", "/another/connector.json")).toThrow("different Seeker data directory");
  });

  test("refuses unrelated or customized seeker settings instead of overwriting permission policy", () => {
    expect(() => installSection('[mcp_servers.seeker]\ncommand = "mine"\n', "/new", "/config")).toThrow("already exists");
    const installed = installSection("", "/opt/seeker/bin/seeker-codex", "/config");
    const customized = installed.replace("# Seeker native connector: end", 'default_tools_approval_mode = "prompt"\n# Seeker native connector: end');
    expect(() => installSection(customized, "/newer", "/config")).toThrow("custom settings");
  });
});
