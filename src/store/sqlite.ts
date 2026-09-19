import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Delivery, DeliveryResult, Exchange, ExchangeStore, ExchangeView, InboundReply, IngestResult,
  ManagerBinding, ManagerCommand, ManagerOrigin, ReceiveProgress, Recipient,
} from "../contracts.ts";
import { create, incorporate, mutate, type Change } from "../core/lifecycle.ts";
import { binding as validateBinding, decision, fail, id, integer, limits, origin as validateOrigin, progress as validateProgress, reply as validateReply, sameOwner, sameRecipient, SeekerError } from "../core/validation.ts";

type Row = { data: string };
const decode = <T>(row: Row): T => JSON.parse(row.data) as T;

/** One connection owns this local store. Transactions contain no asynchronous I/O. */
export class SqliteExchangeStore implements ExchangeStore {
  readonly #db: Database;

  constructor(filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      closeSync(openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
    }
    this.#db = new Database(filename, { strict: true });
    try {
      // Exclusive connection ownership survives commits, without holding an open transaction.
      this.#db.run("PRAGMA busy_timeout = 0");
      this.#db.run("PRAGMA locking_mode = EXCLUSIVE");
      this.#db.run("PRAGMA journal_mode = WAL");
      this.#db.run("PRAGMA synchronous = FULL");
      this.#db.run("PRAGMA fullfsync = ON");
      this.#db.run("PRAGMA foreign_keys = ON");
      const version = this.#db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version !== 0 && version !== 1) fail("store_version", "This store needs a compatible Seeker version; it was not changed.");
      this.#db.transaction(() => {
        this.#db.run(`
          CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS exchanges (
            id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id),
            updated_at INTEGER NOT NULL, data TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS exchanges_by_binding ON exchanges(binding_id, updated_at);
          CREATE TABLE IF NOT EXISTS handles (
            handle TEXT PRIMARY KEY, exchange_id TEXT NOT NULL REFERENCES exchanges(id), revision INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS deliveries (
            id TEXT PRIMARY KEY, exchange_id TEXT NOT NULL REFERENCES exchanges(id),
            state TEXT NOT NULL, next_at INTEGER NOT NULL, data TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS delivery_queue ON deliveries(state, next_at);
          CREATE INDEX IF NOT EXISTS delivery_exchange ON deliveries(exchange_id);
          CREATE TABLE IF NOT EXISTS inbound (
            channel_id TEXT NOT NULL, event_id TEXT NOT NULL, data TEXT NOT NULL,
            PRIMARY KEY(channel_id, event_id)
          );
          CREATE TABLE IF NOT EXISTS receiver_progress (channel_id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS messages (
            channel_id TEXT NOT NULL, conversation_id TEXT NOT NULL, reference TEXT NOT NULL, handle TEXT NOT NULL,
            PRIMARY KEY(channel_id, conversation_id, reference)
          );
          PRAGMA user_version = 1;
        `);
      }).immediate();
    } catch (error) {
      this.#db.close();
      if (error instanceof Error && /locked/.test(error.message)) {
        fail("store_in_use", "Another Seeker process owns this store. Use that process or stop it before restarting.", 503);
      }
      throw error;
    }
  }

  bind(input: ManagerBinding): void {
    const value = validateBinding(input);
    this.#db.transaction(() => {
      const existing = this.#bindingById(value.id);
      if (existing) {
        if (!sameOwner(existing.origin, value.origin) || !sameRecipient(existing.recipient, value.recipient) || existing.label !== value.label) {
          fail("binding_conflict", "This binding already has an owner and recipient. Use an explicit trusted transfer.", 409);
        }
        return;
      }
      if (this.#bindings().some((item) => sameOwner(item.origin, value.origin))) fail("binding_conflict", "This manager origin already has a binding.", 409);
      if (this.#bindings().length >= 100) fail("capacity", "Manager binding capacity reached.", 503);
      this.#db.query("INSERT INTO bindings(id,data) VALUES (?,?)").run(value.id, JSON.stringify(value));
    }).immediate();
  }

  binding(input: ManagerOrigin): ManagerBinding {
    const origin = validateOrigin(input);
    const result = this.#bindings().find((item) => sameOwner(item.origin, origin));
    if (!result) fail("origin_denied", "The host has not bound this manager and owner generation.", 403);
    return result;
  }

  findBinding(hostId: string, managerId: string): ManagerBinding | undefined {
    id(hostId, "Host"); id(managerId, "Manager");
    const matches = this.#bindings().filter((item) => item.origin.hostId === hostId && item.origin.managerId === managerId);
    if (matches.length > 1) fail("binding_ambiguous", "This native manager has multiple assignment bindings; trusted setup must resolve the ambiguity.", 409);
    return matches[0];
  }

  transfer(bindingId: string, expectedGeneration: number, successorInput: ManagerOrigin): void {
    const successor = validateOrigin(successorInput);
    this.#db.transaction(() => {
      const current = this.#bindingById(bindingId);
      if (!current || current.origin.generation !== expectedGeneration) fail("owner_conflict", "Owner generation changed.", 409);
      if (successor.generation !== expectedGeneration + 1 || successor.assignmentId !== current.origin.assignmentId) {
        fail("owner_conflict", "A successor must retain the assignment and advance the owner generation once.", 409);
      }
      if (this.#bindings().some((item) => item.id !== bindingId && sameOwner(item.origin, successor))) fail("binding_conflict", "Successor already owns a different binding.", 409);
      current.origin = successor;
      this.#db.query("UPDATE bindings SET data=? WHERE id=?").run(JSON.stringify(current), bindingId);
      for (const view of this.list({ bindingId })) {
        const exchange = view.exchange;
        exchange.origin = successor;
        exchange.version += 1;
        exchange.updatedAt = Date.now();
        const deliveries: Delivery[] = [];
        for (const receipt of exchange.receipts) {
          if (receipt.disposition.status === "handled") continue;
          // Received is owner-specific; a successor must reconcile this same receipt.
          if (receipt.disposition.status !== "pending") (receipt.dispositionHistory ??= []).push(receipt.disposition);
          receipt.disposition = { status: "pending" };
          deliveries.push({ id: randomUUID(), exchangeId: exchange.id, revision: receipt.revision, lane: "host", receiptId: receipt.id, state: "queued", attempts: 0, nextAt: exchange.updatedAt });
        }
        for (const pending of view.deliveries.filter((item) => item.lane === "host" && ["queued", "retry", "sending"].includes(item.state))) {
          pending.state = pending.state === "sending" ? "unknown" : "retired";
          pending.code = "owner_transferred";
          this.#saveDelivery(pending);
        }
        this.#save({ exchange, deliveries, changed: true });
      }
    }).immediate();
  }

  execute(origin: ManagerOrigin, command: ManagerCommand, now: number): ExchangeView {
    return this.#db.transaction(() => {
      if (!["submit", "revise", "context", "cancel", "acknowledge"].includes(command.type)) fail("invalid_input", "Unknown manager operation.");
      const binding = this.binding(origin);
      id(command.requestId, "Request");
      const existing = this.get(command.requestId);
      if (existing && existing.exchange.bindingId !== binding.id) fail("origin_denied", "This exchange belongs to another manager.", 403);
      if (command.type === "submit") {
        const snapshot = decision(command.decision);
        if (existing) {
          if (JSON.stringify(existing.exchange.revisions[0]!.decision) !== JSON.stringify(snapshot)) {
            fail("idempotency_conflict", "This request identity already describes a different decision.", 409);
          }
          return existing;
        }
        const count = this.#db.query<{ count: number }, []>("SELECT count(*) AS count FROM exchanges").get()!.count;
        if (count >= limits.exchanges) fail("capacity", "Exchange capacity reached. Retained exchanges were not deleted.", 503);
        const change = create({ ...binding, origin: validateOrigin(origin) }, command.requestId, snapshot, now);
        this.#save(change, true);
      } else {
        if (!existing) fail("not_found", "Exchange not found.", 404);
        this.#save(mutate(existing.exchange, command, now));
      }
      return this.get(command.requestId)!;
    }).immediate();
  }

  get(requestId: string): ExchangeView | undefined {
    const row = this.#db.query<Row, [string]>("SELECT data FROM exchanges WHERE id=?").get(requestId);
    if (!row) return undefined;
    return { exchange: decode<Exchange>(row), deliveries: this.#db.query<Row, [string]>("SELECT data FROM deliveries WHERE exchange_id=? ORDER BY rowid").all(requestId).map(decode<Delivery>) };
  }

  list(filter: { bindingId?: string; recipient?: Recipient; pendingOnly?: boolean } = {}): ExchangeView[] {
    const rows = filter.bindingId
      ? this.#db.query<Row, [string]>("SELECT data FROM exchanges WHERE binding_id=? ORDER BY updated_at DESC,id").all(filter.bindingId)
      : this.#db.query<Row, []>("SELECT data FROM exchanges ORDER BY updated_at DESC,id").all();
    const exchanges = rows.map(decode<Exchange>).filter((exchange) =>
      (!filter.recipient || sameRecipient(exchange.recipient, filter.recipient)) &&
      (!filter.pendingOnly || !["handled", "cancelled"].includes(exchange.state)));
    const selected = new Set(exchanges.map((exchange) => exchange.id));
    const deliveries = new Map<string, Delivery[]>();
    for (const row of this.#db.query<Row, []>("SELECT data FROM deliveries ORDER BY rowid").all()) {
      const value = decode<Delivery>(row);
      if (selected.has(value.exchangeId)) {
        const group = deliveries.get(value.exchangeId) ?? [];
        group.push(value);
        deliveries.set(value.exchangeId, group);
      }
    }
    return exchanges.map((exchange) => ({ exchange, deliveries: deliveries.get(exchange.id) ?? [] }));
  }

  ingest(channelId: string, events: InboundReply[], progressInput: ReceiveProgress | undefined, now: number): IngestResult[] {
    id(channelId, "Channel");
    if (channelId.startsWith("native:")) fail("origin_denied", "Native receipt provenance belongs to the trusted host adapter.", 403);
    if (events.length > limits.batch) fail("too_large", "Inbound batch exceeds capacity.", 413);
    const normalized = events.map(validateReply);
    const progress = progressInput ? validateProgress(progressInput) : undefined;
    return this.#db.transaction(() => {
      this.#checkInboundCapacity(normalized.length);
      const outcomes = normalized.map((event) => this.#ingestOne(channelId, event, now));
      if (progress) {
        const previous = this.progress(channelId);
        if (previous?.continuity === "possible-gap") progress.continuity = "possible-gap";
        if (previous && progress.lastReceivedAt < previous.lastReceivedAt) fail("receiver_conflict", "Receive time moved backwards.", 409);
        this.#db.query("INSERT INTO receiver_progress(channel_id,data) VALUES (?,?) ON CONFLICT(channel_id) DO UPDATE SET data=excluded.data").run(channelId, JSON.stringify(progress));
      }
      return outcomes;
    }).immediate();
  }

  ingestNative(origin: ManagerOrigin, requestId: string, revision: number, input: InboundReply, now: number): IngestResult {
    const event = validateReply(input);
    integer(revision, "Revision");
    return this.#db.transaction(() => {
      const binding = this.binding(origin);
      const view = this.get(requestId);
      if (!view || view.exchange.bindingId !== binding.id) fail("origin_denied", "Native response does not belong to this manager binding.", 403);
      this.#checkInboundCapacity(1);
      return this.#ingestOne(`native:${origin.hostId}`, event, now, { exchange: view.exchange, revision });
    }).immediate();
  }

  progress(channelId: string): ReceiveProgress | undefined {
    const row = this.#db.query<Row, [string]>("SELECT data FROM receiver_progress WHERE channel_id=?").get(channelId);
    return row ? decode<ReceiveProgress>(row) : undefined;
  }

  resolveMessage(channelId: string, conversationId: string, reference: string): string | undefined {
    return this.#db.query<{ handle: string }, [string, string, string]>("SELECT handle FROM messages WHERE channel_id=? AND conversation_id=? AND reference=?").get(channelId, conversationId, reference)?.handle;
  }

  claimDeliveries(limit: number, now: number, excludedRoutes: readonly string[] = []): Delivery[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) fail("invalid_input", "Delivery concurrency must be 1–8.");
    return this.#db.transaction(() => {
      const excluded = [...excludedRoutes];
      const claimed: Delivery[] = [];
      while (claimed.length < limit) {
        const route = "json_extract(d.data,'$.lane') || ':' || CASE json_extract(d.data,'$.lane') WHEN 'channel' THEN json_extract(e.data,'$.recipient.channelId') ELSE json_extract(e.data,'$.origin.hostId') END";
        const row = this.#db.query<Row, (string | number)[]>(`SELECT d.data FROM deliveries d JOIN exchanges e ON e.id=d.exchange_id
          WHERE d.state IN ('queued','retry') AND d.next_at<=? ${excluded.length ? `AND (${route}) NOT IN (${excluded.map(() => "?").join(",")})` : ""}
          ORDER BY d.next_at,d.rowid LIMIT 1`).get(now, ...excluded);
        if (!row) break;
        const delivery = decode<Delivery>(row);
        const exchange = this.get(delivery.exchangeId)!.exchange;
        const receipt = exchange.receipts.find((item) => item.id === delivery.receiptId);
        const retired = delivery.lane === "channel"
          ? exchange.cancellation || delivery.revision !== exchange.revision || (!delivery.contextId && exchange.state !== "waiting")
          : !receipt || receipt.disposition.status !== "pending";
        if (retired) {
          delivery.state = "retired";
        } else {
          delivery.state = "sending";
          delivery.attemptId = randomUUID();
          delivery.attempts += 1;
          claimed.push(delivery);
          excluded.push(`${delivery.lane}:${delivery.lane === "channel" ? exchange.recipient.channelId : exchange.origin.hostId}`);
        }
        this.#saveDelivery(delivery);
      }
      return claimed;
    }).immediate();
  }

  completeDelivery(deliveryId: string, attemptId: string, result: DeliveryResult, now: number): void {
    this.#db.transaction(() => {
      const row = this.#db.query<Row, [string]>("SELECT data FROM deliveries WHERE id=?").get(deliveryId);
      if (!row) fail("not_found", "Delivery attempt not found.", 404);
      const item = decode<Delivery>(row);
      if (item.attemptId !== attemptId || (item.state !== "sending" && !(item.state === "unknown" && item.code === "io_timeout" && result.status === "accepted"))) return;
      item.state = result.status;
      if (result.status === "accepted") {
        if (!result.reference || result.reference.length > 500) fail("invalid_adapter_result", "Adapter reference is invalid.");
        item.reference = result.reference;
        if (item.lane === "channel") {
          const exchange = this.get(item.exchangeId)!.exchange;
          const revision = exchange.revisions[item.revision - 1]!;
          this.#correlate(exchange.recipient.channelId, exchange.recipient.conversationId, result.reference, revision.replyHandle);
        }
      } else {
        item.code = id(result.code, "Adapter result code");
        if (result.status === "retry") {
          integer(result.retryAfterMs, "Retry delay", 0);
          if (item.attempts >= 5) {
            item.state = "rejected";
            item.code = "retry_exhausted";
          } else item.nextAt = now + Math.max(1_000, result.retryAfterMs);
        }
      }
      this.#saveDelivery(item);
    }).immediate();
  }

  recoverInterruptedDeliveries(): number {
    return this.#db.transaction(() => {
      const rows = this.#db.query<Row, []>("SELECT data FROM deliveries WHERE state='sending'").all();
      for (const row of rows) {
        const delivery = decode<Delivery>(row);
        delivery.state = "unknown";
        delivery.code = "receiver_restarted";
        this.#saveDelivery(delivery);
      }
      return rows.length;
    }).immediate();
  }

  close(): void { this.#db.close(); }

  #bindings(): ManagerBinding[] {
    return this.#db.query<Row, []>("SELECT data FROM bindings").all().map(decode<ManagerBinding>);
  }

  #bindingById(bindingId: string): ManagerBinding | undefined {
    const row = this.#db.query<Row, [string]>("SELECT data FROM bindings WHERE id=?").get(bindingId);
    return row ? decode<ManagerBinding>(row) : undefined;
  }

  #save(change: Change, insert = false): void {
    if (!change.changed) return;
    const exchange = change.exchange;
    const data = JSON.stringify(exchange);
    if (Buffer.byteLength(data) > limits.recordBytes) fail("capacity", "Exchange storage capacity reached. Nothing was silently removed.", 503);
    if (insert) this.#db.query("INSERT INTO exchanges(id,binding_id,updated_at,data) VALUES (?,?,?,?)").run(exchange.id, exchange.bindingId, exchange.updatedAt, data);
    else this.#db.query("UPDATE exchanges SET updated_at=?,data=? WHERE id=?").run(exchange.updatedAt, data, exchange.id);
    for (const revision of exchange.revisions) {
      this.#db.query("INSERT INTO handles(handle,exchange_id,revision) VALUES (?,?,?) ON CONFLICT(handle) DO NOTHING").run(revision.replyHandle, exchange.id, revision.number);
    }
    if (change.retireChannel) {
      for (const item of this.get(exchange.id)!.deliveries.filter((item) => item.lane === "channel" && ["queued", "retry"].includes(item.state))) {
        item.state = "retired";
        this.#saveDelivery(item);
      }
    }
    for (const item of change.deliveries) {
      this.#db.query("INSERT INTO deliveries(id,exchange_id,state,next_at,data) VALUES (?,?,?,?,?)").run(item.id, item.exchangeId, item.state, item.nextAt, JSON.stringify(item));
    }
  }

  #saveDelivery(item: Delivery): void {
    this.#db.query("UPDATE deliveries SET state=?,next_at=?,data=? WHERE id=?").run(item.state, item.nextAt, JSON.stringify(item), item.id);
  }

  #checkInboundCapacity(additional: number): void {
    const count = this.#db.query<{ count: number }, []>("SELECT count(*) AS count FROM inbound").get()!.count;
    if (count + additional > limits.inboundEvents) fail("capacity", "Ingress capacity reached; this batch was not acknowledged.", 503);
  }

  #correlate(channelId: string, conversationId: string, reference: string, handle: string): void {
    const previous = this.resolveMessage(channelId, conversationId, reference);
    if (previous && previous !== handle) fail("message_conflict", "A provider message reference cannot move to another decision.", 503);
    this.#db.query("INSERT INTO messages(channel_id,conversation_id,reference,handle) VALUES (?,?,?,?) ON CONFLICT(channel_id,conversation_id,reference) DO NOTHING").run(channelId, conversationId, reference, handle);
  }

  #ingestOne(channelId: string, event: InboundReply, now: number, native?: { exchange: Exchange; revision: number }): IngestResult {
    const previous = this.#db.query<Row, [string, string]>("SELECT data FROM inbound WHERE channel_id=? AND event_id=?").get(channelId, event.eventId);
    const fingerprint = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    if (previous) {
      const record = decode<{ fingerprint: string; result: IngestResult }>(previous);
      if (record.fingerprint !== fingerprint) fail("event_conflict", "Source event identity was reused for different content.", 409);
      return record.result.status === "recorded" || record.result.status === "duplicate" ? { ...record.result, status: "duplicate" } : record.result;
    }
    let result: IngestResult;
    try {
      let target = native;
      if (!target) {
        const authorized = this.#bindings().some((item) => sameRecipient(item.recipient, { channelId, actorId: event.actorId, conversationId: event.conversationId }));
        if (!authorized) fail("recipient_denied", "Reply actor or conversation is not enrolled.", 403);
        const handle = event.replyHandle ?? (event.replyToRef ? this.resolveMessage(channelId, event.conversationId, event.replyToRef) : undefined);
        if (handle) {
          const row = this.#db.query<{ exchange_id: string; revision: number }, [string]>("SELECT exchange_id,revision FROM handles WHERE handle=?").get(handle);
          if (!row) fail("unknown_handle", "Unknown reply handle.", 409);
          target = { exchange: this.get(row.exchange_id)!.exchange, revision: row.revision };
        } else if (event.replyHandle || event.replyToRef) {
          result = { eventId: event.eventId, status: "unmatched", code: "unknown_message" };
        } else {
          const candidates = this.list({ recipient: { channelId, actorId: event.actorId, conversationId: event.conversationId }, pendingOnly: true });
          if (candidates.length === 1) target = { exchange: candidates[0]!.exchange, revision: candidates[0]!.exchange.revision };
          else result = { eventId: event.eventId, status: "unmatched", code: candidates.length ? "ambiguous" : "no_pending_exchange" };
        }
        if (target && !sameRecipient(target.exchange.recipient, { channelId, actorId: event.actorId, conversationId: event.conversationId })) {
          fail("recipient_denied", "Reply does not belong to this recipient.", 403);
        }
      }
      if (target) {
        const accepted = incorporate(target.exchange, target.revision, event, channelId, native ? "native" : "channel", now);
        this.#save(accepted.change);
        this.#correlate(channelId, event.conversationId, event.sourceRef, target.exchange.revisions[target.revision - 1]!.replyHandle);
        result = { eventId: event.eventId, status: accepted.duplicate ? "duplicate" : "recorded", exchangeId: target.exchange.id, receiptId: accepted.receipt.id };
      }
    } catch (error) {
      if (!(error instanceof SeekerError) || error.status >= 500) throw error;
      result = { eventId: event.eventId, status: "rejected", code: error.code };
    }
    this.#db.query("INSERT INTO inbound(channel_id,event_id,data) VALUES (?,?,?)").run(channelId, event.eventId, JSON.stringify({ fingerprint, result: result!, ...(result!.status === "unmatched" ? { event } : {}) }));
    return result!;
  }
}
