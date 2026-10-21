import type { Database } from "bun:sqlite";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DeliveryResult } from "../contracts.ts";
import type { EventAddress, EventArm, EventOwner, EventSignal, EventStore, EventWait, EventWatch, StoredEventWait, ThreadObservation } from "../events.ts";
import { eventAddress, eventArm, eventDigest, eventFingerprint, eventLimits, eventOwner, eventPublic, eventRoute, eventSignal, eventWatch, sameEventOwner, threadObservation } from "../core/events.ts";
import { fail, id, integer } from "../core/validation.ts";

type Row = { data: string };
const decode = (row: Row): StoredEventWait => JSON.parse(row.data) as StoredEventWait;
const terminal = (wait: EventWait) => ["cancelled", "expired", "handled", "cleared"].includes(wait.state);

/** Shares its owning SqliteExchangeStore connection; never opens a competing writer. */
export class SqliteEventStore implements EventStore {
  constructor(private readonly db: Database) {}

  arm(rawOwner: EventOwner, raw: EventArm, now: number): EventWait {
    const owner = eventOwner(rawOwner);
    // Check the immutable retry before validating a once-future deadline again.
    const input = eventArm(raw, now, true);
    const address = eventAddress(input);
    return this.db.transaction(() => {
      const previous = this.#find(address.waitId);
      if (previous) {
        this.#owned(previous, owner, address);
        const fingerprint = eventFingerprint({ ...input, owner: { hostId: owner.hostId, taskId: owner.taskId, bindingId: owner.bindingId, ownerGeneration: owner.ownerGeneration } });
        if (previous.armFingerprint !== fingerprint || previous.state === "cleared") fail("event_conflict", "This wait identity already has different content or was cleared. Use a new identity.", 409);
        this.#expire(previous, now); return eventPublic(previous);
      }
      if (input.expiresAt <= now) fail("event_expired", "Choose an explicit future wait expiry.", 409);
      const total = this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM event_waits INDEXED BY event_wait_retained WHERE state<>'cleared'").get()!.count;
      const perTask = this.db.query<{ count: number }, [string, string]>("SELECT count(*) AS count FROM event_waits INDEXED BY event_wait_retained WHERE host_id=? AND task_id=? AND state<>'cleared'").get(owner.hostId, owner.taskId)!.count;
      if (total >= eventLimits.retained || perTask >= eventLimits.perTask) fail("event_capacity", "Retained event capacity reached. Explicitly clear completed evidence before arming more waits.", 503);
      const { capabilityDigest, ...content } = input;
      const wait: StoredEventWait = { ...content, owner, capabilityDigest, armFingerprint: eventFingerprint({ ...input, owner: { hostId: owner.hostId, taskId: owner.taskId, bindingId: owner.bindingId, ownerGeneration: owner.ownerGeneration } }), version: 1, state: "waiting", createdAt: now, updatedAt: now };
      this.db.query("INSERT INTO event_waits(id,host_id,task_id,state,next_at,data) VALUES (?,?,?,?,?,?)").run(wait.waitId, owner.hostId, owner.taskId, wait.state, input.expiresAt, JSON.stringify(wait));
      return eventPublic(wait);
    }).immediate();
  }

