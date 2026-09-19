import { readConnectorCredential } from "../codex/config.ts";
import { privateRequest } from "../codex/private-http.ts";
import { ConnectorError, record, type NativeInvocation } from "../codex/protocol.ts";
import { serveSeekerTools } from "../codex-common/mcp.ts";
import { cliRoute, readCliConfig } from "./config.ts";
import type { CliOwner } from "./owner.ts";

/** Host identity is captured by the shared entry from the real MCP parent, never from tool arguments. */
export async function runCliConnector(configPath: string, owner: CliOwner): Promise<void> {
  const config = readCliConfig(configPath), credential = readConnectorCredential(config.credentialFile), lifetime = new AbortController();
  await serveSeekerTools({
    async invoke(origin: NativeInvocation, operation: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
      let response: { status: number; text: string };
      try { response = await privateRequest(config.socketPath, cliRoute, credential, { owner, origin, operation, arguments: args }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000), ...(signal ? [signal] : [])])); }
      catch { throw new ConnectorError("service_unavailable", "Seeker is unavailable or the response was lost. Retain request IDs and inspect the exchange before repeating a mutation.", 503); }
      const result = record(JSON.parse(response.text));
      if (response.status < 200 || response.status >= 300) throw new ConnectorError(typeof result.error === "string" ? result.error : "service_error", typeof result.message === "string" ? result.message : "Seeker rejected this invocation.", response.status);
      return result;
    },
    async close() { lifetime.abort(); },
  });
}
