import { randomUUID } from "node:crypto";
import { privateSocket, readConnectorConfig, readConnectorCredential, type CodexConnectorConfig } from "./config.ts";
import { CodexNativeClient } from "./native.ts";
import { captureDesktopOwner, type DesktopOwner } from "./desktop-owner.ts";
import { ConnectorError, codexRoute, connectorProtocol, record, type NativeInvocation } from "./protocol.ts";
import { serveSeekerTools } from "../codex-common/mcp.ts";
import { privateRequest } from "./private-http.ts";

export class CodexConnector {
  readonly #instanceId = randomUUID();
  readonly #lifetime = new AbortController();
  #session?: string;
  #connecting?: Promise<string>;

  constructor(private readonly config: CodexConnectorConfig, private readonly credential: string, private readonly native: CodexNativeClient, private readonly desktop?: DesktopOwner) {}

  async invoke(origin: NativeInvocation, operation: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const session = await this.#connect();
    try { return await this.#request("invoke", { origin, operation, arguments: args }, session, 4_000, signal); }
    catch (error) {
      // Expiry is a definite authentication rejection before invocation. Renew
      // once; never repeat a mutation whose response or acceptance is uncertain.
      if (!(error instanceof ConnectorError) || error.status !== 401 || this.#session !== session) throw error;
      this.#session = undefined;
      return this.#request("invoke", { origin, operation, arguments: args }, await this.#connect(), 4_000, signal);
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

export async function runCodexConnector(configPath: string, owner?: DesktopOwner): Promise<void> {
  const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  if (!pipe) throw new ConnectorError("native_host_required", "Run this connector through Codex Desktop's configured MCP server.");
  const config = readConnectorConfig(configPath);
  const desktop = owner ?? await captureDesktopOwner();
  const connector = new CodexConnector(config, readConnectorCredential(config.credentialFile), new CodexNativeClient(pipe, 3_000), desktop);
  try { await serveSeekerTools(connector); }
  finally { await connector.close(); }
}
