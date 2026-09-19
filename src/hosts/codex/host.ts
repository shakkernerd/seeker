import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DeliveryResult, HostAdapter, HostEnvelope, ManagerBinding, ManagerOrigin, ManagerPort } from "../../contracts.ts";
import { ConnectorError, codexRoute, connectorProtocol, identifier, maxWireBytes, onlyKeys, parseDeliveryResult, parseInvocation, record, type NativeDelivery } from "./protocol.ts";
import { invokeManager } from "./tools.ts";

export interface CodexManagerAccess {
  binding(managerId: string): ManagerBinding | undefined;
  manager(origin: ManagerOrigin): ManagerPort;
}
export interface CodexHostLifecycle {
  connected(registration: unknown): Promise<void>;
  admitted?(registration: unknown): Promise<void>;
  ready?(registration: unknown): void;
  resume(binding: ManagerBinding, signal: AbortSignal): Promise<void>;
}
interface Connection {
  token: string;
  instanceId: string;
  lastSeen: number;
  poll?: (response: Response) => void;
  bindings: Map<string, string>;
  desktop?: unknown;
}
interface Attempt {
  connection: Connection;
  delivery: NativeDelivery;
  finish: (result: DeliveryResult) => void;
  promise: Promise<DeliveryResult>;
}
interface Recovery {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  expires: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  cancel: () => void;
}

/** Authenticated host transport. Only individual invocation metadata grants a ManagerPort. */
export class CodexHostAdapter implements HostAdapter {
  readonly #connections = new Map<string, Connection>();
  readonly #attempts = new Map<string, Attempt>();
  readonly #completed = new Map<string, string>();
  readonly #resumed = new Set<string>();
  readonly #timer: ReturnType<typeof setInterval>;
  #recovery?: Recovery;
  #closed = false;
  #needsRecovery = true;

  constructor(readonly id: string, private readonly credential: string, private readonly access: CodexManagerAccess, private readonly deadlineMs = 4_500, private readonly restored?: () => void, private readonly lifecycle?: CodexHostLifecycle) {
    identifier(id);
    if (!/^[a-f0-9]{64}$/.test(credential)) throw new ConnectorError("invalid_credential", "A dedicated private connector credential is required.");
    this.#timer = setInterval(() => this.#prune(), 30_000);
    this.#timer.unref();
  }

