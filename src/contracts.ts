/** Host-produced identity. Never construct this from model tool arguments. */
export interface ManagerOrigin {
  hostId: string;
  managerId: string;
  assignmentId: string;
  generation: number;
  turnId?: string;
  callId?: string;
}

export interface Recipient {
  channelId: string;
  actorId: string;
  conversationId: string;
}

/** Trusted setup fixes both ends of the route before an agent can submit. */
export interface ManagerBinding {
  id: string;
  label: string;
  origin: ManagerOrigin;
  recipient: Recipient;
}

export type ChoiceKind = "approve" | "decline" | "answer";
export interface Decision {
  kind: "decision" | "information" | "attention";
  title: string;
  question: string;
  context: string;
  target: string;
  effect: string;
  scope: string;
  conditions: string;
  recommendation?: string;
  options: { id: string; label: string; meaning: string; kind: ChoiceKind }[];
}

export interface Revision {
  number: number;
  decision: Decision;
  replyHandle: string;
  createdAt: number;
}

export type ReplyKind = ChoiceKind | "question" | "acknowledge" | "correction" | "stop";
export interface InboundReply {
  eventId: string;
  actorId: string;
  conversationId: string;
  sourceRef: string;
  occurredAt?: number;
  /** The source time denotes [occurredAt, occurredAt + precision); defaults to 1 ms. */
  occurredAtPrecisionMs?: number;
  /** Opaque revision handle, or a provider reference resolved by the store. */
  replyHandle?: string;
  replyToRef?: string;
  kind: ReplyKind;
  optionId?: string;
  text: string;
  conditions?: string;
}

export interface Receipt {
  id: string;
  sequence?: number;
  revision: number;
  kind: ReplyKind;
  text: string;
  conditions: string;
  optionId?: string;
  classification: "response" | "correction";
  source: {
    channelId: string;
    actorId: string;
    conversationId: string;
    eventId: string;
    reference: string;
    occurredAt?: number;
    occurredAtPrecisionMs?: number;
    recordedAt: number;
    verification: "channel" | "native";
  };
  disposition: {
    status: "pending" | "received" | "handled" | "unknown";
    generation?: number;
    evidenceRef?: string;
    note?: string;
    resolvesExchange?: boolean;
    updatedAt?: number;
  };
  dispositionHistory?: Receipt["disposition"][];
}

export interface ContextMessage {
  id: string;
  sequence?: number;
  revision: number;
  text: string;
  createdAt: number;
}

export interface Exchange {
  id: string;
  bindingId: string;
  managerLabel: string;
  origin: ManagerOrigin;
  recipient: Recipient;
  version: number;
  revision: number;
  state: "waiting" | "answered" | "reconcile" | "handled" | "cancelled";
  pendingInputs?: number;
  revisions: Revision[];
  context: ContextMessage[];
  receipts: Receipt[];
  createdAt: number;
  updatedAt: number;
  cancellation?: { reason: string; at: number };
}

export type DeliveryResult =
  | { status: "accepted"; reference: string }
  | { status: "retry"; retryAfterMs: number; code: string }
  | { status: "rejected"; code: string }
  | { status: "unknown"; code: string };

export interface Delivery {
  id: string;
  exchangeId: string;
  revision: number;
  lane: "channel" | "host";
  receiptId?: string;
  deferredChannelId?: string;
  deferredEventId?: string;
  ownerGeneration?: number;
  noticeOf?: string;
  contextId?: string;
  state: "queued" | "sending" | "accepted" | "retry" | "rejected" | "unknown" | "retired";
  attempts: number;
  nextAt: number;
  attemptId?: string;
  reference?: string;
  acceptedAt?: number;
  code?: string;
}

export interface ExchangeView {
  exchange: Exchange;
  deliveries: Delivery[];
  deferredReplies?: DeferredReply[];
}

export interface DeferredReply {
  channelId: string;
  event: InboundReply;
  exchangeId: string;
  revision: number;
  recordedAt: number;
  verification: "channel" | "native";
  disposition: { status: "pending" | "handled"; generation?: number; evidenceRef?: string; note?: string };
}

export interface HistoryPage { items: ExchangeView[]; nextCursor?: string }

export type ReadCollection = "receipts" | "deferred" | "context" | "revisions" | "deliveries";
export interface ReadOptions {
  collection?: ReadCollection;
  cursor?: string;
  /** Exact receipt/context/delivery ID, or revision number; a deferred event also needs channelId. */
  itemId?: string;
  channelId?: string;
}
export type ReadItem = Receipt | DeferredReply | ContextMessage | Revision | Delivery;
export interface ExchangeRead {
  exchange: Omit<Exchange, "revisions" | "context" | "receipts">;
  current: Revision;
  itemRevision?: Revision;
  counts: { revisions: number; context: number; receipts: number; pendingReceipts: number; deferred: number; pendingDeferred: number; deliveries: number };
  collection: ReadCollection;
  /** Complete records only: one item per page, never an excerpt of authority or conditions. */
  items: ReadItem[];
  nextCursor?: string;
}
export interface PendingSummary {
  id: string;
  title: string;
  kind: Decision["kind"];
  version: number;
  revision: number;
  state: Exchange["state"];
  pendingInputs: number;
  updatedAt: number;
}
export interface PendingPage { items: PendingSummary[]; total: number; nextCursor?: string }

