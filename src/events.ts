import type { DeliveryResult } from "./contracts.ts";

/** Supplied by a verified native invocation, never model arguments. */
export interface EventOwner {
  hostId: string;
  taskId: string;
  turnId: string;
  callId: string;
  /** Snapshot of a human-manager assignment, when this task has one. */
  bindingId?: string;
  ownerGeneration?: number;
}
export interface EventAddress { waitId: string; generation: string; revision: string }
/** How a task names one of its waits: the id alone, or the full address when it has it. */
export interface EventRef { waitId: string; generation?: string; revision?: string }
/** What a task supplies to arm a wait. Seeker prepares the producer key file itself, under its own home unless `capabilityFile` names the place. */
export interface EventArmRequest {
  title: string;
  expiresAt: number;
  capabilityFile?: string;
  revision?: string;
  waitId?: string;
}
export interface EventArm extends EventAddress {
  title: string;
  expiresAt: number;
  capabilityDigest: string;
  /** The name of a key file Seeker placed in its key directory; removed when the wait is cleared. A task-chosen file is the task's. */
  keyFile?: string;
}
/** The ways a task's turn can end; a watch reports the ones it was armed for. */
export type TurnEnding = "completed" | "failed" | "interrupted";
export const turnEndings: readonly TurnEnding[] = ["completed", "failed", "interrupted"];
/** What a task supplies to watch another task; the identity is chosen by Seeker unless given. */
export interface EventWatchRequest {
  title: string;
  expiresAt: number;
  threadId: string;
  on?: TurnEnding[];
  waitId?: string;
}
/** A watch on another native task; Seeker itself observes it, no producer signals it. */
export interface EventWatch extends EventAddress {
  title: string;
  expiresAt: number;
  threadId: string;
  on: TurnEnding[];
}
/** What a read of a watched task saw: its latest turn, whether it is running or how it ended, and when it ended if the host says. */
export interface ThreadObservation { turnId: string; status: TurnEnding | "inProgress"; completedAt?: number }
export interface EventSignal extends EventAddress {
  eventId: string;
  outcome: "completed" | "released" | "failed";
  summary: string;
  evidenceRefs: string[];
}
export interface EventReceipt {
  id: string;
  /** Set only by the service: a deadline passed without a producer result, or a watched task was observed. */
  source?: "deadline" | "watch";
  signal: EventSignal;
  recordedAt: number;
  disposition: "pending" | "received" | "handled" | "unknown";
  evidenceRef?: string;
}
export interface EventDelivery {
  id: string;
  state: "queued" | "sending" | "accepted" | "retry" | "rejected" | "unknown" | "retired";
  attempts: number;
  nextAt: number;
  attemptId?: string;
  authorizationVersion?: number;
  reference?: string;
  code?: string;
}
export interface EventWait extends EventAddress {
  /** Cleared tombstones retain only host/task identity. */
  owner: Pick<EventOwner, "hostId" | "taskId"> & Partial<Omit<EventOwner, "hostId" | "taskId">>;
  title?: string;
  expiresAt?: number;
  /** Present on a watch: the task whose latest turn Seeker observes for this wait, the endings it reports, and the latest turn a read saw. */
  watch?: { threadId: string; on?: TurnEnding[]; seen?: { turnId: string; status: TurnEnding | "inProgress" } };
  version: number;
  /**
   * `delivered`: the result reached the task. `handled`: the task said so itself. `paused` is a legacy
   * stored value from earlier releases; startup migrates it to a deliverable state.
   */
  state: "waiting" | "ready" | "paused" | "delivered" | "cancelled" | "expired" | "handled" | "cleared";
  createdAt?: number;
  updatedAt: number;
  reason?: string;
  receipt?: EventReceipt;
  delivery?: EventDelivery;
}
export interface StoredEventWait extends EventWait {
  capabilityDigest?: string;
  keyFile?: string;
  armFingerprint?: string;
  signalFingerprint?: string;
}
/** The bounded result a notice carries. Producer text is untrusted data; the full record stays in the store. */
export interface EventResult {
  title?: string;
  source?: EventReceipt["source"];
  outcome: EventSignal["outcome"];
  summary: string;
  evidenceRefs: string[];
}
/** Machine result identity and its bounded result. */
export interface EventEnvelope {
  deliveryId: string;
  event: EventAddress & { version: number; receiptId: string; result: EventResult };
}
export type EventSummary = Pick<EventWait, "waitId" | "generation" | "revision" | "title" | "expiresAt" | "version" | "state" | "updatedAt" | "reason" | "watch"> & { receiptId?: string; delivery?: Pick<EventDelivery, "state" | "code"> };
export interface EventMutation { expectedVersion?: number }
export interface EventPort {
  arm(input: EventArmRequest): EventWait & { capabilityFile: string };
  watch(input: EventWatchRequest): EventWait;
  get(ref: EventRef): EventWait;
  /** This task's open waits and watches: waiting, or with a result not yet delivered. */
  pending(): EventSummary[];
  cancel(ref: EventRef, options?: EventMutation): EventWait;
  acknowledge(ref: EventRef, status: "received" | "handled" | "unknown", options?: EventMutation & { receiptId?: string }): EventWait;
  clear(ref: EventRef, options?: EventMutation): EventWait;
}
export interface EventStore {
  /** The directory holding the key files Seeker placed; a cleared wait's `keyFile` is removed from it. */
  keyDirectory?: string;
  arm(owner: EventOwner, input: EventArm, now: number): EventWait;
  watch(owner: EventOwner, input: EventWatch, now: number): EventWait;
  /** Every unexpired watch still waiting for an observation. */
  watching(now: number): EventWait[];
  /** Takes one read of the watched task; records the first ending that happened after the watch was armed, of a kind it reports, as its result and queues delivery. */
  observe(address: EventRef, observation: ThreadObservation, now: number): EventWait | undefined;
  get(owner: Pick<EventOwner, "hostId" | "taskId">, ref: EventRef, now: number): EventWait;
  /** The owner's open waits: waiting, or ready with a result not yet delivered. */
  pending(owner: Pick<EventOwner, "hostId" | "taskId">, now: number): EventWait[];
  /** `expectedVersion` is optional: a task that has not read the wait may still cancel, acknowledge or clear it. */
  mutate(owner: EventOwner, ref: EventRef, expectedVersion: number | undefined, command: { type: "cancel" | "clear" } | { type: "acknowledge"; receiptId?: string; status: "received" | "handled" | "unknown" }, now: number): EventWait;
  signal(capability: string, input: EventSignal, now: number): { status: "recorded" | "duplicate"; receiptId: string };
  claim(limit: number, now: number, excludedRoutes: readonly string[]): EventWait[];
  complete(waitId: string, generation: string, attemptId: string, result: DeliveryResult, now: number): void;
  recover(now: number): number;
  resumeHost(hostId: string, now: number): number;
  current(address: EventAddress, deliveryId: string, version: number, now: number): EventWait | undefined;
}
