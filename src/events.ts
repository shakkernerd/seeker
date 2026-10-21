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
export interface EventSignal extends EventAddress {
  eventId: string;
  outcome: "completed" | "released" | "failed";
  summary: string;
  evidenceRefs: string[];
}
export interface EventReceipt {
  id: string;
  /** Set only by the service when no producer result arrived before expiry. */
  source?: "deadline";
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
export type EventSummary = Pick<EventWait, "waitId" | "generation" | "revision" | "title" | "expiresAt" | "version" | "state" | "updatedAt" | "reason"> & { receiptId?: string };
export interface EventPort {
  arm(input: EventArm): EventWait;
  get(address: EventAddress): EventWait;
  pending(): EventSummary[];
  cancel(address: EventAddress, expectedVersion: number): EventWait;
  acknowledge(address: EventAddress, expectedVersion: number, receiptId: string, status: "received" | "handled" | "unknown"): EventWait;
  clear(address: EventAddress, expectedVersion: number): EventWait;
}
export interface EventStore {
  arm(owner: EventOwner, input: EventArm, now: number): EventWait;
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
