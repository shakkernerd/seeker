import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { EventAddress, EventArmRequest, EventArm, EventOwner, EventRef, EventResult, EventSignal, EventWait, EventWatch, EventWatchRequest, ThreadObservation, TurnEnding } from "../events.ts";
import { turnEndings } from "../events.ts";
import { fail, id, integer, object, text } from "./validation.ts";

/** `retainedMs`: a settled wait (delivered, handled, cancelled or expired) is cleared by the service this long after it settled. */
/** `noticeBytes` bounds the summary and references a notice carries, under the native input limit with room for the rest of the message. */
export const eventLimits = { resultBytes: 16_384, retained: 4096, perTask: 128, retainedMs: 86_400_000, noticeSummaryChars: 2000, noticeSummaryBytes: 6000, noticeBytes: 12_000 } as const;
/** The endings a watch reports unless the task chose; a completed turn is ordinary and stays quiet by default. */
export const defaultWatchEndings: readonly TurnEnding[] = ["failed", "interrupted"];
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
/** A wait named by its id; generation and revision are checked only when the caller gives them. */
export function eventRef(raw: unknown): EventRef {
  const value = object(raw);
  const ref: EventRef = { waitId: id(value.waitId, "Wait") };
  if (value.generation !== undefined) ref.generation = id(value.generation, "Wait generation");
  if (value.revision !== undefined) ref.revision = id(value.revision, "Source revision");
  return ref;
}
function expiry(value: unknown, now: number, allowPast: boolean, what: string): number {
  const expiresAt = integer(value, "Expiry", 1);
  if (!allowPast && expiresAt <= now) fail("event_expired", `Choose an explicit future ${what} expiry.`, 409);
  return expiresAt;
}
export function eventArmRequest(raw: unknown, now: number): EventArmRequest {
  const value = object(raw); keys(value, ["title", "expiresAt", "capabilityFile", "revision", "waitId"]);
  const request: EventArmRequest = { title: text(value.title, "Wait title", 200), expiresAt: expiry(value.expiresAt, now, false, "wait") };
  if (value.capabilityFile !== undefined) {
    if (typeof value.capabilityFile !== "string" || !isAbsolute(value.capabilityFile) || value.capabilityFile.includes("\0") || value.capabilityFile.length > 1024) fail("invalid_capability_path", "Give an absolute path for the producer key file inside a private directory, or omit it and let Seeker place the key.");
    request.capabilityFile = value.capabilityFile;
  }
  if (value.revision !== undefined) request.revision = id(value.revision, "Source revision");
  if (value.waitId !== undefined) request.waitId = id(value.waitId, "Wait");
  return request;
}
export function eventWatchRequest(raw: unknown, now: number): EventWatchRequest {
  const value = object(raw); keys(value, ["title", "expiresAt", "threadId", "on", "waitId"]);
  const request: EventWatchRequest = { title: text(value.title, "Watch title", 200), expiresAt: expiry(value.expiresAt, now, false, "watch"), threadId: id(value.threadId, "Watched task") };
  if (value.on !== undefined) request.on = endings(value.on);
  if (value.waitId !== undefined) request.waitId = id(value.waitId, "Wait");
  return request;
}
function endings(raw: unknown): TurnEnding[] {
  if (!Array.isArray(raw) || !raw.length || raw.some((item) => !turnEndings.includes(item as TurnEnding))) fail("invalid_input", "Choose which turn endings to report: completed, failed or interrupted.");
  return turnEndings.filter((ending) => raw.includes(ending));
}
export function eventOwner(raw: EventOwner): EventOwner {
  const value: EventOwner = { hostId: id(raw.hostId, "Host"), taskId: id(raw.taskId, "Task"), turnId: id(raw.turnId, "Turn"), callId: id(raw.callId, "Call") };
  if ((raw.bindingId === undefined) !== (raw.ownerGeneration === undefined)) fail("invalid_origin", "An event assignment snapshot must be complete.");
  if (raw.bindingId !== undefined) { value.bindingId = id(raw.bindingId, "Binding"); value.ownerGeneration = integer(raw.ownerGeneration, "Owner generation", 1); }
  return value;
}
export function eventArm(raw: unknown, now: number, allowPast = false): EventArm {
  const value = object(raw); keys(value, ["waitId", "generation", "revision", "title", "expiresAt", "capabilityDigest", "keyFile"]);
  const expiresAt = integer(value.expiresAt, "Expiry", 1);
  if (!allowPast && expiresAt <= now) fail("event_expired", "Choose an explicit future wait expiry.", 409);
  if (typeof value.capabilityDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.capabilityDigest)) fail("invalid_capability", "Use the digest from a private event capability file.");
  const arm: EventArm = { ...eventAddress(value), title: text(value.title, "Wait title", 200), expiresAt, capabilityDigest: value.capabilityDigest };
  if (value.keyFile !== undefined) { if (typeof value.keyFile !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}\.json$/.test(value.keyFile)) fail("invalid_capability", "A Seeker-placed key file is named after its wait within the key directory."); arm.keyFile = value.keyFile; }
  return arm;
}
export function eventWatch(raw: unknown, now: number, allowPast = false): EventWatch {
  const value = object(raw); keys(value, ["waitId", "generation", "revision", "title", "expiresAt", "threadId", "on", "seen"]);
  const watch: EventWatch = { ...eventAddress(value), title: text(value.title, "Watch title", 200), expiresAt: expiry(value.expiresAt, now, allowPast, "watch"), threadId: id(value.threadId, "Watched task"), on: endings(value.on) };
  if (value.seen !== undefined) { const seen = threadObservation(value.seen); watch.seen = { turnId: seen.turnId, status: seen.status }; }
  return watch;
}
export function threadObservation(raw: unknown): ThreadObservation {
  const value = object(raw); keys(value, ["turnId", "status", "completedAt"]);
  if (value.status !== "inProgress" && !turnEndings.includes(value.status as TurnEnding)) fail("invalid_input", "A turn is in progress, completed, failed or interrupted.");
  const observation: ThreadObservation = { turnId: id(value.turnId, "Turn"), status: value.status as ThreadObservation["status"] };
  if (value.completedAt !== undefined) observation.completedAt = integer(value.completedAt, "Turn completion time", 1);
  return observation;
}
/** The creation time a UUIDv7 carries, as Codex turn ids do; undefined for any other id. */
export function uuidTime(value: string): number | undefined {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(value);
  return match ? Number.parseInt(match[1]! + match[2]!, 16) : undefined;
}
/**
 * The result a notice carries, within the native input limit: the summary bounded, then as many
 * references as fit, each complete so it can be used as given; the rest stay in the saved record.
 */
