import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { runCodexConnector } from "../codex/connector.ts";
import { captureDesktopOwner } from "../codex/desktop-owner.ts";
import { ConnectorError } from "../codex/protocol.ts";
import { cliConfigPath } from "../codex-cli/config.ts";
import { runCliConnector } from "../codex-cli/connector.ts";
import { captureCliOwner } from "../codex-cli/owner.ts";
import { serveSeekerTools } from "./mcp.ts";

/** Positive native ancestry selects a host. Inherited Desktop variables never do. */
export async function runNativeConnector(configPath: string): Promise<void> {
  const desktop = await captureDesktopOwner().catch(() => undefined);
  if (desktop) {
    if (existsSync(configPath)) return runCodexConnector(configPath, desktop);
    return unavailable("Run seeker codex setup to register this existing Desktop manager.");
  }
  const cli = await captureCliOwner().catch(() => undefined);
  if (cli) {
    const cliPath = cliConfigPath(dirname(configPath));
    if (existsSync(cliPath)) return runCliConnector(cliPath, cli);
    return unavailable("Run seeker codex-cli setup to register this existing CLI manager.");
  }
  return unavailable("Seeker needs the original native Desktop host or a qualified local CLI Unix app-server. An embedded CLI cannot receive directed replies; preserve the existing session when selecting its supported native host.");
}
async function unavailable(message: string): Promise<void> {
  // A shared project may have managers registered in only one of its hosts.
  // MCP still initializes normally; tool calls give the relevant setup action.
  await serveSeekerTools({ async invoke() { throw new ConnectorError("native_host_unregistered", message, 403); }, close() {} });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--config") { console.error("Use seeker codex setup or seeker codex-cli setup to configure the native connector."); process.exitCode = 1; }
  else await runNativeConnector(args[1]!).catch(() => { console.error("Seeker's native connector could not start. Check its private configuration and host runtime."); process.exitCode = 1; });
}
