import type { EventPort, EventRef } from "../../events.ts";
import { turnEndings } from "../../events.ts";
import { ConnectorError, identifier, onlyKeys, record } from "./protocol.ts";

const id = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" };
const integer = { type: "integer", minimum: 1 };
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const ref = { waitId: id, generation: id, revision: id };
const title = { type: "string", maxLength: 200 };
export const eventTools = [
  { name: "event_arm", description: "Wait for a job without polling. Give a short title and an expiry (Unix milliseconds); Seeker creates the producer key file (mode 0600, under its own home) and returns the wait with that file's path as `capabilityFile`. Hand the path to whatever observes the job's end (the completion runner, or `seeker event signal`), then end your turn: the result arrives as a message to this task when it is saved, or a deadline notice at expiry. Nothing is started by Seeker. Optional: `waitId` to choose the id (retrying with it returns the same wait), `capabilityFile` to place the key yourself.", inputSchema: object({ title, expiresAt: integer, capabilityFile: { type: "string", minLength: 1, maxLength: 1024 }, revision: id, waitId: id }, ["title", "expiresAt"]) },
  { name: "event_watch", description: "Be woken when a task you started ends a turn. Give its thread id, a short title and an expiry (Unix milliseconds). By default the watch reports a failed or interrupted turn; set `on` to also report `completed`. Seeker reads the task's latest turn without a model and sends this task one message for the first reported ending, then the watch is done; watch again to keep watching. Nothing is sent to the watched task.", inputSchema: object({ title, expiresAt: integer, threadId: id, on: { type: "array", minItems: 1, uniqueItems: true, items: { enum: [...turnEndings] } }, waitId: id }, ["title", "expiresAt", "threadId"]) },
  { name: "event_get", description: "The full saved record of one wait: its state, result and delivery. The message that woke you already carries the result; read this when you need the untruncated summary or the delivery details.", inputSchema: object(ref, ["waitId"]), annotations: { readOnlyHint: true } },
  { name: "event_pending", description: "This task's open waits and watches: waiting, or with a result Seeker has not delivered yet. Results arrive on their own; this is not for polling. A delivered wait is not listed.", inputSchema: object({}, []), annotations: { readOnlyHint: true } },
  { name: "event_cancel", description: "Stop a wait or watch you no longer need. Nothing more is delivered for it; what was saved stays readable until retention clears it.", inputSchema: object({ ...ref, expectedVersion: integer }, ["waitId"]) },
  { name: "event_acknowledge", description: "Only when a wait's delivery is `unknown` (Seeker could not confirm the message reached you): say `handled` if you have the result, or `unknown` if you do not. A confirmed delivery needs no acknowledgment.", inputSchema: object({ ...ref, status: { enum: ["received", "handled", "unknown"] }, receiptId: id, expectedVersion: integer }, ["waitId", "status"]) },
  { name: "event_clear", description: "Remove a settled wait's saved record now. Not needed: Seeker clears settled waits itself a day after they settle.", inputSchema: object({ ...ref, expectedVersion: integer }, ["waitId"]) },
] as const;

export function isEventOperation(operation: string): boolean { return eventTools.some((tool) => tool.name === operation); }
export function invokeEvent(port: EventPort, operation: string, raw: unknown): unknown {
  const input = record(raw);
  if (operation === "event_pending") { onlyKeys(input, []); return port.pending(); }
  if (operation === "event_arm") { onlyKeys(input, ["title", "expiresAt", "capabilityFile", "revision", "waitId"]); return port.arm(input as never); }
  if (operation === "event_watch") { onlyKeys(input, ["title", "expiresAt", "threadId", "on", "waitId"]); return port.watch(input as never); }
  const reference: EventRef = { waitId: identifier(input.waitId) };
  if (input.generation !== undefined) reference.generation = identifier(input.generation);
  if (input.revision !== undefined) reference.revision = identifier(input.revision);
  if (operation === "event_get") { onlyKeys(input, Object.keys(ref)); return port.get(reference); }
  onlyKeys(input, [...Object.keys(ref), "expectedVersion", ...(operation === "event_acknowledge" ? ["receiptId", "status"] : [])]);
  if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1)) throw new ConnectorError("invalid_input", "expectedVersion is the version read from the wait.");
  const options = input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion as number };
  if (operation === "event_cancel") return port.cancel(reference, options);
  if (operation === "event_clear") return port.clear(reference, options);
  if (operation === "event_acknowledge") {
    if (!["received", "handled", "unknown"].includes(String(input.status))) throw new ConnectorError("invalid_input", "Choose received, handled or unknown.");
    return port.acknowledge(reference, input.status as "received" | "handled" | "unknown", { ...options, ...(input.receiptId !== undefined ? { receiptId: identifier(input.receiptId) } : {}) });
  }
  throw new ConnectorError("unknown_tool", "Unknown event operation.");
}
