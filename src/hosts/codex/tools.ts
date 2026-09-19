import type { ManagerCommand, ManagerPort, ReadOptions } from "../../contracts.ts";
import { nativeEvidence } from "./native.ts";
import { ConnectorError, identifier, onlyKeys, record, type NativeInvocation } from "./protocol.ts";

const string = { type: "string" };
const id = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" };
const version = { type: "integer", minimum: 1 };
const cursor = { type: "string", maxLength: 128 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const decision = object({
  kind: { enum: ["decision", "information", "attention"] }, title: string, question: string, context: string,
  target: string, effect: string, scope: string, conditions: string, recommendation: string,
  options: { type: "array", maxItems: 6, items: object({ id, label: string, meaning: string, kind: { enum: ["approve", "decline", "answer"] } }) },
}, ["kind", "title", "question", "context", "target", "effect", "scope", "conditions", "options"]);
const change = (type: string, properties: Record<string, unknown>, optional: string[] = []) => object(
  { type: { const: type }, requestId: id, expectedVersion: version, ...properties },
  ["type", "requestId", "expectedVersion", ...Object.keys(properties).filter((key) => !optional.includes(key))],
);

export const seekerTools = [
  { name: "submit", description: "Queue a bounded question for your configured owner. Use a stable requestId for retries. Submission does not prove delivery; if Seeker is unavailable, use native attention for required owner input. Only an explicitly registered native manager may submit; Seeker obtains your identity from Codex. Return promptly and continue unrelated work.", inputSchema: object({ requestId: id, decision }) },
  { name: "get", description: "Read complete saved records with current scope and the selected item's original revision. Use the collection and itemId named by a Seeker notification; deferred input also requires channelId. To read history, pass nextCursor unchanged with the same collection. A question or receipt is not an approval.", inputSchema: object({ requestId: id, collection: { enum: ["receipts", "deferred", "context", "revisions", "deliveries"] }, cursor, itemId: id, channelId: id }, ["requestId"]), annotations: { readOnlyHint: true } },
  { name: "pending", description: "Read one page of pending exchange summaries, then use get for complete questions and replies. Pass nextCursor unchanged for more summaries. This is for recovery, not repeated polling; Seeker delivers reply notifications through the native host.", inputSchema: object({ cursor }, []), annotations: { readOnlyHint: true } },
  { name: "update", description: "Add context, revise scope, cancel, acknowledge an authentic owner receipt, or reconcile saved input. Handling a natural reply does not close a decision: set resolvesExchange only when the owner's actual answer resolves it, never for a context question. Service notices are not human decisions. Native evidence comes from this invocation.", inputSchema: { type: "object", oneOf: [
    change("context", { messageId: id, text: string }),
    change("revise", { decision }),
    change("cancel", { reason: string }),
    change("acknowledge", { receiptId: id, status: { enum: ["received", "handled", "unknown"] }, note: string, resolvesExchange: { type: "boolean" } }, ["note", "resolvesExchange"]),
    change("reconcile-input", { channelId: id, eventId: id, note: string }, ["note"]),
  ] } },
] as const;

export function invokeManager(port: ManagerPort, operation: string, raw: unknown, origin: NativeInvocation): unknown {
  const input = record(raw);
  if (operation === "submit") {
    onlyKeys(input, ["requestId", "decision"]);
    return port.submit({ requestId: identifier(input.requestId), decision: input.decision as Parameters<ManagerPort["submit"]>[0]["decision"] });
  }
  if (operation === "get") {
    onlyKeys(input, ["requestId", "collection", "cursor", "itemId", "channelId"]);
    const { requestId, ...options } = input;
    return port.get(identifier(requestId), options as ReadOptions);
  }
  if (operation === "pending") {
    onlyKeys(input, ["cursor"]);
    return port.listPending(input as { cursor?: string });
  }
  if (operation !== "update") throw new ConnectorError("unknown_tool", "Unknown Seeker operation.");
  const fields: Record<string, string[]> = { context: ["messageId", "text"], revise: ["decision"], cancel: ["reason"], acknowledge: ["receiptId", "status", "note", "resolvesExchange"], "reconcile-input": ["channelId", "eventId", "note"] };
  const type = identifier(input.type);
  if (!Object.hasOwn(fields, type)) throw new ConnectorError("unknown_operation", "Unknown exchange update.");
  onlyKeys(input, ["type", "requestId", "expectedVersion", ...fields[type]!]);
  const command = { ...input, ...(type === "acknowledge" || type === "reconcile-input" ? { evidenceRef: nativeEvidence(origin) } : {}) };
  return port.update(command as Exclude<ManagerCommand, { type: "submit" }>);
}
