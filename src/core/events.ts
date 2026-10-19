import { createHash } from "node:crypto";
import type { EventAddress, EventArm, EventOwner, EventSignal, EventWait } from "../events.ts";
import { fail, id, integer, object, text } from "./validation.ts";

export const eventLimits = { resultBytes: 16_384, retained: 4096, perTask: 128 } as const;
export const eventRoute = (wait: Pick<EventWait, "owner">): string => JSON.stringify(["event", wait.owner.hostId, wait.owner.taskId]);
export const eventDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const eventFingerprint = (value: unknown): string => eventDigest(JSON.stringify(value));

function keys(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) fail("unexpected_argument", "Unexpected event argument.");
}
export function eventAddress(raw: unknown): EventAddress {
  const value = object(raw);
  return { waitId: id(value.waitId, "Wait"), generation: id(value.generation, "Wait generation"), revision: id(value.revision, "Source revision") };
}
export function eventOwner(raw: EventOwner): EventOwner {
  const value: EventOwner = { hostId: id(raw.hostId, "Host"), taskId: id(raw.taskId, "Task"), turnId: id(raw.turnId, "Turn"), callId: id(raw.callId, "Call") };
  if ((raw.bindingId === undefined) !== (raw.ownerGeneration === undefined)) fail("invalid_origin", "An event assignment snapshot must be complete.");
  if (raw.bindingId !== undefined) { value.bindingId = id(raw.bindingId, "Binding"); value.ownerGeneration = integer(raw.ownerGeneration, "Owner generation", 1); }
  return value;
}
export function eventArm(raw: unknown, now: number, allowPast = false): EventArm {
  const value = object(raw); keys(value, ["waitId", "generation", "revision", "title", "expiresAt", "capabilityDigest"]);
  const expiresAt = integer(value.expiresAt, "Expiry", 1);
  if (!allowPast && expiresAt <= now) fail("event_expired", "Choose an explicit future wait expiry.", 409);
  if (typeof value.capabilityDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.capabilityDigest)) fail("invalid_capability", "Use the digest from a private event capability file.");
  return { ...eventAddress(value), title: text(value.title, "Wait title", 200), expiresAt, capabilityDigest: value.capabilityDigest };
}
export function eventSignal(raw: unknown): EventSignal {
  const value = object(raw); keys(value, ["waitId", "generation", "revision", "eventId", "outcome", "summary", "evidenceRefs"]);
  if (!["completed", "released", "failed"].includes(String(value.outcome))) fail("invalid_input", "Choose completed, released or failed.");
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 8) fail("invalid_input", "Provide up to eight evidence references.");
  const result: EventSignal = { ...eventAddress(value), eventId: id(value.eventId, "Event"), outcome: value.outcome as EventSignal["outcome"], summary: text(value.summary, "Result summary", 8192), evidenceRefs: value.evidenceRefs.map((ref) => text(ref, "Evidence reference", 1000)) };
  if (Buffer.byteLength(JSON.stringify(result)) > eventLimits.resultBytes) fail("too_large", "The saved event result exceeds its byte limit.", 413);
  return result;
}
export function eventPublic(value: EventWait & { capabilityDigest?: string; armFingerprint?: string; signalFingerprint?: string }): EventWait {
  const { capabilityDigest: _capability, armFingerprint: _arm, signalFingerprint: _signal, ...publicValue } = value;
  return structuredClone(publicValue);
}
export function sameEventOwner(a: Pick<EventOwner, "hostId" | "taskId">, b: Pick<EventOwner, "hostId" | "taskId">): boolean { return a.hostId === b.hostId && a.taskId === b.taskId; }