  watch(rawOwner: EventOwner, raw: EventWatch, now: number): EventWait {
    const owner = eventOwner(rawOwner);
    const input = eventWatch(raw, now, true);
    const address = eventAddress(input);
    if (input.threadId === owner.taskId) fail("invalid_input", "A task cannot watch itself.");
    const snapshot = { hostId: owner.hostId, taskId: owner.taskId, bindingId: owner.bindingId, ownerGeneration: owner.ownerGeneration };
    return this.db.transaction(() => {
      const previous = this.#find(address.waitId);
      if (previous) {
        this.#owned(previous, owner, address);
        if (previous.armFingerprint !== eventFingerprint({ ...input, owner: snapshot }) || previous.state === "cleared") fail("event_conflict", "This wait identity already has different content or was cleared. Use a new identity.", 409);
        this.#expire(previous, now); return eventPublic(previous);
      }
      if (input.expiresAt <= now) fail("event_expired", "Choose an explicit future watch expiry.", 409);
      const total = this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM event_waits INDEXED BY event_wait_retained WHERE state<>'cleared'").get()!.count;
      const perTask = this.db.query<{ count: number }, [string, string]>("SELECT count(*) AS count FROM event_waits INDEXED BY event_wait_retained WHERE host_id=? AND task_id=? AND state<>'cleared'").get(owner.hostId, owner.taskId)!.count;
      if (total >= eventLimits.retained || perTask >= eventLimits.perTask) fail("event_capacity", "Retained event capacity reached. Explicitly clear completed evidence before arming more waits.", 503);
      const { threadId, ...content } = input;
      const wait: StoredEventWait = { ...content, owner, watch: { threadId }, armFingerprint: eventFingerprint({ ...input, owner: snapshot }), version: 1, state: "waiting", createdAt: now, updatedAt: now };
      this.db.query("INSERT INTO event_waits(id,host_id,task_id,state,next_at,data) VALUES (?,?,?,?,?,?)").run(wait.waitId, owner.hostId, owner.taskId, wait.state, input.expiresAt, JSON.stringify(wait));
      return eventPublic(wait);
    }).immediate();
  }
  watching(now: number, limit: number): EventWait[] {
    integer(limit, "Watch read limit", 1);
    return this.db.transaction(() => this.db.query<Row, [number, number]>("SELECT data FROM event_waits WHERE state='waiting' AND json_extract(data,'$.watch.threadId') IS NOT NULL AND json_extract(data,'$.expiresAt')>? ORDER BY rowid LIMIT ?").all(now, limit).map((row) => eventPublic(decode(row)))).immediate();
  }
  observe(rawAddress: EventAddress, raw: ThreadObservation, now: number): EventWait | undefined {
    const address = eventAddress(rawAddress), observation = threadObservation(raw);
    return this.db.transaction(() => {
      const wait = this.#find(address.waitId);
      if (!wait?.watch) return undefined;
      this.#address(wait, address); this.#expire(wait, now);
      // One observation per watch: a settled, cancelled or expired watch reports nothing more.
      if (wait.state !== "waiting" || wait.receipt) return undefined;
      const signal: EventSignal = { ...address, eventId: `watch:${observation.turnId}:${observation.status}`, outcome: "failed", evidenceRefs: [`codex:${wait.watch.threadId}:${observation.turnId}`],
        summary: `Watched task ${wait.watch.threadId}: its latest turn ${observation.turnId} ${observation.status === "failed" ? "failed" : "was interrupted"}. Seeker sent it nothing. Decide whether to resume, reassign or leave it; this notice does not restart it.` };
      wait.receipt = { id: randomUUID(), source: "watch", signal, recordedAt: now, disposition: "pending" };
      wait.signalFingerprint = eventFingerprint(signal);
      wait.state = "ready"; wait.delivery = { id: randomUUID(), state: "queued", attempts: 0, nextAt: now };
      wait.version += 1; wait.updatedAt = now; this.#save(wait);
      return eventPublic(wait);
    }).immediate();
  }

