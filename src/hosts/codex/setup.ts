import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import type { ManagerBinding, Recipient } from "../../contracts.ts";
import type { SeekerCore } from "../../core/seeker.ts";
import { binding as validateBinding } from "../../core/validation.ts";
import { ensureDataDir } from "../../local/config.ts";
import { privateDirectory, readConnectorConfig, readConnectorCredential, readPrivateFile } from "./config.ts";
import { CodexHostAdapter } from "./host.ts";
import { DesktopHelperDelivery } from "./helper-delivery.ts";
import { NativeDesktopHelper } from "./helper-runtime.ts";
import { CodexDesktopLifecycle } from "./desktop.ts";
import { ConnectorError } from "./protocol.ts";
import { installSection } from "../codex-common/install.ts";
import { listenPrivate } from "../codex-common/listener.ts";
export { installSection } from "../codex-common/install.ts";

const hostId = "codex-desktop";

export interface CodexSetupOptions {
  core: SeekerCore;
  dataDir: string;
  projectDirectory: string;
  packageDirectory: string;
  threadId: string;
  label: string;
  recipient: Recipient;
}

/** Explicit operator setup: registers one manager and edits only Seeker's project MCP section. */
export function setupCodex(options: CodexSetupOptions): { binding: ManagerBinding; configPath: string; projectConfigPath: string } {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.threadId)) throw new ConnectorError("invalid_task", "Copy the exact existing native task ID; titles and workspace paths are not identities.");
  const directory = privateDirectory(ensureDataDir(options.dataDir));
  const socketPath = join(directory, "codex.sock");
  if (Buffer.byteLength(socketPath) > 103) throw new ConnectorError("socket_path_too_long", "Choose a shorter Seeker data directory for the private native socket.");
  const project = realpathSync(options.projectDirectory);
  if (!lstatSync(project).isDirectory()) throw new ConnectorError("invalid_project", "Choose the existing manager's project directory.");
  const launcher = join(resolve(options.packageDirectory), "bin", "seeker-codex");
  if (!existsSync(launcher) || !existsSync(join(options.packageDirectory, "dist", "codex-connector.mjs"))) throw new ConnectorError("package_incomplete", "Install a built Seeker package, or run the package build before setup.");
  const projectConfigDirectory = join(project, ".codex");
  if (statIfPresent(projectConfigDirectory) && !lstatSync(projectConfigDirectory).isDirectory()) throw new ConnectorError("unsafe_project_config", "The project .codex path must be a real directory.");
  const projectConfigPath = join(projectConfigDirectory, "config.toml");
  if (statIfPresent(projectConfigPath) && !lstatSync(projectConfigPath).isFile()) throw new ConnectorError("unsafe_project_config", "The project configuration must be a regular file.");
  const current = statIfPresent(projectConfigPath) ? readFileSync(projectConfigPath, "utf8") : "";
  const configPath = join(directory, "codex-connector.json");
  const credentialFile = join(directory, "codex.key");
  const projectConfig = installSection(current, launcher, configPath);
  const previousBinding = options.core.managerBinding(hostId, options.threadId);
  if (previousBinding && previousBinding.label !== options.label) throw new ConnectorError("setup_conflict", "This manager already has a different label. Preserve its existing registration.");
  const binding = validateBinding(previousBinding ? { ...previousBinding, recipient: options.recipient } : { id: `codex-${options.threadId}`, label: options.label, origin: { hostId, managerId: options.threadId, assignmentId: options.threadId, generation: 1 }, recipient: options.recipient });
  let upgrade = false;
  if (statIfPresent(configPath)) {
    const existing = JSON.parse(readPrivateFile(configPath));
    upgrade = existing.version === 1 && existing.hostId === hostId && realpathSync(existing.credentialFile) === credentialFile;
    if (!upgrade) {
      const config = readConnectorConfig(configPath);
      if (config.hostId !== hostId || config.socketPath !== socketPath || config.credentialFile !== credentialFile) throw new ConnectorError("setup_conflict", "This data directory already has a different native registration.");
    }
  }
  if (statIfPresent(credentialFile)) readConnectorCredential(credentialFile);
  try {
    const descriptor = openSync(credentialFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(descriptor, `${randomBytes(32).toString("hex")}\n`); } finally { closeSync(descriptor); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  readConnectorCredential(credentialFile);
  if (!statIfPresent(configPath) || upgrade) {
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, `${JSON.stringify({ version: 2, hostId, socketPath, credentialFile }, null, 2)}\n`, { mode: 0o600, flag: "wx" }); renameSync(temporary, configPath); }
    finally { try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ } }
  }
  mkdirSync(projectConfigDirectory, { recursive: true, mode: 0o700 });
  if (projectConfig !== current) {
    const temporary = join(projectConfigDirectory, `.seeker-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, projectConfig, { mode: existsSync(projectConfigPath) ? lstatSync(projectConfigPath).mode & 0o777 : 0o600, flag: "wx" });
      renameSync(temporary, projectConfigPath);
    } finally { try { unlinkSync(temporary); } catch { /* Successful rename removed the temporary file. */ } }
  }
  if (previousBinding) options.core.setRecipient(binding.id, binding.origin.generation, binding.recipient);
  else options.core.bind(binding);
  return { binding, configPath, projectConfigPath };
}

export async function loadCodexHost(core: SeekerCore, dataDir: string) {
  const path = join(dataDir, "codex-connector.json");
  if (!statIfPresent(path)) return;
  const config = readConnectorConfig(path);
  const lifecycle = new CodexDesktopLifecycle(join(dataDir, "codex-desktop.json"));
  const input = new DesktopHelperDelivery(core, new NativeDesktopHelper(lifecycle, dataDir));
  const host = new CodexHostAdapter(config.hostId, readConnectorCredential(config.credentialFile), { binding: (managerId) => core.managerBinding(config.hostId, managerId), manager: (origin) => core.manager(origin) }, lifecycle, input);
  try {
    const listener = await listenPrivate(config.socketPath, async (request) => await host.handle(request) ?? new Response(null, { status: 404 }));
    let closing: Promise<void> | undefined;
    return { host, close: () => closing ??= (async () => {
      const results = await Promise.allSettled([host.close(), listener.close()]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    })() };
  } catch (error) { await host.close().catch(() => {}); throw error; }
}

function statIfPresent(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