export function eventResult(wait: EventWait): EventResult {
  if (!wait.receipt) throw new Error("An event result requires a saved receipt.");
  const { signal } = wait.receipt;
  let summary = signal.summary.length > eventLimits.noticeSummaryChars ? signal.summary.slice(0, eventLimits.noticeSummaryChars) : signal.summary;
  while (Buffer.byteLength(summary) > eventLimits.noticeSummaryBytes) summary = summary.slice(0, -100);
  if (summary.length < signal.summary.length) summary = `${summary} … (truncated; the full summary is in the saved record)`;
  const evidenceRefs: string[] = [];
  let bytes = Buffer.byteLength(summary);
  for (const ref of signal.evidenceRefs) { const size = Buffer.byteLength(ref) + 2; if (bytes + size > eventLimits.noticeBytes) break; evidenceRefs.push(ref); bytes += size; }
  const result: EventResult = { outcome: signal.outcome, summary, evidenceRefs };
  if (evidenceRefs.length < signal.evidenceRefs.length) result.omittedRefs = signal.evidenceRefs.length - evidenceRefs.length;
  if (wait.title !== undefined) result.title = wait.title;
  if (wait.receipt.source) result.source = wait.receipt.source;
  return result;
}
export function eventSignal(raw: unknown): EventSignal {
  const value = object(raw); keys(value, ["waitId", "generation", "revision", "eventId", "outcome", "summary", "evidenceRefs"]);
  if (!["completed", "released", "failed"].includes(String(value.outcome))) fail("invalid_input", "Choose completed, released or failed.");
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 8) fail("invalid_input", "Provide up to eight evidence references.");
  const result: EventSignal = { ...eventAddress(value), eventId: id(value.eventId, "Event"), outcome: value.outcome as EventSignal["outcome"], summary: text(value.summary, "Result summary", 8192), evidenceRefs: value.evidenceRefs.map((ref) => text(ref, "Evidence reference", 1000)) };
  if (Buffer.byteLength(JSON.stringify(result)) > eventLimits.resultBytes) fail("too_large", "The saved event result exceeds its byte limit.", 413);
  return result;
}
export function eventPublic(value: EventWait & { capabilityDigest?: string; keyFile?: string; armFingerprint?: string; signalFingerprint?: string }): EventWait {
  const { capabilityDigest: _capability, keyFile: _key, armFingerprint: _arm, signalFingerprint: _signal, ...publicValue } = value;
  return structuredClone(publicValue);
}
export function sameEventOwner(a: Pick<EventOwner, "hostId" | "taskId">, b: Pick<EventOwner, "hostId" | "taskId">): boolean { return a.hostId === b.hostId && a.taskId === b.taskId; }
