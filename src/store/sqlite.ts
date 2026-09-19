import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type {
  DeferredReply, Delivery, DeliveryResult, Exchange, ExchangeStore, ExchangeView, HistoryPage, InboundReply, IngestResult,
  ManagerBinding, ManagerCommand, ManagerOrigin, ReceiveProgress, Recipient,
} from "../contracts.ts";
import { create, deferInput, incorporate, mutate, reconcileInput, replyContentKey, type Change } from "../core/lifecycle.ts";
import { channelReadiness, routeFor } from "../core/attention.ts";
import { correlateBare, type BareCandidate } from "../core/correlation.ts";
import { binding as validateBinding, decision, fail, id, integer, limits, origin as validateOrigin, progress as validateProgress, reply as validateReply, sameOwner, sameRecipient, SeekerError } from "../core/validation.ts";

type Row = { data: string };
type InboundRecord = { fingerprint: string; result: IngestResult; event?: InboundReply; deferred?: DeferredReply };
type MessageInput = { contentKey: string; result: IngestResult };
const decode = <T>(row: Row): T => JSON.parse(row.data) as T;
const activeIds = "SELECT id FROM exchanges WHERE state IN ('waiting','answered','reconcile') UNION SELECT json_extract(data,'$.deferred.exchangeId') FROM inbound WHERE json_extract(data,'$.deferred.disposition.status')='pending'";
const activeExchange = `e.id IN (${activeIds})`;

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
      if (version < 0 || version > 6) fail("store_version", "This store needs a compatible Seeker version; it was not changed.");
      this.#db.transaction(() => {
        this.#db.run(`
          CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS exchanges (
            id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id),
            updated_at INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL
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
          CREATE TABLE IF NOT EXISTS dispositions (
            exchange_id TEXT NOT NULL REFERENCES exchanges(id), receipt_id TEXT NOT NULL,
            generation INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(receipt_id,generation)
          );
          CREATE INDEX IF NOT EXISTS dispositions_exchange ON dispositions(exchange_id,receipt_id,generation DESC);
          CREATE TABLE IF NOT EXISTS messages (
            channel_id TEXT NOT NULL, conversation_id TEXT NOT NULL, reference TEXT NOT NULL, handle TEXT NOT NULL, last_input TEXT,
            PRIMARY KEY(channel_id, conversation_id, reference)
          );
        `);
        if (version === 1) {
          this.#db.run("ALTER TABLE exchanges ADD COLUMN state TEXT NOT NULL DEFAULT 'waiting'");
          this.#db.run("UPDATE exchanges SET state=json_extract(data,'$.state')");
        }
        if (version === 1 || version === 2) this.#db.run("ALTER TABLE messages ADD COLUMN last_input TEXT");
        if (version > 0 && version < 5) {
          this.#db.run("DROP INDEX IF EXISTS delivery_notice");
          this.#db.run("UPDATE deliveries SET data=json_set(data,'$.ownerGeneration',(SELECT json_extract(e.data,'$.origin.generation') FROM exchanges e WHERE e.id=deliveries.exchange_id)) WHERE json_extract(data,'$.noticeOf') IS NOT NULL AND json_extract(data,'$.ownerGeneration') IS NULL");
        }
        this.#db.run("CREATE UNIQUE INDEX IF NOT EXISTS delivery_notice_owner ON deliveries(json_extract(data,'$.noticeOf'),json_extract(data,'$.ownerGeneration')) WHERE json_extract(data,'$.noticeOf') IS NOT NULL");
        this.#db.run("CREATE INDEX IF NOT EXISTS exchange_state ON exchanges(state,updated_at,id)");
        this.#db.run("CREATE INDEX IF NOT EXISTS exchange_history ON exchanges(json_extract(data,'$.createdAt') DESC,id)");
        this.#db.run("CREATE INDEX IF NOT EXISTS deferred_status ON inbound(json_extract(data,'$.deferred.disposition.status'),json_extract(data,'$.deferred.exchangeId'))");
        this.#db.run("CREATE INDEX IF NOT EXISTS inbox_history ON exchanges(json_extract(data,'$.recipient.channelId'),json_extract(data,'$.recipient.actorId'),json_extract(data,'$.recipient.conversationId'),json_extract(data,'$.createdAt') DESC,id)");
        this.#db.run("CREATE INDEX IF NOT EXISTS inbox_changes ON exchanges(json_extract(data,'$.recipient.channelId'),json_extract(data,'$.recipient.actorId'),json_extract(data,'$.recipient.conversationId'),updated_at)");
        this.#db.run("CREATE INDEX IF NOT EXISTS presented_question ON deliveries(exchange_id,json_extract(data,'$.revision'),json_extract(data,'$.acceptedAt')) WHERE state='accepted' AND json_extract(data,'$.lane')='channel' AND json_extract(data,'$.contextId') IS NULL");
        if (version > 0 && version < 6) {
          this.#db.run(`UPDATE exchanges SET state='reconcile', data=json_set(data,'$.pendingInputs',
            (SELECT count(*) FROM inbound WHERE json_extract(inbound.data,'$.deferred.exchangeId')=exchanges.id AND json_extract(inbound.data,'$.deferred.disposition.status')='pending'),
            '$.state','reconcile','$.version',json_extract(data,'$.version')+1)
            WHERE id IN (SELECT json_extract(data,'$.deferred.exchangeId') FROM inbound WHERE json_extract(data,'$.deferred.disposition.status')='pending')`);
        }
        this.#db.run("PRAGMA user_version = 6");
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

  setRecipient(bindingId: string, expectedGeneration: number, recipient: Recipient): void {
    this.#db.transaction(() => {
      const binding = this.#bindingById(id(bindingId, "Binding"));
      if (!binding || binding.origin.generation !== expectedGeneration) fail("owner_conflict", "Owner generation changed.", 409);
      const updated = validateBinding({ ...binding, recipient });
      this.#db.query("UPDATE bindings SET data=? WHERE id=?").run(JSON.stringify(updated), bindingId);
      // Existing exchanges keep their immutable recipient/correlation snapshots.
    }).immediate();
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
      const owned = this.#db.query<{ id: string }, [string]>("SELECT id FROM exchanges WHERE binding_id=?").all(bindingId);
      for (const { id: requestId } of owned) {
        const view = this.get(requestId)!;
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
        for (const deferred of view.deferredReplies ?? []) {
          if (deferred.disposition.status !== "pending") continue;
          deliveries.push({ id: randomUUID(), exchangeId: exchange.id, revision: deferred.revision, lane: "host", deferredChannelId: deferred.channelId, deferredEventId: deferred.event.eventId, state: "queued", attempts: 0, nextAt: exchange.updatedAt });
        }
        for (const pending of view.deliveries.filter((item) => item.lane === "host" && ["queued", "retry", "sending", "unknown"].includes(item.state))) {
          pending.state = ["sending", "unknown"].includes(pending.state) ? "unknown" : "retired";
          pending.code = "owner_transferred";
          this.#saveDelivery(pending);
        }
        this.#save({ exchange, deliveries, changed: true });
        for (const item of view.deliveries) this.#notifyChannelFailure(item, exchange.updatedAt);
      }
    }).immediate();
  }

  execute(origin: ManagerOrigin, command: ManagerCommand, now: number): ExchangeView {
    return this.#db.transaction(() => {
      if (!["submit", "revise", "context", "cancel", "acknowledge", "reconcile-input"].includes(command.type)) fail("invalid_input", "Unknown manager operation.");
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
        if (this.#activeCount() >= limits.exchanges) fail("capacity", "Active exchange capacity reached. Handle or cancel pending work; history was retained.", 503);
        const change = create({ ...binding, origin: validateOrigin(origin) }, command.requestId, snapshot, now);
        this.#save(change, true);
      } else {
        if (!existing) fail("not_found", "Exchange not found.", 404);
        if (command.type === "reconcile-input") {
          const row = this.#db.query<Row, [string, string]>("SELECT data FROM inbound WHERE channel_id=? AND event_id=?").get(command.channelId, command.eventId);
          const record = row ? decode<InboundRecord>(row) : undefined;
          if (!record?.deferred) fail("not_found", "Deferred input not found.", 404);
          const beforeVersion = existing.exchange.version;
          record.deferred = reconcileInput(existing.exchange, record.deferred, command, now);
          this.#db.query("UPDATE inbound SET data=? WHERE channel_id=? AND event_id=?").run(JSON.stringify(record), command.channelId, command.eventId);
          this.#save({ exchange: existing.exchange, deliveries: [], changed: existing.exchange.version !== beforeVersion });
        } else this.#save(mutate(existing.exchange, command, now));
      }
      return this.get(command.requestId)!;
    }).immediate();
  }

  get(requestId: string): ExchangeView | undefined {
    const row = this.#db.query<Row, [string]>("SELECT data FROM exchanges WHERE id=?").get(requestId);
    if (!row) return undefined;
    const exchange = decode<Exchange>(row);
    const statuses = this.#db.query<Row, [string]>("SELECT data FROM dispositions WHERE receipt_id=? ORDER BY generation DESC LIMIT 2");
    for (const receipt of exchange.receipts) {
      const known = statuses.all(receipt.id);
      if (known[0]) receipt.disposition = JSON.parse(known[0].data) as typeof receipt.disposition;
      if (known[1]) receipt.dispositionHistory = [JSON.parse(known[1].data) as typeof receipt.disposition];
    }
    return { exchange, deliveries: this.#db.query<Row, [string]>("SELECT data FROM deliveries WHERE exchange_id=? ORDER BY rowid").all(requestId).map(decode<Delivery>), deferredReplies: this.#deferred(requestId) };
  }

  list(filter: { bindingId?: string; recipient?: Recipient; pendingOnly?: boolean } = {}): ExchangeView[] {
    const { where, params } = this.#scope(filter);
    const rows = this.#db.query<{ id: string }, string[]>(`SELECT e.id FROM exchanges e WHERE ${where} AND ${activeExchange} ORDER BY e.updated_at DESC,e.id`).all(...params);
    if (!filter.pendingOnly) rows.push(...this.#db.query<{ id: string }, string[]>(`SELECT e.id FROM exchanges e WHERE ${where} AND NOT ${activeExchange} ORDER BY json_extract(e.data,'$.createdAt') DESC,e.id LIMIT 50`).all(...params));
    return rows.map((row) => this.get(row.id)!);
  }

  history(recipient: Recipient, cursor?: string): HistoryPage {
    const { where, params } = this.#scope({ recipient });
    let position: { created_at: number; id: string } | null = null;
    if (cursor) {
      position = this.#db.query<{ created_at: number; id: string }, string[]>(`SELECT json_extract(e.data,'$.createdAt') AS created_at,e.id FROM exchanges e WHERE ${where} AND e.id=?`).get(...params, id(cursor, "History cursor"));
      if (!position) fail("invalid_cursor", "History cursor is not in this inbox.", 400);
    }
    const rows = this.#db.query<{ id: string }, (string | number)[]>(`SELECT e.id FROM exchanges e WHERE ${where} AND NOT ${activeExchange}
      ${position ? "AND (json_extract(e.data,'$.createdAt')<? OR (json_extract(e.data,'$.createdAt')=? AND e.id>?))" : ""} ORDER BY json_extract(e.data,'$.createdAt') DESC,e.id LIMIT 51`).all(...params, ...(position ? [position.created_at, position.created_at, position.id] : []));
    const page = rows.slice(0, 50);
    return { items: page.map((row) => this.get(row.id)!), ...(rows.length > 50 ? { nextCursor: page[49]!.id } : {}) };
  }

  ingest(channelId: string, events: InboundReply[], progressInput: ReceiveProgress | undefined, now: number): IngestResult[] {
    id(channelId, "Channel");
    if (channelId.startsWith("native:")) fail("origin_denied", "Native receipt provenance belongs to the trusted host adapter.", 403);
    if (events.length > limits.batch) fail("too_large", "Inbound batch exceeds capacity.", 413);
    const normalized = events.map(validateReply);
    const progress = progressInput ? validateProgress(progressInput) : undefined;
    return this.#db.transaction(() => {
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
        const route = "json_extract(d.data,'$.lane') || ':' || CASE json_extract(d.data,'$.lane') WHEN 'channel' THEN json_extract(e.data,'$.recipient.channelId') ELSE json_extract(e.data,'$.origin.hostId') || ':' || e.binding_id || ':' || json_extract(e.data,'$.origin.generation') END";
        const row = this.#db.query<Row, (string | number)[]>(`SELECT d.data FROM deliveries d JOIN exchanges e ON e.id=d.exchange_id
          WHERE d.state IN ('queued','retry') AND d.next_at<=? ${excluded.length ? `AND (${route}) NOT IN (${excluded.map(() => "?").join(",")})` : ""}
          ORDER BY d.next_at,d.rowid LIMIT 1`).get(now, ...excluded);
        if (!row) break;
        const delivery = decode<Delivery>(row);
        const view = this.get(delivery.exchangeId)!;
        const exchange = view.exchange;
        const receipt = exchange.receipts.find((item) => item.id === delivery.receiptId);
        const deferred = view.deferredReplies?.find((item) => item.channelId === delivery.deferredChannelId && item.event.eventId === delivery.deferredEventId);
        const noticeTarget = view.deliveries.find((item) => item.id === delivery.noticeOf);
        const readiness = delivery.lane === "channel" ? channelReadiness(exchange, delivery) : "send";
        if (readiness === "defer") { delivery.nextAt = now + 1_000; this.#saveDelivery(delivery); continue; }
        const retired = delivery.lane === "channel" ? readiness === "retire" : delivery.noticeOf
          ? !noticeTarget || !["unknown", "rejected"].includes(noticeTarget.state) || channelReadiness(exchange, noticeTarget) === "retire" || delivery.ownerGeneration !== exchange.origin.generation
          : delivery.deferredEventId ? !deferred || deferred.disposition.status !== "pending" : !receipt || receipt.disposition.status !== "pending";
        if (retired) {
          delivery.state = "retired";
        } else {
          delivery.state = "sending";
          delivery.attemptId = randomUUID();
          delivery.attempts += 1;
          delivery.ownerGeneration = exchange.origin.generation;
          claimed.push(delivery);
          excluded.push(routeFor(exchange, delivery.lane));
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
      if (item.lane === "host" && item.ownerGeneration !== this.get(item.exchangeId)!.exchange.origin.generation) return;
      item.state = result.status;
      if (result.status === "accepted") {
        if (!result.reference || result.reference.length > 500) fail("invalid_adapter_result", "Adapter reference is invalid.");
        item.reference = result.reference;
        item.acceptedAt = now;
        delete item.code;
        if (item.lane === "channel") {
          const exchange = this.get(item.exchangeId)!.exchange;
          const revision = exchange.revisions[item.revision - 1]!;
          this.#correlate(exchange.recipient.channelId, exchange.recipient.conversationId, result.reference, revision.replyHandle);
        }
      } else {
        item.code = id(result.code, "Adapter result code");
        if (result.status === "retry") {
          integer(result.retryAfterMs, "Retry delay", 0);
          item.nextAt = now + Math.max(1_000, result.retryAfterMs);
          if (item.attempts >= 5) {
            item.state = "rejected";
            item.code = "retry_exhausted";
          }
        }
      }
      this.#saveDelivery(item);
      this.#notifyChannelFailure(item, now);
    }).immediate();
  }

  recoverInterruptedDeliveries(now = Date.now()): number {
    return this.#db.transaction(() => {
      const rows = this.#db.query<Row, []>("SELECT data FROM deliveries WHERE state='sending'").all();
      for (const row of rows) {
        const delivery = decode<Delivery>(row);
        delivery.state = "unknown";
        delivery.code = "receiver_restarted";
        this.#saveDelivery(delivery);
        this.#notifyChannelFailure(delivery, now);
      }
      return rows.length;
    }).immediate();
  }

  resumeRoute(lane: Delivery["lane"], adapterId: string, now: number): number {
    return this.#db.transaction(() => {
      const rows = this.#db.query<Row, [string, string, string]>(`SELECT d.data FROM deliveries d JOIN exchanges e ON e.id=d.exchange_id
        WHERE d.state='rejected' AND json_extract(d.data,'$.code')='retry_exhausted' AND json_extract(d.data,'$.lane')=?
        AND CASE ? WHEN 'host' THEN json_extract(e.data,'$.origin.hostId') ELSE json_extract(e.data,'$.recipient.channelId') END = ?
        AND (json_extract(d.data,'$.lane')='channel' OR json_extract(d.data,'$.ownerGeneration')=json_extract(e.data,'$.origin.generation'))`).all(lane, lane, adapterId);
      for (const row of rows) {
        const item = decode<Delivery>(row);
        item.state = "retry"; item.attempts = 0; item.nextAt = Math.max(now, item.nextAt);
        this.#saveDelivery(item);
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
    // Content admission cannot prevent a later receipt acknowledgment, cancellation,
    // or owner transfer. Their bounded metadata has an independent storage owner.
    const contentReceipts = exchange.receipts.map(({ disposition: _disposition, dispositionHistory: _history, ...receipt }) => receipt);
    const contentBytes = Buffer.byteLength(JSON.stringify({ revisions: exchange.revisions, context: exchange.context, receipts: contentReceipts }));
    if (contentBytes > limits.recordBytes) fail("capacity", "Exchange content capacity reached. Nothing was silently removed.", 503);
    const data = JSON.stringify({ ...exchange, receipts: contentReceipts.map((receipt) => ({ ...receipt, disposition: { status: "pending" } })) });
    if (insert) this.#db.query("INSERT INTO exchanges(id,binding_id,updated_at,state,data) VALUES (?,?,?,?,?)").run(exchange.id, exchange.bindingId, exchange.updatedAt, exchange.state, data);
    else this.#db.query("UPDATE exchanges SET updated_at=?,state=?,data=? WHERE id=?").run(exchange.updatedAt, exchange.state, data, exchange.id);
    for (const receipt of exchange.receipts) {
      for (const disposition of [...(receipt.dispositionHistory ?? []), receipt.disposition]) {
        this.#db.query("INSERT INTO dispositions(exchange_id,receipt_id,generation,data) VALUES (?,?,?,?) ON CONFLICT(receipt_id,generation) DO UPDATE SET data=excluded.data")
          .run(exchange.id, receipt.id, disposition.generation ?? exchange.origin.generation, JSON.stringify(disposition));
      }
    }
    for (const revision of exchange.revisions) {
      this.#db.query("INSERT INTO handles(handle,exchange_id,revision) VALUES (?,?,?) ON CONFLICT(handle) DO NOTHING").run(revision.replyHandle, exchange.id, revision.number);
    }
    if (change.retireChannel) {
      for (const item of this.get(exchange.id)!.deliveries.filter((item) => item.lane === "channel" && ["queued", "retry"].includes(item.state))) {
        item.state = "retired";
        this.#saveDelivery(item);
      }
    }
    for (const item of change.deliveries) this.#enqueue(item);
  }

  #saveDelivery(item: Delivery): void {
    this.#db.query("UPDATE deliveries SET state=?,next_at=?,data=? WHERE id=?").run(item.state, item.nextAt, JSON.stringify(item), item.id);
  }

  #enqueue(item: Delivery): void {
    this.#db.query("INSERT INTO deliveries(id,exchange_id,state,next_at,data) VALUES (?,?,?,?,?)").run(item.id, item.exchangeId, item.state, item.nextAt, JSON.stringify(item));
  }

  #notifyChannelFailure(item: Delivery, now: number): void {
    if (item.lane !== "channel" || !["unknown", "rejected"].includes(item.state)) return;
    const exchange = this.get(item.exchangeId)!.exchange;
    if (channelReadiness(exchange, item) === "retire") return;
    if (this.#db.query<{ id: string }, [string, number]>("SELECT id FROM deliveries WHERE json_extract(data,'$.noticeOf')=? AND json_extract(data,'$.ownerGeneration')=?").get(item.id, exchange.origin.generation)) return;
    this.#enqueue({ id: randomUUID(), exchangeId: item.exchangeId, revision: item.revision, lane: "host", noticeOf: item.id, ownerGeneration: exchange.origin.generation, state: "queued", attempts: 0, nextAt: now });
  }

  #activeCount(): number {
    return this.#db.query<{ count: number }, []>(`SELECT count(*) AS count FROM (${activeIds})`).get()!.count;
  }

  #scope(filter: { bindingId?: string; recipient?: Recipient }): { where: string; params: string[] } {
    const clauses: string[] = [], params: string[] = [];
    if (filter.bindingId) { clauses.push("e.binding_id=?"); params.push(filter.bindingId); }
    if (filter.recipient) {
      clauses.push("json_extract(e.data,'$.recipient.channelId')=? AND json_extract(e.data,'$.recipient.actorId')=? AND json_extract(e.data,'$.recipient.conversationId')=?");
      params.push(filter.recipient.channelId, filter.recipient.actorId, filter.recipient.conversationId);
    }
    return { where: clauses.join(" AND ") || "1", params };
  }

  #deferred(requestId: string): DeferredReply[] {
    const rows = this.#db.query<Row, [string]>("SELECT data FROM inbound WHERE json_extract(data,'$.deferred.exchangeId')=? AND json_extract(data,'$.deferred.disposition.status')='pending' ORDER BY rowid").all(requestId);
    rows.push(...this.#db.query<Row, [string]>("SELECT data FROM inbound WHERE json_extract(data,'$.deferred.exchangeId')=? AND json_extract(data,'$.deferred.disposition.status')='handled' ORDER BY rowid DESC LIMIT 50").all(requestId));
    return rows.map((row) => decode<InboundRecord>(row).deferred!);
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
      const record = decode<InboundRecord>(previous);
      if (record.fingerprint !== fingerprint) fail("event_conflict", "Source event identity was reused for different content.", 409);
      return record.result.status === "recorded" || record.result.status === "duplicate" ? { ...record.result, status: "duplicate" } : record.result;
    }
    let result: IngestResult;
    let deferred: DeferredReply | undefined;
    let target = native;
    try {
      if (!target) {
        const recipient = { channelId, actorId: event.actorId, conversationId: event.conversationId };
        const { where, params } = this.#scope({ recipient });
        const authorized = this.#bindings().some((item) => sameRecipient(item.recipient, recipient)) ||
          Boolean(this.#db.query<{ id: string }, string[]>(`SELECT e.id FROM exchanges e WHERE ${where} LIMIT 1`).get(...params));
        if (!authorized) fail("recipient_denied", "Reply actor or conversation is not enrolled.", 403);
        const handle = event.replyHandle ?? (event.replyToRef ? this.resolveMessage(channelId, event.conversationId, event.replyToRef) : undefined);
        if (handle) {
          const row = this.#db.query<{ exchange_id: string; revision: number }, [string]>("SELECT exchange_id,revision FROM handles WHERE handle=?").get(handle);
          if (!row) fail("unknown_handle", "Unknown reply handle.", 409);
          target = { exchange: this.get(row.exchange_id)!.exchange, revision: row.revision };
        } else if (event.replyHandle || event.replyToRef) {
          result = { eventId: event.eventId, status: "unmatched", code: "unknown_message" };
        } else {
          // Project only correlation metadata; do not hydrate every conversation for a bare reply.
          const candidates = this.#db.query<BareCandidate, string[]>(`SELECT e.id,json_extract(e.data,'$.revision') AS revision,
            json_extract(e.data,'$.revisions[' || (json_extract(e.data,'$.revision')-1) || '].createdAt') AS createdAt,
            (SELECT min(json_extract(d.data,'$.acceptedAt')) FROM deliveries d WHERE d.exchange_id=e.id AND d.state='accepted'
              AND json_extract(d.data,'$.lane')='channel' AND json_extract(d.data,'$.contextId') IS NULL
              AND json_extract(d.data,'$.revision')=json_extract(e.data,'$.revision')) AS presentedAt
            FROM exchanges e WHERE ${where} AND ${activeExchange}`).all(...params);
          // A later revision or closure must not make another formerly ambiguous
          // question appear unique. Retained presentation/change evidence is enough
          // to fail closed; two IDs suffice to detect any other changed context.
          const sourceEnd = (event.occurredAt ?? 0) + (event.occurredAtPrecisionMs ?? 1) - 1;
          const changed = event.occurredAt === undefined ? [] : this.#db.query<{ id: string }, (string | number)[]>(`SELECT e.id FROM exchanges e
            WHERE ${where} AND json_extract(e.data,'$.createdAt')<=? AND e.updated_at>?
            AND EXISTS(SELECT 1 FROM deliveries d WHERE d.exchange_id=e.id AND json_extract(d.data,'$.lane')='channel'
              AND json_extract(d.data,'$.contextId') IS NULL AND d.state IN ('sending','unknown','accepted')) LIMIT 2`).all(...params, sourceEnd, event.occurredAt);
          const match = correlateBare(candidates, event, changed.map((item) => item.id));
          if (match.candidate) target = { exchange: this.get(match.candidate.id)!.exchange, revision: match.candidate.revision };
          else result = { eventId: event.eventId, status: "unmatched", code: match.code };
        }
        if (target && !sameRecipient(target.exchange.recipient, { channelId, actorId: event.actorId, conversationId: event.conversationId })) {
          fail("recipient_denied", "Reply does not belong to this recipient.", 403);
        }
      }
      if (target) {
        const source = this.#db.query<{ last_input: string | null }, [string, string, string]>("SELECT last_input FROM messages WHERE channel_id=? AND conversation_id=? AND reference=?").get(channelId, event.conversationId, event.sourceRef);
        let previousInput: MessageInput | undefined = source?.last_input ? JSON.parse(source.last_input) as MessageInput : undefined;
        if (!previousInput) {
          const legacy = target.exchange.receipts.findLast((item) => item.source.channelId === channelId && item.source.actorId === event.actorId && item.source.conversationId === event.conversationId && item.source.reference === event.sourceRef);
          if (legacy) previousInput = { contentKey: replyContentKey({ actorId: legacy.source.actorId, text: legacy.text, conditions: legacy.conditions, optionId: legacy.optionId }), result: { eventId: legacy.source.eventId, status: "recorded", exchangeId: target.exchange.id, receiptId: legacy.id } };
        }
        if (event.kind === "correction" && previousInput?.contentKey === replyContentKey(event)) {
          result = { ...previousInput.result, eventId: event.eventId, status: previousInput.result.status === "deferred" ? "deferred" : "duplicate" };
        } else {
          const accepted = this.#db.transaction(() => {
          const wasClosed = ["handled", "cancelled"].includes(target!.exchange.state);
          const accepted = incorporate(target!.exchange, target!.revision, event, channelId, native ? "native" : "channel", now);
          if (wasClosed && !["handled", "cancelled"].includes(accepted.change.exchange.state) && this.#activeCount() >= limits.exchanges) fail("active_capacity", "The active inbox is full; this input was not acknowledged.", 503);
          this.#save(accepted.change);
          this.#correlate(channelId, event.conversationId, event.sourceRef, target!.exchange.revisions[target!.revision - 1]!.replyHandle);
          return accepted;
          })();
          result = { eventId: event.eventId, status: accepted.duplicate ? "duplicate" : "recorded", exchangeId: target.exchange.id, receiptId: accepted.receipt.id };
        }
      }
    } catch (error) {
      if (error instanceof SeekerError && error.code === "capacity" && target) {
        const count = this.#db.query<{ count: number }, []>("SELECT count(*) AS count FROM inbound WHERE json_extract(data,'$.deferred.disposition.status')='pending'").get()!.count;
        if (count >= limits.deferredInputs) fail("ingress_capacity", "The pending input queue is full; this batch was not acknowledged.", 503);
        // Reload after the rolled-back content admission; its working object may have changed.
        const persisted = this.get(target.exchange.id)!.exchange;
        this.#save(deferInput(persisted, now));
        deferred = { channelId, event, exchangeId: target.exchange.id, revision: target.revision, recordedAt: now, verification: native ? "native" : "channel", disposition: { status: "pending" } };
        result = { eventId: event.eventId, status: "deferred", exchangeId: target.exchange.id, code: "exchange_capacity" };
        this.#correlate(channelId, event.conversationId, event.sourceRef, target.exchange.revisions[target.revision - 1]!.replyHandle);
        this.#enqueue({ id: randomUUID(), exchangeId: target.exchange.id, revision: target.revision, lane: "host", deferredChannelId: channelId, deferredEventId: event.eventId, state: "queued", attempts: 0, nextAt: now });
      } else {
        if (!(error instanceof SeekerError) || error.status >= 500) throw error;
        result = { eventId: event.eventId, status: "rejected", code: error.code };
      }
    }
    if (result!.code === "recipient_denied") return result!;
    this.#db.query("INSERT INTO inbound(channel_id,event_id,data) VALUES (?,?,?)").run(channelId, event.eventId, JSON.stringify({ fingerprint, result: result!, ...(result!.status === "unmatched" ? { event } : {}), ...(deferred ? { deferred } : {}) }));
    if (["recorded", "duplicate", "deferred"].includes(result!.status)) {
      this.#db.query("UPDATE messages SET last_input=? WHERE channel_id=? AND conversation_id=? AND reference=?").run(JSON.stringify({ contentKey: replyContentKey(event), result: result! }), channelId, event.conversationId, event.sourceRef);
    }
    return result!;
  }
}
