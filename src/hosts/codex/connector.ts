import { randomUUID } from "node:crypto";
import type { DeliveryResult } from "../../contracts.ts";
import { privateSocket, readConnectorConfig, readConnectorCredential, type CodexConnectorConfig } from "./config.ts";
import { CodexNativeClient } from "./native.ts";
import { captureDesktopOwner, type DesktopOwner } from "./desktop-owner.ts";
import { ConnectorError, codexRoute, connectorProtocol, envelopeReference, identifier, record, type NativeDelivery, type NativeInvocation } from "./protocol.ts";
import { serveSeekerTools } from "../codex-common/mcp.ts";
import { privateRequest } from "./private-http.ts";

export class CodexConnector {
  readonly #instanceId = randomUUID();
  readonly #lifetime = new AbortController();
  readonly #results = new Map<string, { owner: string; result: DeliveryResult }>();
  #session?: string;
  #connecting?: Promise<string>;

  constructor(private readonly config: CodexConnectorConfig, private readonly credential: string, private readonly native: CodexNativeClient, private readonly desktop?: DesktopOwner) {}

  async invoke(origin: NativeInvocation, operation: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const session = await this.#connect();
    try { return await this.#request("invoke", { origin, operation, arguments: args }, session, 4_000, signal); }
    catch (error) { if (error instanceof ConnectorError && error.status === 401 && this.#session === session) this.#session = undefined; throw error; }
  }

  async receive(): Promise<void> {
    while (!this.#lifetime.signal.aborted) {
      let session: string | undefined;
      try {
        session = await this.#connect();
        const value = await this.#request("poll", {}, session, 25_000);
        if (value === null) continue;
        const delivery = parseNativeDelivery(value, this.config.hostId);
        const owner = JSON.stringify([delivery.binding.id, delivery.binding.origin, delivery.envelope.exchangeId, envelopeReference(delivery.envelope)]);
        const previous = this.#results.get(delivery.envelope.deliveryId);
        const result: DeliveryResult = previous
          ? previous.owner === owner ? previous.result : { status: "rejected", code: "delivery_identity_changed" }
          : await this.native.deliver(delivery, this.#lifetime.signal);
        if (result.status !== "retry") {
          this.#results.set(delivery.envelope.deliveryId, { owner, result });
          if (this.#results.size > 512) this.#results.delete(this.#results.keys().next().value!);
        }
        await this.#request("result", { attemptId: delivery.attemptId, result }, session, 4_000);
      } catch (error) {
        if (this.#lifetime.signal.aborted) break;
        if (session === this.#session) this.#session = undefined;
        // The core retains delivery uncertainty. Reconnecting never repeats native input here.
        await pause(1_000, this.#lifetime.signal);
      }
    }
  }

  async close(): Promise<void> {
    const session = this.#session;
    this.#lifetime.abort();
    if (session) {
      try { await privateRequest(this.config.socketPath, `${codexRoute}/disconnect`, session, {}, AbortSignal.timeout(500)); } catch { /* The service also expires disconnected peers. */ }
    }
  }

  #connect(): Promise<string> {
    if (this.#session) return Promise.resolve(this.#session);
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      privateSocket(this.config.socketPath);
      await this.native.qualify(this.#lifetime.signal);
      const response = record(await this.#request("connect", { protocol: connectorProtocol, instanceId: this.#instanceId, ...(this.desktop ? { desktop: this.desktop } : {}) }, this.credential, 4_000));
      if (response.protocol !== connectorProtocol || response.hostId !== this.config.hostId || typeof response.session !== "string" || !/^[a-f0-9]{64}$/.test(response.session)) throw new ConnectorError("wrong_host", "The connector reached a different Seeker host registration.");
      this.#session = response.session;
      return response.session;
    })().finally(() => { this.#connecting = undefined; });
    return this.#connecting;
  }

  async #request(operation: string, body: unknown, credential: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    let response: { status: number; text: string };
    try {
      response = await privateRequest(this.config.socketPath, `${codexRoute}/${operation}`, credential, body, AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]));
    } catch { throw new ConnectorError("service_unavailable", "Seeker is unavailable or the response was lost. Retain request IDs; check the exchange before repeating a mutation.", 503); }
    if (response.status === 204) return null;
    const value = JSON.parse(response.text);
    if (response.status < 200 || response.status >= 300) {
      const error = record(value);
      throw new ConnectorError(typeof error.error === "string" ? error.error : "service_error", typeof error.message === "string" ? error.message : "Seeker rejected this operation.", response.status);
    }
    return value;
  }
}

function parseNativeDelivery(value: unknown, hostId: string): NativeDelivery {
  const message = record(value), binding = record(message.binding), origin = record(binding.origin), envelope = record(message.envelope);
  identifier(message.attemptId); identifier(binding.id); identifier(origin.managerId); identifier(origin.assignmentId); identifier(envelope.deliveryId); identifier(envelope.exchangeId);
  if (["receipt", "deferred", "notice"].filter((key) => key in envelope).length !== 1) throw new ConnectorError("invalid_envelope", "Unknown Seeker envelope.");
  if ("receipt" in envelope) identifier(record(envelope.receipt).id);
  else if ("deferred" in envelope) { const deferred = record(envelope.deferred); identifier(deferred.channelId); identifier(record(deferred.event).eventId); }
  else { const notice = record(envelope.notice); identifier(notice.deliveryId); if (notice.state !== "unknown" && notice.state !== "rejected") throw new ConnectorError("invalid_notice", "Unknown service notice."); }
  if (origin.hostId !== hostId || !Number.isSafeInteger(origin.generation) || (origin.generation as number) < 1) throw new ConnectorError("wrong_owner", "The delivery does not match this host.");
  return value as NativeDelivery;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms); timer.unref(); signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

export async function runCodexConnector(configPath: string, owner?: DesktopOwner): Promise<void> {
  const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  if (!pipe) throw new ConnectorError("native_host_required", "Run this connector through Codex Desktop's configured MCP server.");
  const config = readConnectorConfig(configPath);
  const desktop = owner ?? await captureDesktopOwner();
  const connector = new CodexConnector(config, readConnectorCredential(config.credentialFile), new CodexNativeClient(pipe, 3_000), desktop);
  const receive = connector.receive();
  try { await serveSeekerTools(connector); }
  finally { await connector.close(); await receive; }
}
