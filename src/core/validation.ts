import type { Decision, InboundReply, ManagerBinding, ManagerOrigin, ReceiveProgress } from "../contracts.ts";

export class SeekerError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = "SeekerError";
  }
}

export const limits = {
  exchanges: 1_000,
  revisions: 32,
  receipts: 128,
  context: 128,
  deferredInputs: 1_000,
  batch: 100,
  recordBytes: 262_144,
} as const;

export function fail(code: string, message: string, status = 400): never {
  throw new SeekerError(code, message, status);
}

export function text(value: unknown, name: string, max = 8_000, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || value.includes("\0")) {
    fail("invalid_input", `${name} must be ${empty ? "at most" : "1–"}${max} characters.`);
  }
  return value;
}

export function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    fail("invalid_input", `${name} must be a short stable identifier.`);
  }
  return value;
}

export function integer(value: unknown, name: string, min = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail("invalid_input", `${name} is invalid.`);
  return value as number;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_input", "Expected an object.");
  return value as Record<string, unknown>;
}

export function decision(value: unknown): Decision {
  const input = object(value);
  if (!["decision", "information", "attention"].includes(input.kind as string)) fail("invalid_input", "Unknown request kind.");
  if (!Array.isArray(input.options) || input.options.length > 6) fail("invalid_input", "Use at most six choices.");
  const result: Decision = {
    kind: input.kind as Decision["kind"],
    title: text(input.title, "Title", 160),
    question: text(input.question, "Question", 2_000),
    context: text(input.context, "Context", 4_000, true),
    target: text(input.target, "Target", 1_000, input.kind !== "decision"),
    effect: text(input.effect, "Effect", 2_000, input.kind !== "decision"),
    scope: text(input.scope, "Scope", 2_000, input.kind !== "decision"),
    conditions: text(input.conditions, "Conditions", 2_000, true),
    options: input.options.map((raw) => {
      const option = object(raw);
      const optionId = id(option.id, "Choice identifier");
      if (optionId.length > 24) fail("invalid_input", "Choice identifiers must fit channel reply handles.");
      if (!["approve", "decline", "answer"].includes(option.kind as string)) fail("invalid_input", "Unknown choice kind.");
      return {
        id: optionId,
        label: text(option.label, "Choice label", 80),
        meaning: text(option.meaning, "Choice meaning", 1_000),
        kind: option.kind as Decision["options"][number]["kind"],
      };
    }),
  };
  if (input.recommendation !== undefined) result.recommendation = text(input.recommendation, "Recommendation", 1_000, true);
  if (new Set(result.options.map((option) => option.id)).size !== result.options.length) fail("invalid_input", "Choice identifiers must be unique.");
  if (Buffer.byteLength(JSON.stringify(result)) > 16_384) fail("too_large", "The complete decision must fit in 16 KiB; shorten it without omitting material conditions.", 413);
  return result;
}

export function origin(value: ManagerOrigin): ManagerOrigin {
  return {
    hostId: id(value.hostId, "Host"),
    managerId: id(value.managerId, "Manager"),
    assignmentId: id(value.assignmentId, "Assignment"),
    generation: integer(value.generation, "Owner generation"),
    ...(value.turnId === undefined ? {} : { turnId: id(value.turnId, "Turn") }),
    ...(value.callId === undefined ? {} : { callId: id(value.callId, "Call") }),
  };
}

export function binding(value: ManagerBinding): ManagerBinding {
  return {
    id: id(value.id, "Binding"),
    label: text(value.label, "Manager label", 160),
    origin: origin(value.origin),
    recipient: {
      channelId: id(value.recipient.channelId, "Channel"),
      actorId: id(value.recipient.actorId, "Actor"),
      conversationId: id(value.recipient.conversationId, "Conversation"),
    },
  };
}

export function reply(value: InboundReply): InboundReply {
  if (!["approve", "decline", "answer", "question", "acknowledge", "correction", "stop"].includes(value.kind)) fail("invalid_input", "Unknown reply kind.");
  const result: InboundReply = {
    eventId: id(value.eventId, "Event"),
    actorId: id(value.actorId, "Actor"),
    conversationId: id(value.conversationId, "Conversation"),
    sourceRef: text(value.sourceRef, "Source reference", 500),
    kind: value.kind,
    text: text(value.text, "Reply", 8_000, value.optionId !== undefined || value.kind === "acknowledge"),
  };
  if (value.conditions !== undefined) result.conditions = text(value.conditions, "Conditions", 2_000, true);
  if (value.replyHandle !== undefined) result.replyHandle = id(value.replyHandle, "Reply handle");
  if (value.replyToRef !== undefined) result.replyToRef = text(value.replyToRef, "Replied message", 500);
  if (value.optionId !== undefined) result.optionId = id(value.optionId, "Choice");
  if (value.occurredAt !== undefined) result.occurredAt = integer(value.occurredAt, "Source time", 0);
  return result;
}

export function progress(value: ReceiveProgress): ReceiveProgress {
  if (!["continuous", "possible-gap"].includes(value.continuity)) fail("invalid_input", "Unknown receiver continuity.");
  return {
    ...(value.cursor === undefined ? {} : { cursor: text(value.cursor, "Receiver cursor", 256) }),
    lastReceivedAt: integer(value.lastReceivedAt, "Receive time", 0),
    continuity: value.continuity,
  };
}

export function sameOwner(a: ManagerOrigin, b: ManagerOrigin): boolean {
  return a.hostId === b.hostId && a.managerId === b.managerId && a.assignmentId === b.assignmentId && a.generation === b.generation;
}

export function sameRecipient(a: ManagerBinding["recipient"], b: ManagerBinding["recipient"]): boolean {
  return a.channelId === b.channelId && a.actorId === b.actorId && a.conversationId === b.conversationId;
}
