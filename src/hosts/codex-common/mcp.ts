import { createInterface } from "node:readline";
import { ConnectorError, identifier, invocationFromMetadata, maxWireBytes, record, type NativeInvocation } from "../codex/protocol.ts";
import { seekerTools } from "../codex/tools.ts";

/** The host adapter owns admission and delivery; the MCP boundary supplies invocation provenance. */
export interface SeekerToolsConnector {
  invoke(origin: NativeInvocation, operation: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  close(): void | Promise<void>;
}

/** Serve the shared tools on stdio. The caller starts and drains any background receiver. */
export async function serveSeekerTools(connector: SeekerToolsConnector): Promise<void> {
  const pending = new Map<string | number, AbortController>();
  let initialized = false;
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (Buffer.byteLength(line) > maxWireBytes) { send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP request too large." } }); return; }
    let message: Record<string, unknown>;
    try { message = record(JSON.parse(line)); }
    catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON-RPC message." } }); return; }
    if (message.method === "notifications/cancelled") {
      try { const id = record(message.params).requestId; if (typeof id === "string" || typeof id === "number") pending.get(id)?.abort(); } catch { /* Malformed notifications cannot cancel another request. */ }
      return;
    }
    if (message.id === undefined) return;
    const requestId = message.id;
    if ((typeof requestId !== "string" && typeof requestId !== "number") || pending.has(requestId) || pending.size >= 16) { send({ jsonrpc: "2.0", id: requestId ?? null, error: { code: -32600, message: "Invalid or duplicate MCP request." } }); return; }
    const controller = new AbortController(); pending.set(requestId, controller);
    void (async () => {
      if (message.method === "initialize") {
        if (initialized) throw new ConnectorError("already_initialized", "This connector is already initialized.");
        initialized = true;
        return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "seeker", version: "0.1.0" }, instructions: "Seeker carries authentic owner conversations for explicitly registered managers. Caller identity comes from Codex. Read the current exchange and receipt before acting on a notification; context questions are not approvals. Preserve native permissions. Submit promptly, continue independent work, and never poll repeatedly." };
      }
      if (!initialized) throw new ConnectorError("not_initialized", "Initialize the connector first.");
      if (message.method === "ping") return {};
      if (message.method === "tools/list") return { tools: seekerTools };
      if (message.method !== "tools/call") throw new ConnectorError("unknown_method", "Unsupported MCP method.");
      const params = record(message.params);
      try {
        const result = await connector.invoke(invocationFromMetadata(params._meta), identifier(params.name), params.arguments ?? {}, controller.signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        const known = error instanceof ConnectorError;
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: known ? error.code : "invalid_request", message: known ? error.message : "Seeker could not validate this request." }) }] };
      }
    })().then((result) => send({ jsonrpc: "2.0", id: requestId, result }), () => send({ jsonrpc: "2.0", id: requestId, error: { code: -32600, message: "Invalid MCP request." } })).finally(() => pending.delete(requestId));
  });
  const stop = () => lines.close();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try { await new Promise<void>((resolve) => { lines.once("close", resolve); }); }
  finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    for (const controller of pending.values()) controller.abort();
    await connector.close();
  }
}
