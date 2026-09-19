import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { ConnectorError } from "../codex/protocol.ts";

const startMarker = "# Seeker native connector: begin";
const endMarker = "# Seeker native connector: end";
const legacyEnvironment = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH"];
const environment = [...legacyEnvironment, "CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_SQLITE_HOME"];
const runtimePath = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && !/[\0\r\n]/.test(value);
function executableRuntime(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; }
  catch { return false; }
}
const conversationTools = ["submit", "get", "pending", "update"] as const;
const approvalModes = ["auto", "prompt", "writes", "approve"] as const;
const permissionKeys = ["default_tools_approval_mode", "enabled_tools", "disabled_tools", "tools"] as const;
export type ConversationPermissions = "preserve" | "allow" | "replace";
type ApprovalMode = typeof approvalModes[number];
interface ToolSettings { approval_mode?: ApprovalMode; output_token_limit?: number }
interface NativePermissions {
  default_tools_approval_mode?: ApprovalMode;
  enabled_tools?: string[];
  disabled_tools?: string[];
  tools?: Record<string, ToolSettings>;
}
function table(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function readPermissions(seeker: Record<string, unknown>): NativePermissions {
  const result: NativePermissions = {};
  const approval = (value: unknown): ApprovalMode => {
    if (typeof value !== "string" || !approvalModes.includes(value as ApprovalMode)) throw new ConnectorError("setup_conflict", "The Seeker approval mode is invalid. Preserve or reconcile its permissions before setup.");
    return value as ApprovalMode;
  };
  if (seeker.default_tools_approval_mode !== undefined) result.default_tools_approval_mode = approval(seeker.default_tools_approval_mode);
  for (const key of ["enabled_tools", "disabled_tools"] as const) {
    const value = seeker[key];
    if (value !== undefined) {
      if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) throw new ConnectorError("setup_conflict", "The Seeker tool filters are invalid. Preserve or reconcile them before setup.");
      result[key] = [...value];
    }
  }
  if (seeker.tools !== undefined) {
    if (!table(seeker.tools)) throw new ConnectorError("setup_conflict", "The Seeker tool settings are invalid.");
    const tools: Record<string, ToolSettings> = Object.create(null);
    for (const [name, value] of Object.entries(seeker.tools)) {
      if (!table(value) || Object.keys(value).some((key) => !["approval_mode", "output_token_limit"].includes(key))) throw new ConnectorError("setup_conflict", "The Seeker section contains custom tool settings. Preserve or reconcile them before setup.");
      const settings: ToolSettings = {};
      if (value.approval_mode !== undefined) settings.approval_mode = approval(value.approval_mode);
      if (value.output_token_limit !== undefined) {
        if (!Number.isSafeInteger(value.output_token_limit) || (value.output_token_limit as number) <= 0) throw new ConnectorError("setup_conflict", "The Seeker tool output limit must be a positive integer.");
        settings.output_token_limit = value.output_token_limit as number;
      }
      tools[name] = settings;
    }
    result.tools = tools;
  }
  return result;
}
function restrictions(enabled: unknown, permissions: NativePermissions, requireExplicitGrant: boolean): string[] {
  if (enabled !== undefined && typeof enabled !== "boolean") throw new ConnectorError("setup_conflict", "The Seeker lifecycle settings are invalid.");
  const result: string[] = enabled === false ? ["The Seeker connector is disabled (enabled = false)."] : [];
  for (const name of conversationTools) {
    if (permissions.enabled_tools && !permissions.enabled_tools.includes(name)) result.push(`Seeker ${name} is excluded by enabled_tools.`);
    if (permissions.disabled_tools?.includes(name)) result.push(`Seeker ${name} is disabled by disabled_tools.`);
    const mode = permissions.tools?.[name]?.approval_mode ?? permissions.default_tools_approval_mode;
    if ((mode !== undefined || requireExplicitGrant) && mode !== "approve") result.push(`Seeker ${name} uses approval_mode = "${mode ?? "auto"}".`);
  }
  return result;
}

/** Reports gaps in the explicit four-tool grant, not native runtime readiness. */
export function conversationPermissionRestrictions(config: string): string[] {
  const parsed = Bun.TOML.parse(config) as Record<string, unknown>;
  if (parsed.mcp_servers === undefined) return ["The Seeker connector is not configured."];
  if (!table(parsed.mcp_servers)) throw new ConnectorError("setup_conflict", "The MCP server configuration is invalid.");
  const seeker = parsed.mcp_servers.seeker;
  if (seeker === undefined) return ["The Seeker connector is not configured."];
  if (!table(seeker)) throw new ConnectorError("setup_conflict", "The Seeker configuration is invalid.");
  return restrictions(seeker.enabled, readPermissions(seeker), true);
}

