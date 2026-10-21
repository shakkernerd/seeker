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
export interface EventArm extends EventAddress {
  title: string;
  expiresAt: number;
  capabilityDigest: string;
}
/** A watch on another native task; Seeker itself observes it, no producer signals it. */
export interface EventWatch extends EventAddress {
  title: string;
  expiresAt: number;
  threadId: string;
}
export interface ThreadObservation { turnId: string; status: "failed" | "interrupted" }
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
  /** Present on a watch: the task whose latest turn Seeker observes for this wait. */
  watch?: { threadId: string };
  version: number;
  /** `paused` is a legacy stored value from earlier releases; startup migrates it to a deliverable state. */
  state: "waiting" | "ready" | "paused" | "cancelled" | "expired" | "handled" | "cleared";
  createdAt?: number;
  updatedAt: number;
  reason?: string;
  receipt?: EventReceipt;
  delivery?: EventDelivery;
}
export interface StoredEventWait extends EventWait {
  capabilityDigest?: string;
  armFingerprint?: string;
  signalFingerprint?: string;
}
/** Machine result identity only. Producer text is retrieved separately as untrusted data. */
export interface EventEnvelope {
  deliveryId: string;
  event: EventAddress & { version: number; receiptId: string };
}
export type EventSummary = Pick<EventWait, "waitId" | "generation" | "revision" | "title" | "expiresAt" | "version" | "state" | "updatedAt" | "reason" | "watch"> & { receiptId?: string };
export interface EventPort {
  arm(input: EventArm): EventWait;
  watch(input: EventWatch): EventWait;
  get(address: EventAddress): EventWait;
  pending(): EventSummary[];
  cancel(address: EventAddress, expectedVersion: number): EventWait;
  acknowledge(address: EventAddress, expectedVersion: number, receiptId: string, status: "received" | "handled" | "unknown"): EventWait;
  clear(address: EventAddress, expectedVersion: number): EventWait;
}
export interface EventStore {
  arm(owner: EventOwner, input: EventArm, now: number): EventWait;
  watch(owner: EventOwner, input: EventWatch, now: number): EventWait;
  /** Unexpired watches still waiting for an observation. */
  watching(now: number, limit: number): EventWait[];
  /** Records one observed failed or interrupted turn as the watch's result and queues its delivery. */
  observe(address: EventAddress, observation: ThreadObservation, now: number): EventWait | undefined;
  get(owner: Pick<EventOwner, "hostId" | "taskId">, address: EventAddress, now: number): EventWait;
  pending(owner: Pick<EventOwner, "hostId" | "taskId">, now: number): EventWait[];
  mutate(owner: EventOwner, address: EventAddress, expectedVersion: number, command: { type: "cancel" | "clear" } | { type: "acknowledge"; receiptId: string; status: "received" | "handled" | "unknown" }, now: number): EventWait;
  signal(capability: string, input: EventSignal, now: number): { status: "recorded" | "duplicate"; receiptId: string };
  claim(limit: number, now: number, excludedRoutes: readonly string[]): EventWait[];
  complete(waitId: string, generation: string, attemptId: string, result: DeliveryResult, now: number): void;
  recover(now: number): number;
  resumeHost(hostId: string, now: number): number;
  current(address: EventAddress, deliveryId: string, version: number, now: number): EventWait | undefined;
}
