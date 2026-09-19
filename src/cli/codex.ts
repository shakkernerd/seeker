import { join } from "node:path";
import type { Recipient } from "../contracts.ts";
import { SeekerCore } from "../core/seeker.ts";
import { defaultDataDir, ensureDataDir, runtimeVersion } from "../local/config.ts";
import { SqliteExchangeStore } from "../store/sqlite.ts";
import { setupCodex } from "../hosts/codex/setup.ts";
import { ConnectorError } from "../hosts/codex/protocol.ts";

export interface CodexCommandOptions {
  packageDirectory: string;
  defaultRecipient: Recipient;
  resolveRecipient(dataDir: string, channel: string): Recipient;
}

export async function runCodexCommand(args: string[], options: CodexCommandOptions): Promise<void> {
  const help = "Usage: seeker codex setup --project <directory> --task <native-task-id> --label <name> [--channel <name>] [--data-dir <path>] [--port <number>]\n\nRun setup with Seeker stopped. It registers this manager and adds only the project's Seeker MCP entry. Reload that MCP server through Codex Desktop's supported settings, then start Seeker. Use pending from the original manager once to register its native host for automatic task resumption. Desktop may open or come to the foreground when a saved reply needs that task. Existing task identity and permissions are retained. An explicit channel selection changes future questions only; existing exchanges keep their original route.";
  if (!args.length || args.includes("--help")) { console.log(help); return; }
  if (args.shift() !== "setup") throw new ConnectorError("unknown_command", help);
  if (Bun.version !== runtimeVersion) throw new ConnectorError("runtime_version", `Use qualified Bun ${runtimeVersion}.`);
  const input: Record<string, string> = {};
  while (args.length) {
    const option = args.shift()!, value = args.shift();
    if (!value || value.startsWith("--") || !["--project", "--task", "--label", "--channel", "--data-dir", "--port"].includes(option) || input[option] !== undefined) throw new ConnectorError("invalid_option", help);
    input[option] = value;
  }
  if (!input["--project"] || !input["--task"] || !input["--label"]) throw new ConnectorError("missing_option", help);
  const dataDir = ensureDataDir(input["--data-dir"] ?? defaultDataDir());
  const port = Number(input["--port"] ?? process.env.SEEKER_PORT ?? 4317);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new ConnectorError("invalid_port", "Use a local inbox port from 0 to 65535.");
  const store = new SqliteExchangeStore(join(dataDir, "exchanges.sqlite"));
  try {
    const core = new SeekerCore(store);
    const previous = core.managerBinding("codex-desktop", input["--task"]);
    const recipient = input["--channel"] ? options.resolveRecipient(dataDir, input["--channel"]) : previous?.recipient ?? options.defaultRecipient;
    const result = setupCodex({ core, dataDir, packageDirectory: options.packageDirectory, projectDirectory: input["--project"], threadId: input["--task"], label: input["--label"], recipient });
    const quotedDirectory = `'${dataDir.replaceAll("'", "'\\''")}'`;
    console.log(`Registered ${result.binding.label} for ${result.binding.recipient.channelId}.\nProject MCP configuration: ${result.projectConfigPath}\nReload the Seeker MCP server in Codex Desktop, preserving this task.\nStart the service: seeker start --data-dir ${quotedDirectory} --port ${port}\nIn the original manager task, use Seeker's pending tool once to confirm admission and register automatic Desktop recovery.`);
  } finally { store.close(); }
}
