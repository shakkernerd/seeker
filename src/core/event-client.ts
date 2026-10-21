import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeFileSync } from "node:fs";
import { eventAddress, eventDigest, eventSignal } from "./events.ts";
import { fail, id, object } from "./validation.ts";
import type { EventAddress, EventSignal } from "../events.ts";

interface CapabilityFile extends EventAddress { version: 1; capability: string }
export const eventSignalPath = "/api/events/signal";

/** The raw key goes directly to an exclusively created private file, never to the returned value. `created` is false when the file already named this wait. */
export function prepareEventCapability(path: string, input: { waitId?: string; revision: string }): EventAddress & { capabilityDigest: string; created: boolean } {
  const address = { waitId: input.waitId === undefined ? `wait-${randomUUID()}` : id(input.waitId, "Wait"), generation: randomUUID(), revision: id(input.revision, "Source revision") };
  const capability = randomBytes(32).toString("hex");
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readCapability(path);
    if (existing.revision !== address.revision || (input.waitId !== undefined && existing.waitId !== address.waitId)) fail("capability_conflict", "This private capability file already belongs to a different wait.", 409);
    return { waitId: existing.waitId, generation: existing.generation, revision: existing.revision, capabilityDigest: eventDigest(existing.capability), created: false };
  }
  try { writeFileSync(descriptor, `${JSON.stringify({ version: 1, ...address, capability })}\n`); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  return { ...address, capabilityDigest: eventDigest(capability), created: true };
}

function readCapability(path: string): CapabilityFile {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) fail("unsafe_capability", "Use a private regular event capability file owned by your user.");
    const bytes = Buffer.alloc(4097), size = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (size > 4096) fail("unsafe_capability", "The private capability file is too large.");
    let input: Record<string, unknown>;
    try { input = object(JSON.parse(bytes.subarray(0, size).toString("utf8"))); }
    catch { fail("invalid_capability", "The private event capability file is invalid."); }
    if (input.version !== 1 || typeof input.capability !== "string" || !/^[a-f0-9]{64}$/.test(input.capability) || Object.keys(input).some((key) => !["version", "waitId", "generation", "revision", "capability"].includes(key))) fail("invalid_capability", "Invalid event capability file.");
    return { version: 1, ...eventAddress(input), capability: input.capability };
  } finally { closeSync(descriptor); }
}

/** Existing job/dependency owners call this after observing their own completion. */
export async function signalEvent(options: { endpoint: string; capabilityFile: string; result: Omit<EventSignal, keyof EventAddress>; signal?: AbortSignal }): Promise<{ status: "recorded" | "duplicate"; receiptId: string }> {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") fail("invalid_endpoint", "Use the existing Seeker loopback base address.");
  const grant = readCapability(options.capabilityFile);
  const signal = eventSignal({ waitId: grant.waitId, generation: grant.generation, revision: grant.revision, ...options.result });
  const response = await fetch(new URL(eventSignalPath, endpoint), { method: "POST", headers: { Authorization: `Bearer ${grant.capability}`, "Content-Type": "application/json" }, body: JSON.stringify(signal), redirect: "error", signal: options.signal ?? AbortSignal.timeout(5000) });
  let body: Record<string, unknown>;
  try { body = object(await response.json()); }
  catch { fail("invalid_response", "The event signal response is unqualified. Retain the exact signal identity."); }
  if (!response.ok) fail(typeof body.error === "string" ? body.error : "event_signal_failed", "The event signal was not confirmed. Retain its identity and exact result; retry only that same signal.", response.status);
  if (!["recorded", "duplicate"].includes(String(body.status)) || typeof body.receiptId !== "string") fail("invalid_response", "Event signal receipt is unqualified. Retain the exact signal identity.");
  return { status: body.status as "recorded" | "duplicate", receiptId: id(body.receiptId, "Event receipt") };
}

/** Bounded ordinary producer data; never read an unbounded file or block on a FIFO. */
export function readEventResult(path: string): Omit<EventSignal, keyof EventAddress> {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 16_384) fail("too_large", "Use a regular event result file of at most 16 KiB.");
    const bytes = Buffer.alloc(16_385), size = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (size > 16_384) fail("too_large", "The event result file is too large.");
    let result: Record<string, unknown>;
    try { result = object(JSON.parse(bytes.subarray(0, size).toString("utf8"))); }
    catch { fail("invalid_event_result", "The event result file is not valid JSON."); }
    if (Object.keys(result).some((key) => !["eventId", "outcome", "summary", "evidenceRefs"].includes(key))) fail("unexpected_argument", "The result file contains unexpected arguments.");
    return result as unknown as Omit<EventSignal, keyof EventAddress>;
  } finally { closeSync(descriptor); }
}
