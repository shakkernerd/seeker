import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ManagerBinding } from "../../contracts.ts";
import type { SeekerCore } from "../../core/seeker.ts";
import { binding as validateBinding } from "../../core/validation.ts";
import { ensureDataDir } from "../../local/config.ts";
import { privateDirectory, readConnectorCredential } from "../codex/config.ts";
import { ConnectorError } from "../codex/protocol.ts";
import type { CodexSetupOptions } from "../codex/setup.ts";
import { installSection, type ConversationPermissions } from "../codex-common/install.ts";
import { listenPrivate } from "../codex-common/listener.ts";
import { cliConfigPath, cliHostId, readCliConfig } from "./config.ts";
import { CodexCliHost } from "./host.ts";

/** Setup fixes the manager; its first genuine MCP invocation admits the original execution owner. */
export function setupCodexCli(options: CodexSetupOptions & { conversationPermissions?: ConversationPermissions }): { binding: ManagerBinding; configPath: string; projectConfigPath: string } {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.threadId)) throw new ConnectorError("invalid_task", "Use the exact existing CLI task ID.");
  const root = privateDirectory(ensureDataDir(options.dataDir)), directory = privateDirectory(ensureDataDir(join(root, "cli")));
  const socketPath = join(directory, "codex.sock"), credentialFile = join(directory, "codex.key"), configPath = cliConfigPath(root);
  if (Buffer.byteLength(socketPath) > 103) throw new ConnectorError("socket_path_too_long", "Choose a shorter Seeker data directory.");
  const project = realpathSync(options.projectDirectory), launcher = join(resolve(options.packageDirectory), "bin", "seeker-codex");
  if (!lstatSync(project).isDirectory()) throw new ConnectorError("invalid_project", "Choose the existing manager's project directory.");
  if (!existsSync(launcher) || !existsSync(join(options.packageDirectory, "dist", "codex-connector.mjs"))) throw new ConnectorError("package_incomplete", "Build or install Seeker before setup.");
  const projectDirectory = join(project, ".codex"), projectConfigPath = join(projectDirectory, "config.toml");
  if ((present(projectDirectory) && !lstatSync(projectDirectory).isDirectory()) || (present(projectConfigPath) && !lstatSync(projectConfigPath).isFile())) throw new ConnectorError("unsafe_project_config", "Preserve unrelated data at the project configuration path.");
  const current = present(projectConfigPath) ? readFileSync(projectConfigPath, "utf8") : "";
  // Both native hosts retain one project MCP entry and separate private registrations.
  const updated = installSection(current, launcher, join(root, "codex-connector.json"), process.execPath, options.conversationPermissions);
  const previous = options.core.managerBinding(cliHostId, options.threadId);
  if (previous && previous.label !== options.label) throw new ConnectorError("setup_conflict", "Preserve this manager's existing label.");
  const binding = validateBinding(previous ? { ...previous, recipient: options.recipient } : { id: `cli-${options.threadId}`, label: options.label, origin: { hostId: cliHostId, managerId: options.threadId, assignmentId: options.threadId, generation: 1 }, recipient: options.recipient });
  if (present(configPath)) readCliConfig(configPath);
  if (present(credentialFile)) readConnectorCredential(credentialFile);
  try {
    const descriptor = openSync(credentialFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(descriptor, `${randomBytes(32).toString("hex")}\n`); } finally { closeSync(descriptor); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  readConnectorCredential(credentialFile);
  if (!present(configPath)) replace(configPath, `${JSON.stringify({ version: 2, hostId: cliHostId, socketPath, credentialFile }, null, 2)}\n`, 0o600);
  mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
  if (updated !== current) replace(projectConfigPath, updated, present(projectConfigPath)?.mode ? lstatSync(projectConfigPath).mode & 0o777 : 0o600);
  if (previous) options.core.setRecipient(binding.id, binding.origin.generation, binding.recipient); else options.core.bind(binding);
  return { binding, configPath, projectConfigPath };
}

export async function loadCodexCliHost(core: SeekerCore, dataDir: string) {
  const configPath = cliConfigPath(dataDir);
  if (!present(configPath)) return;
  const config = readCliConfig(configPath), host = new CodexCliHost(core, readConnectorCredential(config.credentialFile), join(dirname(configPath), "owner.json"));
  try {
    const listener = await listenPrivate(config.socketPath, (request) => host.handle(request));
    let closing: Promise<void> | undefined;
    return { host, close: () => closing ??= (async () => { await host.close(); await listener.close(); })() };
  } catch (error) { await host.close(); throw error; }
}

function present(path: string): Stats | undefined { try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
function replace(path: string, value: string, mode: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, value, { flag: "wx", mode }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
