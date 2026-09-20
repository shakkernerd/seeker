import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DeliveryResult, HostAdapter, HostEnvelope, ManagerBinding, ManagerOrigin, ManagerPort } from "../../contracts.ts";
import { ConnectorError, codexRoute, connectorProtocol, identifier, maxWireBytes, onlyKeys, parseInvocation, record } from "./protocol.ts";
import { invokeManager } from "./tools.ts";

export interface CodexManagerAccess {
  binding(managerId: string): ManagerBinding | undefined;
  manager(origin: ManagerOrigin): ManagerPort;
}
export interface CodexHostLifecycle {
  connected(registration: unknown): Promise<void>;
  admitted?(registration: unknown): Promise<void>;
  ready?(registration: unknown): void;
}
interface Connection {
  token: string;
  instanceId: string;
  lastSeen: number;
  poll?: (response: Response) => void;
  bindings: Map<string, string>;
  desktop?: unknown;
}
export interface DesktopHostInput {
  deliver(binding: ManagerBinding, envelope: HostEnvelope, signal: AbortSignal): Promise<DeliveryResult>;
  restored?(): void;
  close(): Promise<void>;
}

/** Authenticated host transport. Only individual invocation metadata grants a ManagerPort. */
export class CodexHostAdapter implements HostAdapter {
  readonly #connections = new Map<string, Connection>();
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(readonly id: string, private readonly credential: string, private readonly access: CodexManagerAccess, private readonly lifecycle?: CodexHostLifecycle, private readonly input?: DesktopHostInput) {
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
        this.lifecycle?.ready?.(connection.desktop);
        if (this.#connections.get(connection.token) !== connection) throw new ConnectorError("unauthorized", "The native connector session ended before this invocation.", 401);
        connection.bindings.set(invocation.threadId, epoch);
        if (!previous) this.input?.restored?.();
        const port = this.access.manager({ ...binding.origin, turnId: invocation.turnId, callId: invocation.callId });
        return privateJson(invokeManager(port, identifier(body.operation), body.arguments, invocation));
      }
      if (path === `${codexRoute}/poll`) {
        onlyKeys(await bodyObject(request), []);
        if (connection.poll) throw new ConnectorError("poll_conflict", "Only one receive operation is allowed per connector.", 409);
        this.lifecycle?.ready?.(connection.desktop);
        // Compatibility for already-loaded older connectors. They may finish
        // their ordinary long poll, but only the guarded helper sends input.
        return await new Promise<Response>((resolve) => {
          const finish = (response: Response) => { clearTimeout(timer); request.signal.removeEventListener("abort", abort); if (connection.poll === finish) connection.poll = undefined; resolve(response); };
          const abort = () => finish(new Response(null, { status: 204 }));
          const timer = setTimeout(() => finish(new Response(null, { status: 204 })), 20_000); timer.unref();
          connection.poll = finish;
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort();
        });
      }
      if (path === `${codexRoute}/result`) {
        const body = await bodyObject(request); onlyKeys(body, ["attemptId", "result"]);
        identifier(body.attemptId);
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
    if (this.#closed || signal.aborted || !this.input) return { status: "retry", retryAfterMs: 1_000, code: "host_unavailable" };
    return this.input.deliver(binding, envelope, signal);
  }

  async close(): Promise<void> {
    this.#closed = true; clearInterval(this.#timer);
    for (const connection of this.#connections.values()) this.#drop(connection);
    await this.input?.close();
  }
  #drop(connection: Connection): void {
    connection.poll?.(new Response(null, { status: 204 }));
    this.#connections.delete(connection.token);
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