  get(owner: Pick<EventOwner, "hostId" | "taskId">, address: EventAddress, now: number): EventWait {
    return this.db.transaction(() => { const wait = this.#require(owner, address); this.#expire(wait, now); return eventPublic(wait); }).immediate();
  }
  pending(owner: Pick<EventOwner, "hostId" | "taskId">, now: number): EventWait[] {
    return this.db.transaction(() => this.db.query<Row, [string, string]>("SELECT data FROM event_waits INDEXED BY event_wait_retained WHERE host_id=? AND task_id=? AND state<>'cleared' ORDER BY rowid").all(id(owner.hostId, "Host"), id(owner.taskId, "Task")).map((row) => { const wait = decode(row); this.#expire(wait, now); return eventPublic(wait); })).immediate();
  }

  mutate(rawOwner: EventOwner, address: EventAddress, expectedVersion: number, command: Parameters<EventStore["mutate"]>[3], now: number): EventWait {
    const owner = eventOwner(rawOwner); integer(expectedVersion, "Event version", 1);
    return this.db.transaction(() => {
      const wait = this.#require(owner, address); this.#expire(wait, now);
      if (wait.version !== expectedVersion) fail("event_version", "Read the current wait before changing it.", 409);
      if (command.type === "cancel") {
        if (!terminal(wait)) { wait.state = "cancelled"; wait.reason = "owner_cancelled"; this.#retire(wait); }
      } else if (command.type === "acknowledge") {
        if (!["received", "handled", "unknown"].includes(command.status) || !wait.receipt || wait.receipt.id !== id(command.receiptId, "Receipt")) fail("event_receipt", "The exact saved event receipt is required.", 409);
        if (wait.state === "cleared") fail("event_closed", "This event evidence was cleared.", 409);
        if (wait.receipt.disposition === "handled" && command.status !== "handled") fail("event_disposition", "A handled event cannot become unhandled.", 409);
        wait.receipt.disposition = command.status; wait.receipt.evidenceRef = `${owner.hostId}:${owner.taskId}:${owner.turnId}:${owner.callId}`;
        if (command.status === "handled" && !["cancelled", "expired"].includes(wait.state)) wait.state = "handled";
        this.#retire(wait);
      } else {
        if (!terminal(wait) || wait.state === "cleared" || wait.delivery?.state === "sending" || (wait.delivery?.state === "unknown" && wait.receipt?.disposition !== "handled")) fail("event_unsettled", "Settle this wait and explicitly reconcile uncertain delivery before clearing evidence.", 409);
        // Keep a small revoked identity tombstone so a delayed arm/signal retry cannot recreate a send.
        wait.state = "cleared";
        wait.owner = { hostId: wait.owner.hostId, taskId: wait.owner.taskId };
        delete wait.title; delete wait.expiresAt; delete wait.createdAt;
        delete wait.receipt; delete wait.delivery; delete wait.capabilityDigest; delete wait.armFingerprint; delete wait.signalFingerprint; delete wait.reason;
      }
      wait.version += 1; wait.updatedAt = now; this.#save(wait); return eventPublic(wait);
    }).immediate();
  }

  signal(capability: string, raw: EventSignal, now: number): { status: "recorded" | "duplicate"; receiptId: string } {
    const input = eventSignal(raw);
    if (typeof capability !== "string" || !/^[a-f0-9]{64}$/.test(capability)) fail("event_unauthorized", "The event capability was not accepted.", 401);
    const result = this.db.transaction(() => {
      const wait = this.#find(input.waitId);
      const digest = eventDigest(capability);
      if (!wait?.capabilityDigest || !timingSafeEqual(Buffer.from(digest), Buffer.from(wait.capabilityDigest))) fail("event_unauthorized", "The event capability was not accepted.", 401);
      this.#address(wait, input); this.#expire(wait, now);
      // Commit the deadline receipt even when this late producer is rejected.
      if (wait.receipt?.source === "deadline") return undefined;
      const fingerprint = eventFingerprint(input);
      if (wait.receipt) {
        if (wait.signalFingerprint !== fingerprint) fail("event_conflict", "This wait already has a different saved event.", 409);
        return { status: "duplicate" as const, receiptId: wait.receipt.id };
      }
      if (terminal(wait)) fail("event_closed", "This wait no longer accepts a signal.", 409);
      wait.receipt = { id: randomUUID(), signal: input, recordedAt: now, disposition: "pending" };
      wait.signalFingerprint = fingerprint;
      wait.state = "ready";
      wait.delivery = { id: randomUUID(), state: "queued", attempts: 0, nextAt: now };
      wait.version += 1; wait.updatedAt = now; this.#save(wait);
      return { status: "recorded" as const, receiptId: wait.receipt.id };
    }).immediate();
    if (!result) fail("event_closed", "The deadline passed without a producer result. This wait no longer accepts a signal.", 409);
    return result;
  }

  claim(limit: number, now: number, excludedRoutes: readonly string[]): EventWait[] {
    integer(limit, "Event delivery concurrency", 1); if (limit > 8) fail("invalid_input", "Event concurrency must be 1–8.");
    return this.db.transaction(() => {
      const claimed: EventWait[] = [], excluded = new Set(excludedRoutes);
      // Expiration and queue selection stay bounded even with thousands of retained results.
      const expired = this.db.query<Row, [number, number]>("SELECT data FROM event_waits WHERE state IN ('waiting','ready') AND next_at<=? AND json_extract(data,'$.expiresAt')<=? AND json_extract(data,'$.receipt.source') IS NOT 'deadline' LIMIT 128").all(now, now);
      for (const row of expired) this.#expire(decode(row), now);
      while (claimed.length < limit) {
        const routes = [...excluded];
        const route = "json_array('event',host_id,task_id)";
        const row = this.db.query<Row, (string | number)[]>(`SELECT data FROM event_waits WHERE state='ready' AND next_at<=? AND json_extract(data,'$.delivery.state') IN ('queued','retry') ${routes.length ? `AND (${route}) NOT IN (${routes.map(() => "?").join(",")})` : ""} ORDER BY next_at,rowid LIMIT 1`).get(now, ...routes);
        if (!row) break;
        const wait = decode(row); this.#expire(wait, now);
        if (wait.state !== "ready" || !wait.delivery) continue;
        wait.delivery.state = "sending"; wait.delivery.attemptId = randomUUID(); wait.delivery.authorizationVersion = wait.version; wait.delivery.attempts += 1; this.#save(wait);
        claimed.push(eventPublic(wait)); excluded.add(eventRoute(wait));
      }
      return claimed;
    }).immediate();
  }
  complete(waitId: string, generation: string, attemptId: string, result: DeliveryResult, now: number): void {
    this.db.transaction(() => {
      const wait = this.#find(waitId), delivery = wait?.delivery;
      if (!wait || wait.generation !== generation || !delivery || delivery.attemptId !== attemptId || (delivery.state !== "sending" && !(delivery.state === "unknown" && delivery.code === "io_timeout" && result.status === "accepted"))) return;
      delivery.state = result.status;
      if (result.status === "accepted") {
        if (typeof result.reference !== "string" || !result.reference || result.reference.length > 500) fail("invalid_adapter_result", "Event delivery reference is invalid.");
        delivery.reference = result.reference; delete delivery.code;
      } else {
        delivery.code = id(result.code, "Event delivery code");
        if (result.status === "retry") {
          integer(result.retryAfterMs, "Retry delay", 0); delivery.nextAt = now + Math.max(1000, result.retryAfterMs);
          if (terminal(wait)) delivery.state = "retired";
          else if (delivery.code === "event_owner_active") delivery.attempts = Math.max(0, delivery.attempts - 1);
          else if (delivery.attempts >= 5) { delivery.state = "rejected"; delivery.code = "retry_exhausted"; }
        }
      }
      // A fresh explicit resume can overlap an old prewrite attempt. Only its
      // definite unsent outcome may release a new intent for the fresh anchor.
      if ((result.status === "retry" || result.status === "rejected") && delivery.authorizationVersion !== wait.version && wait.state === "ready" && wait.receipt?.disposition === "pending") this.#renew(wait, now);
      wait.updatedAt = now; this.#save(wait);
    }).immediate();
  }
  recover(now: number): number {
    return this.db.transaction(() => {
      const rows = this.db.query<Row, []>("SELECT data FROM event_waits INDEXED BY event_wait_retained WHERE state<>'cleared' AND json_extract(data,'$.delivery.state')='sending'").all();
      for (const row of rows) { const wait = decode(row); wait.delivery!.state = "unknown"; wait.delivery!.code = "receiver_restarted"; wait.updatedAt = now; this.#save(wait); }
      // Earlier releases paused a wait when its owner's turn changed. A newer turn no
      // longer holds delivery, so a stored paused wait becomes deliverable again.
      const paused = this.db.query<Row, []>("SELECT data FROM event_waits WHERE state='paused'").all();
      for (const row of paused) {
        const wait = decode(row);
        wait.state = wait.receipt ? "ready" : "waiting"; delete wait.reason;
        if (wait.receipt?.disposition === "pending" && (!wait.delivery || ["queued", "retry", "retired", "rejected"].includes(wait.delivery.state))) this.#renew(wait, now);
        wait.version += 1; wait.updatedAt = now; this.#save(wait);
        // A passed deadline now takes its ordinary course: a deadline notice, or expiry of a saved result's unsent notification.
        this.#expire(wait, now);
      }
      return rows.length;
    }).immediate();
  }
  resumeHost(hostId: string, now: number): number {
    return this.db.transaction(() => {
      const rows = this.db.query<Row, [string]>("SELECT data FROM event_waits WHERE host_id=? AND state='ready' AND json_extract(data,'$.delivery.state')='rejected' AND json_extract(data,'$.delivery.code')='retry_exhausted'").all(hostId);
      let resumed = 0;
      for (const row of rows) { const wait = decode(row); this.#expire(wait, now); if (wait.state !== "ready") continue; wait.delivery!.state = "retry"; wait.delivery!.attempts = 0; wait.delivery!.nextAt = now; this.#save(wait); resumed += 1; }
      return resumed;
    }).immediate();
  }
  current(address: EventAddress, deliveryId: string, version: number, now: number): EventWait | undefined {
    return this.db.transaction(() => {
      const wait = this.#find(address.waitId); if (!wait) return;
      this.#address(wait, address); this.#expire(wait, now);
      if (wait.version !== version || wait.state !== "ready" || wait.receipt?.disposition !== "pending" || wait.delivery?.id !== deliveryId || (!["queued", "retry", "sending"].includes(wait.delivery.state) && !(wait.delivery.state === "rejected" && wait.delivery.code === "retry_exhausted"))) return;
      return eventPublic(wait);
    }).immediate();
  }
  #find(waitId: string): StoredEventWait | undefined { const row = this.db.query<Row, [string]>("SELECT data FROM event_waits WHERE id=?").get(id(waitId, "Wait")); return row ? decode(row) : undefined; }
  #require(owner: Pick<EventOwner, "hostId" | "taskId">, address: EventAddress): StoredEventWait { const wait = this.#find(address.waitId); if (!wait) fail("event_not_found", "Event wait not found.", 404); this.#owned(wait, owner, address); return wait; }
  #owned(wait: EventWait, owner: Pick<EventOwner, "hostId" | "taskId">, address: EventAddress): void { if (!sameEventOwner(wait.owner, owner)) fail("origin_denied", "This event wait belongs to another native task.", 403); this.#address(wait, address); }
  #address(wait: EventWait, raw: EventAddress): void { const address = eventAddress(raw); if (wait.generation !== address.generation || wait.revision !== address.revision) fail("event_generation", "The event generation or source revision changed.", 409); }
  #renew(wait: StoredEventWait, now: number): void { wait.delivery = { id: randomUUID(), state: "queued", attempts: 0, nextAt: now }; }
  #retire(wait: StoredEventWait): void { if (wait.delivery && ["queued", "retry", "rejected"].includes(wait.delivery.state)) wait.delivery.state = "retired"; }
  #expire(wait: StoredEventWait, now: number): void {
    if (terminal(wait) || wait.receipt?.source === "deadline" || (wait.expiresAt !== undefined && wait.expiresAt > now)) return;
    // A watch's expiry only ends the watching: an observation already recorded is still delivered,
    // and there is no producer whose silence needs reporting.
    if (wait.watch && wait.receipt) return;
    if (!wait.receipt && wait.expiresAt !== undefined && !wait.watch) {
      wait.receipt = {
        id: randomUUID(), source: "deadline", recordedAt: now, disposition: "pending",
        signal: { ...eventAddress(wait), eventId: randomUUID(), outcome: "failed", evidenceRefs: [],
          summary: "The wait deadline passed without a producer result. Job completion is unknown. Reconcile the existing job and retained evidence before continuing; this notice does not restart it." },
      };
      wait.state = "ready"; wait.reason = "deadline_passed";
      wait.delivery = { id: randomUUID(), state: "queued", attempts: 0, nextAt: now };
    } else {
      wait.state = "expired"; wait.reason = "deadline_passed"; this.#retire(wait);
    }
    wait.version += 1; wait.updatedAt = now; this.#save(wait);
  }
  #save(wait: StoredEventWait): void {
    const queued = wait.state === "ready" && wait.delivery && ["queued", "retry"].includes(wait.delivery.state);
    const next = queued ? wait.receipt?.source === "deadline" ? wait.delivery!.nextAt : Math.min(wait.expiresAt ?? 0, wait.delivery!.nextAt) : wait.expiresAt ?? 0;
    this.db.query("UPDATE event_waits SET state=?,next_at=?,data=? WHERE id=?").run(wait.state, next, JSON.stringify(wait), wait.waitId);
  }
}
