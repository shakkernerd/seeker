import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexNativeClient } from "../src/hosts/codex/native.ts";
import { installSection } from "../src/hosts/codex/setup.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function nativeFixture(mode: "compatible" | "drop" | "bad-frame" | "extra-required" | "wrong-input-type" | "send" | "refuse" | "drop-call" | "garbled" = "compatible") {
  const path = join(tmpdir(), `sk-${randomUUID().slice(0, 8)}.sock`);
  const requests: Record<string, any>[] = [], sockets = new Set<Socket>(), calls = new Set(["arm-call"]);
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (pending.length < 4 || pending.length < pending.readUInt32LE(0) + 4) return;
      const request = JSON.parse(pending.subarray(4, pending.readUInt32LE(0) + 4).toString());
      requests.push(request);
      if (mode === "drop") { socket.destroy(); return; }
      if (mode === "bad-frame") { const header = Buffer.alloc(4); header.writeUInt32LE(0xffffffff); socket.end(header); return; }
      let result: unknown = { tools: [{ name: "send_message_to_thread", namespace: "codex_app", inputSchema: { type: "object", properties: { threadId: { type: mode === "wrong-input-type" ? "number" : "string" }, prompt: { type: "string" } }, ...(mode === "extra-required" ? { required: ["threadId", "prompt", "newRequiredField"] } : {}) } }] };
      let error: unknown;
      if (request.method === "tools/call") {
        if (mode === "drop-call") { socket.destroy(); return; }
        if (mode === "refuse") error = { code: -32000, message: "Codex app tool request failed" };
        else if (mode === "garbled") result = { success: true, contentItems: [{ type: "inputText", text: "not json" }] };
        else if (calls.has(request.params.callId)) error = { code: -32603, message: "Native call identity was already used." };
        else { calls.add(request.params.callId); result = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ threadId: request.params.arguments.threadId }) }] }; }
      }
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) }));
      const frame = Buffer.alloc(4 + body.length); frame.writeUInt32LE(body.length); body.copy(frame, 4);
      socket.write(frame.subarray(0, 2)); socket.write(frame.subarray(2, 9)); socket.end(frame.subarray(9));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  cleanup.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  return { path, requests };
}

describe("native catalogue qualification", () => {
  test("a native send is one stamped tool call confirmed by the host's echoed target, with no model involved", async () => {
    const fixture = await nativeFixture("send"), client = new CodexNativeClient(fixture.path);
    const origin = { threadId: "owner", turnId: "armed-turn", callId: "fresh-call" }, args = { threadId: "owner", prompt: "Seeker recorded a machine background event for this task." };
    expect(await client.send(origin, args)).toEqual({ status: "accepted", threadId: "owner" });
    expect(fixture.requests.map((request) => request.method)).toEqual(["tools/list", "tools/call"]);
    expect(fixture.requests[1]!.params).toEqual({ arguments: args, callerSource: "codex", namespace: "codex_app", tool: "send_message_to_thread", threadId: "owner", turnId: "armed-turn", callId: "fresh-call" });
    // A reused call identity is refused by the host and reported as unsent.
    expect(await client.send(origin, args)).toEqual({ status: "refused", code: "native_input_refused" });
    expect(await new CodexNativeClient((await nativeFixture("refuse")).path).send(origin, args)).toEqual({ status: "refused", code: "native_input_refused" });
    // After the request reached the host, a lost or unreadable answer is not evidence that nothing was sent.
    expect(await new CodexNativeClient((await nativeFixture("drop-call")).path).send(origin, args)).toEqual({ status: "uncertain", code: "native_disconnected" });
    expect(await new CodexNativeClient((await nativeFixture("garbled")).path).send(origin, args)).toEqual({ status: "uncertain", code: "native_target_unconfirmed" });
    const missing = await new CodexNativeClient(join(tmpdir(), `missing-${randomUUID()}.sock`)).send(origin, args);
    expect(missing).toEqual({ status: "refused", code: "native_unavailable" });
  });

  test("rejects an incompatible refreshed input capability", async () => {
    for (const mode of ["extra-required", "wrong-input-type"] as const) {
      const fixture = await nativeFixture(mode);
      await expect(new CodexNativeClient(fixture.path).qualify()).rejects.toMatchObject({ code: "native_incompatible" });
      expect(fixture.requests.map((request) => request.method)).toEqual(["tools/list"]);
    }
  });

  test("qualifies the fragmented catalogue response without sending native input", async () => {
    const fixture = await nativeFixture();
    await new CodexNativeClient(fixture.path).qualify();
    expect(fixture.requests).toEqual([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: { threadStartKind: "all" } }]);
  });

  test("dropped connections and oversized frames cannot qualify a connector", async () => {
    for (const mode of ["drop", "bad-frame"] as const) {
      const fixture = await nativeFixture(mode);
      await expect(new CodexNativeClient(fixture.path).qualify()).rejects.toMatchObject({ code: mode === "drop" ? "native_disconnected" : "native_invalid_frame" });
      expect(fixture.requests.map((request) => request.method)).toEqual(["tools/list"]);
    }
    await expect(new CodexNativeClient(join(tmpdir(), `missing-${randomUUID()}.sock`)).qualify()).rejects.toMatchObject({ code: "native_unavailable" });
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

  test("preserves recognized permission policy and refuses unrelated custom settings", () => {
    expect(() => installSection('[mcp_servers.seeker]\ncommand = "mine"\n', "/new", "/config")).toThrow("already exists");
    const installed = installSection("", "/opt/seeker/bin/seeker-codex", "/config");
    const customized = installed.replace("# Seeker native connector: end", 'default_tools_approval_mode = "prompt"\n# Seeker native connector: end');
    const preserved = Bun.TOML.parse(installSection(customized, "/newer/bin/seeker-codex", "/config")) as { mcp_servers: { seeker: { default_tools_approval_mode: string; tools?: unknown } } };
    expect(preserved.mcp_servers.seeker.default_tools_approval_mode).toBe("prompt");
    expect(preserved.mcp_servers.seeker.tools).toBeUndefined();
    expect(() => installSection(customized.replace('default_tools_approval_mode = "prompt"', "custom_native_setting = true"), "/newer/bin/seeker-codex", "/config")).toThrow("custom settings");
  });
});