  async handle(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(`${codexRoute}/`)) return;
    try {
      if (this.#closed) throw new ConnectorError("host_closed", "The native host bridge is stopping.", 503);
      if (request.headers.has("origin")) throw new ConnectorError("browser_denied", "This endpoint accepts the host connector only.", 403);
      if (request.method !== "POST") throw new ConnectorError("method_denied", "Use the connector protocol.", 405);
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (path === `${codexRoute}/connect`) {
        if (!sameSecret(token, this.credential)) throw new ConnectorError("unauthorized", "Native connector authentication failed.", 401);
        const body = await bodyObject(request); onlyKeys(body, ["protocol", "instanceId", "desktop"]);
        if (body.protocol !== connectorProtocol) throw new ConnectorError("protocol_mismatch", "The native connector and service versions differ.", 409);
        const instanceId = identifier(body.instanceId);
        await this.lifecycle?.connected(body.desktop);
        if (this.#closed || request.signal.aborted) throw new ConnectorError("host_closed", "The native host bridge is stopping.", 503);
        this.#prune();
        // A retry of an unacknowledged connect reuses its transport identity.
        let connection = [...this.#connections.values()].find((item) => item.instanceId === instanceId);
        if (connection && JSON.stringify(connection.desktop) !== JSON.stringify(body.desktop)) throw new ConnectorError("desktop_owner_changed", "A connector cannot replace its native owner while reconnecting.", 409);
        if (!connection) {
          if (this.#connections.size >= 256) throw new ConnectorError("host_capacity", "Native connector capacity reached.", 503);
          connection = { token: randomBytes(32).toString("hex"), instanceId, lastSeen: Date.now(), bindings: new Map(), desktop: body.desktop };
          this.#connections.set(connection.token, connection);
        }
        connection.lastSeen = Date.now();
        return privateJson({ protocol: connectorProtocol, hostId: this.id, session: connection.token });
      }
      const connection = token ? this.#connections.get(token) : undefined;
      if (!connection) throw new ConnectorError("unauthorized", "Native connector session expired.", 401);
      connection.lastSeen = Date.now();
      if (path === `${codexRoute}/invoke`) {
        const body = await bodyObject(request); onlyKeys(body, ["origin", "operation", "arguments"]);
        const invocation = parseInvocation(body.origin);
        const binding = this.access.binding(invocation.threadId);
        if (!binding || binding.origin.hostId !== this.id) throw new ConnectorError("origin_denied", "This native task is not a registered manager. Report to your manager.", 403);
        const epoch = ownerEpoch(binding);
        const previous = connection.bindings.get(invocation.threadId);
        if (previous && previous !== epoch) throw new ConnectorError("owner_changed", "This connector's manager assignment changed. Reconnect deliberately.", 409);
        await this.lifecycle?.admitted?.(connection.desktop);
        const current = this.access.binding(invocation.threadId);
        if (this.#closed || request.signal.aborted || !current || ownerEpoch(current) !== epoch) throw new ConnectorError("owner_changed", "The manager assignment changed before this invocation.", 409);
        connection.bindings.set(invocation.threadId, epoch);
        const port = this.access.manager({ ...binding.origin, turnId: invocation.turnId, callId: invocation.callId });
        return privateJson(invokeManager(port, identifier(body.operation), body.arguments, invocation));
      }
      if (path === `${codexRoute}/poll`) {
        onlyKeys(await bodyObject(request), []);
        if (connection.poll) throw new ConnectorError("poll_conflict", "Only one receive operation is allowed per connector.", 409);
        this.lifecycle?.ready?.(connection.desktop);
        if (!request.signal.aborted) { this.#cancelRecovery(); this.#resumed.clear(); }
        if (!request.signal.aborted && this.#needsRecovery) {
          // An authenticated receiver is usable again, even if a crashed peer's
          // session has not expired. Merely connecting or renewing a poll is not recovery.
          this.restored?.();
          this.#needsRecovery = false;
        }
        return await new Promise<Response>((resolve) => {
          const finish = (response: Response) => { clearTimeout(timer); request.signal.removeEventListener("abort", abort); if (connection.poll === finish) connection.poll = undefined; resolve(response); };
          const abort = () => { finish(new Response(null, { status: 204 })); this.#observeUnavailable(); };
          const timer = setTimeout(() => finish(new Response(null, { status: 204 })), 20_000); timer.unref();
          connection.poll = finish;
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort();
        });
      }
      if (path === `${codexRoute}/result`) {
        const body = await bodyObject(request); onlyKeys(body, ["attemptId", "result"]);
        const attemptId = identifier(body.attemptId);
        const attempt = this.#attempts.get(attemptId);
        if (attempt?.connection === connection) { attempt.finish(parseDeliveryResult(body.result)); return privateJson({ recorded: true }); }
        if (this.#completed.get(attemptId) === connection.token) return privateJson({ recorded: true });
        throw new ConnectorError("attempt_expired", "This delivery attempt has ended. Its outcome remains uncertain.", 409);
      }
      if (path === `${codexRoute}/disconnect`) {
        onlyKeys(await bodyObject(request), []); this.#drop(connection); return privateJson({ disconnected: true });
      }
      throw new ConnectorError("not_found", "Unknown native connector operation.", 404);
    } catch (error) {
      const value = error as { code?: unknown; message?: unknown; status?: unknown };
      const known = error instanceof ConnectorError || (error instanceof Error && error.name === "SeekerError");
      return privateJson({ error: known ? value.code : "connector_error", message: known ? value.message : "Native connector request failed." }, { status: known && typeof value.status === "number" ? value.status : 400 });
    }
  }

  async deliver(binding: ManagerBinding, envelope: HostEnvelope, signal: AbortSignal): Promise<DeliveryResult> {
    if (this.#closed || signal.aborted) return { status: "retry", retryAfterMs: 2_000, code: "host_unavailable" };
    const current = this.access.binding(binding.origin.managerId);
    if (!current || ownerEpoch(current) !== ownerEpoch(binding)) return { status: "rejected", code: "owner_changed" };
    const existing = [...this.#attempts.values()].find((item) => item.delivery.envelope.deliveryId === envelope.deliveryId);
    if (existing) return ownerEpoch(existing.delivery.binding) === ownerEpoch(binding) ? existing.promise : { status: "rejected", code: "owner_changed" };
    const connection = [...this.#connections.values()].find((item) => item.poll);
    if (!connection) {
      this.#needsRecovery = true;
      this.#scheduleRecovery(binding, envelope.deliveryId, signal);
      return { status: "retry", retryAfterMs: 500, code: "host_offline" };
    }
    const delivery: NativeDelivery = { attemptId: randomUUID(), binding, envelope };
    let finish!: (result: DeliveryResult) => void;
    const promise = new Promise<DeliveryResult>((resolve) => {
      finish = (result) => {
        if (!this.#attempts.delete(delivery.attemptId)) return;
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        this.#completed.set(delivery.attemptId, connection.token);
        if (this.#completed.size > 512) this.#completed.delete(this.#completed.keys().next().value!);
        if (result.status === "unknown") this.#observeUnavailable();
        resolve(result);
      };
      const abort = () => finish({ status: "unknown", code: "native_connection_interrupted" });
      const timer = setTimeout(() => finish({ status: "unknown", code: "native_result_timeout" }), this.deadlineMs); timer.unref();
      signal.addEventListener("abort", abort, { once: true });
    });
    this.#attempts.set(delivery.attemptId, { connection, delivery, finish, promise });
    if (signal.aborted) finish({ status: "retry", retryAfterMs: 500, code: "host_unavailable" });
    else connection.poll!(privateJson(delivery));
    return promise;
  }

  close(): void {
    this.#closed = true; clearInterval(this.#timer);
    this.#cancelRecovery();
    for (const connection of this.#connections.values()) this.#drop(connection);
    this.#completed.clear();
    this.#resumed.clear();
  }
  #scheduleRecovery(binding: ManagerBinding, deliveryId: string, signal: AbortSignal): void {
    const key = JSON.stringify([ownerEpoch(binding), deliveryId]);
    if (!this.lifecycle || this.#recovery || this.#resumed.has(key)) return;
    const controller = new AbortController();
    const cancel = () => { if (this.#recovery?.controller === controller) this.#cancelRecovery(); };
    const check = () => {
      if (this.#recovery?.controller !== controller || controller.signal.aborted) return;
      const current = this.access.binding(binding.origin.managerId);
      if (this.#closed || signal.aborted || !current || ownerEpoch(current) !== ownerEpoch(binding) || [...this.#connections.values()].some((item) => item.poll)) { cancel(); return; }
      // A receiver can be sending native input or moving between polls. Neither
      // is evidence that its host needs to be started or its task resumed.
      if (this.#attempts.size || [...this.#connections.values()].some((item) => Date.now() - item.lastSeen < 1_000)) {
        this.#recovery.timer = setTimeout(check, 1_000); this.#recovery.timer.unref();
        return;
      }
      this.#resumed.add(key);
      if (this.#resumed.size > 512) this.#resumed.delete(this.#resumed.values().next().value!);
      // Starting a host is not delivering human input. Keep it outside the
      // delivery deadline; only a qualified poll restores known-offline work.
      void this.lifecycle!.resume(binding, controller.signal).catch(() => undefined);
    };
    const timer = setTimeout(check, 1_000); timer.unref();
    const expires = setTimeout(cancel, 15_000); expires.unref();
    this.#recovery = { controller, timer, expires, signal, cancel };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  }
  #cancelRecovery(): void {
    const recovery = this.#recovery;
    if (!recovery) return;
    this.#recovery = undefined;
    clearTimeout(recovery.timer); clearTimeout(recovery.expires);
    recovery.signal.removeEventListener("abort", recovery.cancel);
    recovery.controller.abort();
  }
  #drop(connection: Connection): void {
    connection.poll?.(new Response(null, { status: 204 }));
    this.#connections.delete(connection.token);
    for (const attempt of [...this.#attempts.values()]) if (attempt.connection === connection) attempt.finish({ status: "unknown", code: "native_connection_lost" });
    this.#observeUnavailable();
  }
  #observeUnavailable(): void {
    if (!this.#attempts.size && ![...this.#connections.values()].some((connection) => connection.poll)) this.#needsRecovery = true;
  }
  #prune(): void {
    for (const connection of this.#connections.values()) if (Date.now() - connection.lastSeen > 60_000 && !connection.poll) this.#drop(connection);
  }
}

function ownerEpoch(binding: ManagerBinding): string {
  const value = binding.origin;
  return JSON.stringify([value.hostId, value.managerId, value.assignmentId, value.generation]);
}
function sameSecret(input: string | undefined, expected: string): boolean {
  return typeof input === "string" && input.length === expected.length && timingSafeEqual(Buffer.from(input), Buffer.from(expected));
}
async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new ConnectorError("invalid_input", "A connector message is required.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maxWireBytes) { await reader.cancel(); throw new ConnectorError("too_large", "The connector message is too large.", 413); }
      chunks.push(next.value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally { reader.releaseLock(); }
}

function privateJson(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, { ...init, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...init.headers } });
}