/** The caller qualifies Bun. Its recorded path selects an interpreter, never a host or manager. */
export function installSection(current: string, launcher: string, configPath: string, bunRuntime = process.execPath, permissions: ConversationPermissions = "preserve"): string {
  if (!runtimePath(bunRuntime)) throw new ConnectorError("invalid_runtime", "Use an absolute path to the qualified Bun runtime.");
  if (!["preserve", "allow", "replace"].includes(permissions)) throw new ConnectorError("invalid_permissions", "Conversation permissions must be preserve, allow or replace.");
  const begin = current.indexOf(startMarker), end = current.indexOf(endMarker);
  const parsed = Bun.TOML.parse(current) as { mcp_servers?: Record<string, unknown> };
  const settings = { enabled: true, required: false, startup_timeout_sec: 10, tool_timeout_sec: 15 };
  let nativePermissions: NativePermissions = {};
  if ((begin < 0) !== (end < 0) || (begin >= 0 && (end < begin || current.indexOf(startMarker, begin + startMarker.length) >= 0 || current.indexOf(endMarker, end + endMarker.length) >= 0))) throw new ConnectorError("setup_conflict", "The existing Seeker configuration markers need manual reconciliation.");
  if (parsed.mcp_servers?.seeker && begin < 0) throw new ConnectorError("setup_conflict", "A project MCP server named seeker already exists. Preserve or reconcile it before setup.");
  if (begin >= 0) {
    const block = Bun.TOML.parse(current.slice(begin, end)) as Record<string, unknown>;
    const servers = block.mcp_servers as Record<string, unknown> | undefined;
    const seeker = servers?.seeker as Record<string, unknown> | undefined;
    if (Object.keys(block).some((key) => key !== "mcp_servers") || !servers || Object.keys(servers).some((key) => key !== "seeker") || !table(seeker) || Object.keys(seeker).some((key) => !["command", "args", "env_vars", "enabled", "required", "startup_timeout_sec", "tool_timeout_sec", ...permissionKeys].includes(key)) || JSON.stringify(parsed.mcp_servers?.seeker) !== JSON.stringify(seeker)) throw new ConnectorError("setup_conflict", "The Seeker section contains custom settings. Preserve or reconcile them before setup.");
    const args = seeker.args;
    const legacyArgs = Array.isArray(args) && args.length === 2;
    const recordedRuntime = Array.isArray(args) && args.length === 4 && args[2] === "--runtime" && runtimePath(args[3]);
    if (typeof seeker.command !== "string" || !seeker.command.endsWith("/bin/seeker-codex") || !Array.isArray(args) || (!legacyArgs && !recordedRuntime) || args[0] !== "--config" || ![environment, legacyEnvironment].some((value) => JSON.stringify(seeker.env_vars) === JSON.stringify(value))) throw new ConnectorError("setup_conflict", "The Seeker launcher or environment was customized. Preserve or reconcile it before setup.");
    if (args[1] !== configPath) throw new ConnectorError("setup_conflict", "This project already uses a different Seeker data directory. Preserve that connection rather than redirecting every task.");
    // Preserve a usable fallback across Desktop and CLI setup; repair an
    // unavailable one with the caller's qualified runtime, matching the launcher's -x check.
    if (recordedRuntime && executableRuntime(args[3] as string)) bunRuntime = args[3] as string;
    for (const key of ["enabled", "required"] as const) {
      if (seeker[key] !== undefined) {
        if (typeof seeker[key] !== "boolean") throw new ConnectorError("setup_conflict", "The Seeker lifecycle settings are invalid.");
        settings[key] = seeker[key];
      }
    }
    for (const key of ["startup_timeout_sec", "tool_timeout_sec"] as const) {
      if (seeker[key] !== undefined) {
        if (typeof seeker[key] !== "number" || !Number.isFinite(seeker[key]) || seeker[key] <= 0) throw new ConnectorError("setup_conflict", "The Seeker timeout settings are invalid.");
        settings[key] = seeker[key];
      }
    }
    nativePermissions = readPermissions(seeker);
  }
  if (permissions === "allow") {
    const conflicts = restrictions(settings.enabled, nativePermissions, false);
    if (conflicts.length) throw new ConnectorError("permission_conflict", `${conflicts.join(" ")} Preserve the configuration or explicitly replace the four conversation approval modes; replacement keeps enable/filter restrictions.`);
  }
  if (permissions !== "preserve") {
    const tools = nativePermissions.tools ??= Object.create(null) as Record<string, ToolSettings>;
    for (const name of conversationTools) tools[name] = { ...tools[name], approval_mode: "approve" };
  }
  const permissionLines = Object.entries(nativePermissions).filter(([key]) => key !== "tools").map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
  if (nativePermissions.tools !== undefined) permissionLines.push("[mcp_servers.seeker.tools]", ...Object.entries(nativePermissions.tools).map(([name, values]) => `${JSON.stringify(name)} = { ${Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(", ")} }`));
  const section = [startMarker, "[mcp_servers.seeker]", `command = ${JSON.stringify(launcher)}`, `args = ["--config", ${JSON.stringify(configPath)}, "--runtime", ${JSON.stringify(bunRuntime)}]`, `env_vars = ${JSON.stringify(environment)}`, ...Object.entries(settings).map(([key, value]) => `${key} = ${value}`), ...permissionLines, endMarker].join("\n");
  const result = begin < 0 ? `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${section}\n` : `${current.slice(0, begin)}${section}${current.slice(end + endMarker.length)}`;
  Bun.TOML.parse(result);
  return result;
}
