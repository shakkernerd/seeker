import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fail } from "../core/validation.ts";
import { prepareNativeRegistration } from "../hosts/codex/setup.ts";
import { atomicWrite, layout, present, regular } from "./layout.ts";
import { verifyInstallation } from "./application.ts";

const eventTools = ["event_arm", "event_get", "event_pending", "event_cancel", "event_resume", "event_acknowledge", "event_clear"];
/** Explicit event-only installation; human-manager admission remains project-owned. */
export function connectEvents(home: string, configPath: string, dryRun = false) {
  verifyInstallation(home);
  const p = layout(home), path = resolve(configPath), privateConfig = join(p.home, "codex-connector.json");
  if (present(path)) regular(path);
  const current = present(path) ? readFileSync(path, "utf8") : "";
  const parsed = Bun.TOML.parse(current) as { mcp_servers?: Record<string, { command?: string; args?: string[] }> };
  const existing = parsed.mcp_servers?.seeker_events;
  if (existing && (existing.command !== join(p.bin, "seeker-codex") || JSON.stringify(existing.args) !== JSON.stringify(["--config", privateConfig, "--runtime", p.runtime]))) fail("connector_conflict", "The existing event connector uses another installation. Use explicit migration; its permissions were preserved.");
  const result = existing ? current : `${current}${current.endsWith("\n") || !current ? "" : "\n"}\n# Seeker native background events\n[mcp_servers.seeker_events]\ncommand = ${JSON.stringify(join(p.bin, "seeker-codex"))}\nargs = ${JSON.stringify(["--config", privateConfig, "--runtime", p.runtime])}\nenv_vars = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_SQLITE_HOME"]\nenabled = true\nrequired = false\nstartup_timeout_sec = 10\ntool_timeout_sec = 15\nenabled_tools = ${JSON.stringify(eventTools)}\n`;
  Bun.TOML.parse(result);
  const plan = { config: path, connector: privateConfig, changed: result !== current, managerRegistration: "unchanged", reload: "Reload this MCP server through the original host; then invoke event_pending in a native task." };
  if (dryRun) return plan;
  if (present(join(p.home, ".installation-lock"))) fail("install_busy", "Finish installation or migration before connector setup.");
  prepareNativeRegistration(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (result !== current) atomicWrite(path, result, present(path) ? present(path)!.mode & 0o777 : 0o600);
  return plan;
}
