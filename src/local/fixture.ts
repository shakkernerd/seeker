import type { Decision, HostAdapter, ManagerBinding, ReceiptEnvelope } from "../contracts.ts";
import { SeekerCore } from "../core/seeker.ts";
import { localRecipient } from "./channel.ts";

export const fixtureBinding: ManagerBinding = {
  id: "local-demo", label: "Local demo · controlled host fixture",
  origin: { hostId: "fixture", managerId: "sample-manager", assignmentId: "sample-work", generation: 1 },
  recipient: localRecipient,
};

export const fixtureDecision: Decision = {
  kind: "decision", title: "Choose a place for the sample notes",
  question: "May the demo keep its sample notes in this local Seeker data directory?",
  context: "This is a controlled conversation to try the inbox. Ask why, add a condition, or choose an option. It is not connected to a real agent manager.",
  target: "This machine · Seeker demo data directory", effect: "Record your sample choice in this demo exchange.",
  scope: "Only the sample notes in this demonstration. No repository or external service is changed.",
  conditions: "Your reply is retained until the demo handles it. It grants no permission to any real agent.",
  recommendation: "Keep the example local.",
  options: [
    { id: "local", label: "Keep it local", meaning: "Keep the sample notes in this local demo only.", kind: "approve" },
    { id: "skip", label: "Skip the sample", meaning: "Do not proceed with the sample notes.", kind: "decline" },
  ],
};

/** Deliberately labelled deterministic fixture, never a replacement manager. */
export class FixtureHost implements HostAdapter {
  readonly id = "fixture";
  constructor(private readonly core: SeekerCore) {}

  async deliver(binding: ManagerBinding, envelope: ReceiptEnvelope, signal: AbortSignal) {
    if (signal.aborted) return { status: "unknown" as const, code: "aborted" };
    const manager = this.core.manager(binding.origin);
    let view = manager.get(envelope.exchangeId);
    manager.update({ type: "acknowledge", requestId: envelope.exchangeId, receiptId: envelope.receipt.id,
      status: "received", evidenceRef: `fixture:${envelope.receipt.id}`, expectedVersion: view.exchange.version });
    view = manager.get(envelope.exchangeId);
    if (envelope.receipt.kind === "question" || envelope.receipt.text.trim().endsWith("?")) {
      manager.update({ type: "context", requestId: envelope.exchangeId, expectedVersion: view.exchange.version,
        messageId: `explain:${envelope.receipt.id}`,
        text: "The sample stays on this machine so you can try a complete conversation without connecting a bot or an agent. Your choice only changes this demonstration's receipt. A real manager supplies its own explanation in a connected exchange." });
      view = manager.get(envelope.exchangeId);
    }
    manager.update({ type: "acknowledge", requestId: envelope.exchangeId, receiptId: envelope.receipt.id,
      status: "handled", evidenceRef: `fixture:${envelope.receipt.id}`, note: "Handled by the controlled demo fixture; no external action occurred.", expectedVersion: view.exchange.version });
    return { status: "accepted" as const, reference: `fixture:${envelope.receipt.id}` };
  }
}

export function seedFixture(core: SeekerCore): void {
  core.bind(fixtureBinding);
  core.manager(fixtureBinding.origin).submit({ requestId: "sample-local-notes", decision: fixtureDecision });
}
