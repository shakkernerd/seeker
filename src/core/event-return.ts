import type { NativeReturnTarget } from "../contracts.ts";
import type { EventEnvelope, EventWait } from "../events.ts";
import type { SeekerCore } from "./seeker.ts";
import { sameOwner } from "./validation.ts";

export function eventReturnTarget(wait: EventWait): NativeReturnTarget {
  return { id: `event:${wait.waitId}`, origin: {
    hostId: wait.owner.hostId, managerId: wait.owner.taskId,
    assignmentId: wait.owner.bindingId ?? wait.owner.taskId,
    generation: wait.owner.ownerGeneration ?? 1,
    turnId: wait.owner.turnId, callId: wait.owner.callId,
  } };
}
export function eventEnvelope(wait: EventWait): EventEnvelope {
  if (!wait.delivery || !wait.receipt) throw new Error("An event return requires saved receipt and delivery identities.");
  return { deliveryId: wait.delivery.id, event: { waitId: wait.waitId, generation: wait.generation, revision: wait.revision, version: wait.version, receiptId: wait.receipt.id } };
}

/** Durable event authority; the native adapter additionally checks current task activity before grant. */
export function eventReturnCurrent(core: SeekerCore, target: NativeReturnTarget, envelope: EventEnvelope): boolean {
  try {
    const wait = core.store.events.current(envelope.event, envelope.deliveryId, envelope.event.version, core.clock());
    if (!wait || wait.receipt?.id !== envelope.event.receiptId) return false;
    const expected = eventReturnTarget(wait);
    if (target.id !== expected.id || !sameOwner(target.origin, expected.origin) || target.origin.turnId !== expected.origin.turnId || target.origin.callId !== expected.origin.callId) return false;
    if (wait.owner.bindingId) {
      const current = core.managerBinding(wait.owner.hostId, wait.owner.taskId);
      if (!current || current.id !== wait.owner.bindingId || current.origin.generation !== wait.owner.ownerGeneration) return false;
    }
    return true;
  } catch { return false; }
}
