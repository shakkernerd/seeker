import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Recipient } from "../contracts.ts";
import { SeekerCore } from "../core/seeker.ts";
import { defaultDataDir, ensureDataDir, runtimeVersion } from "../local/config.ts";
import { SqliteExchangeStore } from "../store/sqlite.ts";
import { setupCodex } from "../hosts/codex/setup.ts";
import { setupCodexCli } from "../hosts/codex-cli/setup.ts";
import { prepareCliReload } from "../hosts/codex-cli/reload.ts";
import { conversationPermissionRestrictions, type ConversationPermissions } from "../hosts/codex-common/install.ts";
import { ConnectorError } from "../hosts/codex/protocol.ts";

export interface CodexCommandOptions {
  packageDirectory: string;
  defaultRecipient: Recipient;
  resolveRecipient(dataDir: string, channel: string): Recipient;
}

export async function runCodexCommand(args: string[], options: CodexCommandOptions, host: "desktop" | "cli" = "desktop"): Promise<void> {
  const command = host === "desktop" ? "codex" : "codex-cli";
  const hostHelp = host === "desktop" ? "Make the official @openai/codex npm CLI available as codex on the service PATH. Reload that MCP server through Codex Desktop's supported settings, then start Seeker and use pending from the original manager once to register its native host. Replies return in the background, preserving the selected task and window focus. A private Codex helper uses Desktop's supplied Node runtime and incurs model usage to prepare one notification; Seeker grants only the exact current call. A stopped registered app may open in the background; a running app is never restarted." : "The separate reload command refreshes MCP configuration for ALL loaded tasks on the explicitly selected original Unix app-server. Healthy unchanged connections and in-flight calls remain intact; other pending MCP config changes may activate. It preserves native model and permission settings and checks Seeker readiness for this task. Start Seeker and use pending from the original manager once to qualify automatic recovery. Embedded and network hosts are not eligible for directed recovery.";
  const permissionHelp = host === "cli" ? "\n\nOptional --conversation-permissions preserve|allow|replace defaults to preserve. Allow explicitly preapproves only Seeker submit/get/pending/update and refuses conflicting existing choices before writing. Replace explicitly replaces just those four approval modes. Other settings, server enablement, tool filters, managed gates and command/filesystem permissions stay in force. The grant applies to tasks using this shared project/server entry; Seeker separately admits only registered managers." : "";
  const help = `Usage: seeker ${command} setup --project <directory> --task <native-task-id> --label <name> [--channel <name>] [--data-dir <path>] [--port <number>]${host === "cli" ? "\n       seeker codex-cli reload --project <directory> --task <native-task-id> --socket <original-unix-socket> [--data-dir <path>]" : ""}\n\nRun setup with Seeker stopped. It registers this manager and updates only the project's shared Seeker MCP entry. ${hostHelp} Existing task identity, model and command/filesystem policies are retained. An explicit channel selection changes future questions only; existing exchanges keep their original route.${permissionHelp}`;
  if (!args.length || args.includes("--help")) { console.log(help); return; }
  const action = args.shift();
  if (action !== "setup" && !(host === "cli" && action === "reload")) throw new ConnectorError("unknown_command", help);
  if (Bun.version !== runtimeVersion) throw new ConnectorError("runtime_version", `Use qualified Bun ${runtimeVersion}.`);
  const input: Record<string, string> = {};
  while (args.length) {
    const option = args.shift()!, value = args.shift();
    const allowed = action === "reload" ? ["--project", "--task", "--socket", "--data-dir"] : ["--project", "--task", "--label", "--channel", "--data-dir", "--port", ...(host === "cli" ? ["--conversation-permissions"] : [])];
    if (!value || value.startsWith("--") || !allowed.includes(option) || input[option] !== undefined) throw new ConnectorError("invalid_option", help);
    input[option] = value;
  }
  if (!input["--project"] || !input["--task"] || (action === "setup" && !input["--label"]) || (action === "reload" && !input["--socket"])) throw new ConnectorError("missing_option", help);
  const permissions = input["--conversation-permissions"] ?? "preserve";
  if (!["preserve", "allow", "replace"].includes(permissions)) throw new ConnectorError("invalid_option", "Choose preserve, allow or replace for Seeker conversation permissions.");
  const dataDir = ensureDataDir(input["--data-dir"] ?? defaultDataDir());
  const port = Number(input["--port"] ?? process.env.SEEKER_PORT ?? 4317);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new ConnectorError("invalid_port", "Use a local inbox port from 0 to 65535.");
  const store = new SqliteExchangeStore(join(dataDir, "exchanges.sqlite"));
  let reload: Awaited<ReturnType<typeof prepareCliReload>> | undefined;
  try {
    const core = new SeekerCore(store);
    const previous = core.managerBinding(host === "desktop" ? "codex-desktop" : "codex-cli", input["--task"]);
    if (action === "reload") {
      if (!previous) throw new ConnectorError("origin_denied", "Run CLI setup for this exact existing manager before refreshing its host.", 403);
      reload = await prepareCliReload(input["--socket"]!, input["--task"], input["--project"]);
      await reload.reload();
      console.log("Native MCP configuration reloaded. Seeker is connected for this task and its four tool definitions are listed. Invoke pending in the original task to confirm service admission; native permission gates still apply.");
      return;
    }
    const recipient = input["--channel"] ? options.resolveRecipient(dataDir, input["--channel"]) : previous?.recipient ?? options.defaultRecipient;
    const setup = { core, dataDir, packageDirectory: options.packageDirectory, projectDirectory: input["--project"], threadId: input["--task"], label: input["--label"]!, recipient };
    const result = host === "desktop" ? setupCodex(setup) : setupCodexCli({ ...setup, conversationPermissions: permissions as ConversationPermissions });
    if (host === "cli" && permissions !== "preserve") {
      console.log("Native conversation approval configured for Seeker submit/get/pending/update in this project's shared server entry. Seeker still admits only registered managers.");
      const restrictions = conversationPermissionRestrictions(readFileSync(result.projectConfigPath, "utf8"));
      if (restrictions.length) console.log(`Native restrictions remain: ${restrictions.join("; ")}. Unattended readiness is not confirmed.`);
    }
    const quotedDirectory = `'${dataDir.replaceAll("'", "'\\''")}'`;
    console.log(`Registered ${result.binding.label} for ${result.binding.recipient.channelId}.\nProject MCP configuration: ${result.projectConfigPath}\n${host === "desktop" ? "Reload the Seeker MCP server in the original Codex Desktop host, preserving this task." : "Use seeker codex-cli reload with the same --project, --task and --data-dir plus its original --socket to explicitly refresh that host's loaded MCP configurations."}\nStart the service: seeker start --data-dir ${quotedDirectory} --port ${port}\nIn the original manager task, use Seeker's pending tool once to confirm admission and register automatic ${host === "desktop" ? "Desktop" : "CLI"} recovery.`);
  } finally { reload?.close(); store.close(); }
}
