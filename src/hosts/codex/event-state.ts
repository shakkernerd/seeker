import { ConnectorError, identifier, record } from "./protocol.ts";

export interface NativeEventState { taskId: string; turnId: string; status: "inProgress" | "completed" | "interrupted" | "failed" }

/** Discard messages, previews and outputs at the native reader; only return generation metadata. */
export function parseNativeEventState(response: unknown, taskId: string): NativeEventState {
  const result = record(response);
  if (result.success !== true || !Array.isArray(result.contentItems) || result.contentItems.length !== 1) throw unavailable();
  const item = record(result.contentItems[0]);
  if (item.type !== "inputText" || typeof item.text !== "string") throw unavailable();
  const value = record(JSON.parse(item.text)), thread = record(value.thread), page = record(value.page);
  if (value.schemaVersion !== 1 || thread.id !== taskId || thread.kind !== "codex" || page.order !== "newest_first" || !Array.isArray(value.turns) || value.turns.length !== 1) throw unavailable();
  return parseNativeEventTurn(taskId, value.turns[0]);
}
export function parseNativeEventTurn(taskId: string, raw: unknown): NativeEventState {
  const turn = record(raw);
  if (!["inProgress", "completed", "interrupted", "failed"].includes(String(turn.status))) throw unavailable();
  return { taskId: identifier(taskId), turnId: identifier(turn.id), status: turn.status as NativeEventState["status"] };
}
export function eventAnchorState(armedTurnId: string, state: NativeEventState): "ready" | "active" | "changed" | "stopped" {
  if (state.turnId !== armedTurnId) return "changed";
  if (state.status === "inProgress") return "active";
  if (state.status === "completed") return "ready";
  return "stopped";
}
function unavailable(): ConnectorError { return new ConnectorError("event_native_state_unqualified", "The native event owner's current turn could not be qualified.", 503); }
