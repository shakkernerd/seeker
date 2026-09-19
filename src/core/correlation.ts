import type { InboundReply } from "../contracts.ts";

export interface BareCandidate {
  id: string;
  revision: number;
  createdAt: number;
  presentedAt: number | null;
}

/** Bare text has no immutable handle: require one temporally eligible current question. */
export function correlateBare(candidates: BareCandidate[], input: InboundReply, changedContexts: readonly string[] = []): { candidate?: BareCandidate; code?: string } {
  if (!candidates.length) return { code: "no_pending_exchange" };
  if (input.occurredAt === undefined) return { code: "source_time_required" };
  const latestPossibleTime = input.occurredAt + (input.occurredAtPrecisionMs ?? 1) - 1;
  const possible = candidates.filter((candidate) => candidate.createdAt <= latestPossibleTime);
  if (!possible.length) return { code: "predates_current_revision" };
  if (possible.length !== 1) return { code: "ambiguous" };
  const candidate = possible[0]!;
  if (changedContexts.some((requestId) => requestId !== candidate.id)) return { code: "context_changed_since_reply" };
  if (candidate.createdAt > input.occurredAt) return { code: "uncertain_chronology" };
  if (candidate.presentedAt === null) return { code: "question_not_presented" };
  if (candidate.presentedAt > latestPossibleTime) return { code: "predates_presentation" };
  if (candidate.presentedAt > input.occurredAt) return { code: "uncertain_chronology" };
  return { candidate };
}