export interface ChannelMessage {
  deliveryId: string;
  exchangeId: string;
  managerLabel: string;
  recipient: Recipient;
  revision: Revision;
  context?: ContextMessage;
}

/** A short I/O operation; never wait for a person inside send or deliver. */
export interface MessagingChannel {
  id: string;
  send(message: ChannelMessage, signal: AbortSignal): Promise<DeliveryResult>;
}

export interface ReceiptEnvelope {
  deliveryId: string;
  exchangeId: string;
  revision: Revision;
  receipt: Receipt;
  requiresReconciliation: boolean;
}

export interface DeferredEnvelope {
  deliveryId: string;
  exchangeId: string;
  revision: Revision;
  deferred: DeferredReply;
  requiresReconciliation: true;
}

export interface DeliveryNoticeEnvelope {
  deliveryId: string;
  exchangeId: string;
  revision: Revision;
  notice: { deliveryId: string; state: "unknown" | "rejected"; code: string };
  requiresReconciliation: true;
}

export type HostEnvelope = ReceiptEnvelope | DeferredEnvelope | DeliveryNoticeEnvelope;

export interface HostAdapter {
  id: string;
  deliver(binding: ManagerBinding, envelope: HostEnvelope, signal: AbortSignal): Promise<DeliveryResult>;
}

export type ManagerCommand =
  | { type: "submit"; requestId: string; decision: Decision }
  | { type: "revise"; requestId: string; expectedVersion: number; decision: Decision }
  | { type: "context"; requestId: string; expectedVersion: number; messageId: string; text: string }
  | { type: "cancel"; requestId: string; expectedVersion: number; reason: string }
  | { type: "reconcile-input"; requestId: string; expectedVersion: number; channelId: string; eventId: string; evidenceRef: string; note?: string }
  | {
      type: "acknowledge";
      requestId: string;
      receiptId: string;
      status: "received" | "handled" | "unknown";
      evidenceRef: string;
      note?: string;
      /** Explicit manager interpretation of a natural answer; never implied by handling context. */
      resolvesExchange?: boolean;
      /** Resolve only with the current version; pending corrections must be reconciled. */
      expectedVersion: number;
    };

export interface ManagerPort {
  submit(input: { requestId: string; decision: Decision }): ExchangeRead;
  get(requestId: string, options?: ReadOptions): ExchangeRead;
  listPending(options?: { cursor?: string }): PendingPage;
  update(command: Exclude<ManagerCommand, { type: "submit" }>): ExchangeRead;
}

export interface ReceiveProgress {
  /** Opaque adapter-owned position, committed with every event in this batch. */
  cursor?: string;
  lastReceivedAt: number;
  continuity: "continuous" | "possible-gap";
}

export interface IngestResult {
  eventId: string;
  status: "recorded" | "duplicate" | "rejected" | "unmatched" | "deferred";
  exchangeId?: string;
  receiptId?: string;
  code?: string;
}

export interface ChannelIngress {
  receive(events: InboundReply[], progress?: ReceiveProgress): IngestResult[];
  progress(): ReceiveProgress | undefined;
  pending(recipient: Recipient): ExchangeView[];
  resolveMessage(conversationId: string, reference: string): string | undefined;
}

/** Domain transactions: creation/outbox, reply/dedup/cursor and owner fencing are atomic. */
export interface ExchangeStore {
  bind(binding: ManagerBinding): void;
  setRecipient(bindingId: string, expectedGeneration: number, recipient: Recipient): void;
  binding(origin: ManagerOrigin): ManagerBinding;
  findBinding(hostId: string, managerId: string): ManagerBinding | undefined;
  transfer(bindingId: string, expectedGeneration: number, successor: ManagerOrigin): void;
  execute(origin: ManagerOrigin, command: ManagerCommand, now: number): void;
  get(requestId: string): ExchangeView | undefined;
  read(requestId: string, bindingId: string, options?: ReadOptions): ExchangeRead | undefined;
  pending(bindingId: string, cursor?: string): PendingPage;
  list(filter?: { bindingId?: string; recipient?: Recipient; pendingOnly?: boolean }): ExchangeView[];
  history(recipient: Recipient, cursor?: string): HistoryPage;
  ingest(channelId: string, events: InboundReply[], progress: ReceiveProgress | undefined, now: number): IngestResult[];
  ingestNative(origin: ManagerOrigin, requestId: string, revision: number, reply: InboundReply, now: number): IngestResult;
  progress(channelId: string): ReceiveProgress | undefined;
  resolveMessage(channelId: string, conversationId: string, reference: string): string | undefined;
  claimDeliveries(limit: number, now: number, excludedRoutes?: readonly string[]): Delivery[];
  completeDelivery(id: string, attemptId: string, result: DeliveryResult, now: number): void;
  recoverInterruptedDeliveries(now?: number): number;
  resumeRoute(lane: Delivery["lane"], adapterId: string, now: number): number;
  close(): void;
}
