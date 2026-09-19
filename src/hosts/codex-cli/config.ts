import { join } from "node:path";
import { readConnectorConfig, type CodexConnectorConfig } from "../codex/config.ts";
import { ConnectorError } from "../codex/protocol.ts";

export const cliHostId = "codex-cli";
export const cliRoute = "/api/hosts/codex-cli/invoke";
export const cliConfigPath = (dataDir: string) => join(dataDir, "cli", "codex-connector.json");
export function readCliConfig(path: string): CodexConnectorConfig {
  const config = readConnectorConfig(path);
  if (config.hostId !== cliHostId) throw new ConnectorError("wrong_host", "This is not the private CLI host registration.");
  return config;
}
