import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fail } from "../core/validation.ts";
import { prepareCliRegistration } from "../hosts/codex-cli/setup.ts";
import { prepareNativeRegistration } from "../hosts/codex/setup.ts";
import { atomicWrite, layout, present, regular } from "./layout.ts";
import { verifyInstallation } from "./application.ts";

const eventTools = ["event_arm", "event_watch", "event_get", "event_pending", "event_cancel", "event_acknowledge", "event_clear"];
/** Tool lists this installer wrote in earlier releases; only these are rewritten on upgrade, a custom filter is preserved. */
const generatedToolLists = [
  ["event_arm", "event_get", "event_pending", "event_cancel", "event_resume", "event_acknowledge", "event_clear"],
  ["event_arm", "event_get", "event_pending", "event_cancel", "event_acknowledge", "event_clear"],
];
function upgradeToolList(current: string, existing: { enabled_tools?: unknown }): string {
  const list = existing.enabled_tools;
  if (!Array.isArray(list) || !generatedToolLists.some((known) => JSON.stringify(known) === JSON.stringify(list))) return current;
  // The actual table header, at the start of its own line; a mention inside a comment or another table is not it.
  const header = /^[ \t]*\[mcp_servers\.seeker_events\][ \t]*(?:#.*)?$/m.exec(current);
  if (!header) return current;
  const start = header.index + header[0].length;
  const rest = current.slice(start), nextTable = /^[ \t]*\[/m.exec(rest);
  const section = rest.slice(0, nextTable ? nextTable.index : undefined);
  const upgraded = section.replace(/^[ \t]*enabled_tools[ \t]*=[ \t]*\[[^\n]*\][ \t]*$/m, `enabled_tools = ${JSON.stringify(eventTools)}`);
  if (upgraded === section) return current;
  const result = current.slice(0, start) + upgraded + (nextTable ? rest.slice(nextTable.index) : "");
  // Prove the rewrite changed that one setting and nothing else before offering it.
  const before = Bun.TOML.parse(current) as Record<string, unknown>, after = Bun.TOML.parse(result) as Record<string, unknown>;
  const strip = (value: Record<string, unknown>) => { const copy = structuredClone(value) as { mcp_servers?: Record<string, Record<string, unknown>> }; delete copy.mcp_servers?.seeker_events?.enabled_tools; return JSON.stringify(copy); };
  const upgradedList = (after as { mcp_servers?: Record<string, { enabled_tools?: unknown }> }).mcp_servers?.seeker_events?.enabled_tools;
  if (strip(before) !== strip(after) || JSON.stringify(upgradedList) !== JSON.stringify(eventTools)) return current;
  return result;
}
/** Explicit event-only installation; human-manager admission remains project-owned. */
export function connectEvents(home: string, configPath: string, dryRun = false) {
  verifyInstallation(home);
  const p = layout(home), path = resolve(configPath), privateConfig = join(p.home, "codex-connector.json");
  if (present(path)) regular(path);
  const current = present(path) ? readFileSync(path, "utf8") : "";
  const parsed = Bun.TOML.parse(current) as { mcp_servers?: Record<string, { command?: string; args?: string[]; enabled_tools?: unknown }> };
  const existing = parsed.mcp_servers?.seeker_events;
  if (existing && (existing.command !== join(p.bin, "seeker-codex") || JSON.stringify(existing.args) !== JSON.stringify(["--config", privateConfig, "--runtime", p.runtime]))) fail("connector_conflict", "The existing event connector uses another installation. Use explicit migration; its permissions were preserved.");
  const result = existing ? upgradeToolList(current, existing) : `${current}${current.endsWith("\n") || !current ? "" : "\n"}\n# Seeker native background events\n[mcp_servers.seeker_events]\ncommand = ${JSON.stringify(join(p.bin, "seeker-codex"))}\nargs = ${JSON.stringify(["--config", privateConfig, "--runtime", p.runtime])}\nenv_vars = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_SQLITE_HOME"]\nenabled = true\nrequired = false\nstartup_timeout_sec = 10\ntool_timeout_sec = 15\nenabled_tools = ${JSON.stringify(eventTools)}\n`;
  Bun.TOML.parse(result);
  const toolsPreserved = Boolean(existing && result === current && Array.isArray(existing.enabled_tools) && JSON.stringify(existing.enabled_tools) !== JSON.stringify(eventTools));
  const plan = { config: path, connector: privateConfig, changed: result !== current, ...(toolsPreserved ? { enabledTools: "custom list preserved; add event_watch yourself to use watches" } : {}), managerRegistration: "unchanged", reload: "Reload this MCP server through the original host; then invoke event_pending in a native task." };
  if (dryRun) return plan;
  if (present(join(p.home, ".installation-lock"))) fail("install_busy", "Finish installation or migration before connector setup.");
  prepareNativeRegistration(home);
  prepareCliRegistration(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (result !== current) atomicWrite(path, result, present(path) ? present(path)!.mode & 0o777 : 0o600);
  return plan;
}
