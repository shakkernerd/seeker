import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import type { ManagerBinding, Recipient } from "../../contracts.ts";
import type { SeekerCore } from "../../core/seeker.ts";
import { binding as validateBinding } from "../../core/validation.ts";
import { ensureDataDir } from "../../local/config.ts";
import { privateDirectory, readConnectorConfig, readConnectorCredential, readPrivateFile } from "./config.ts";
import { CodexHostAdapter } from "./host.ts";
import { ConnectorError } from "./protocol.ts";

const hostId = "codex-desktop";
const startMarker = "# Seeker native connector: begin";
const endMarker = "# Seeker native connector: end";

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

export function installSection(current: string, launcher: string, configPath: string): string {
  const begin = current.indexOf(startMarker), end = current.indexOf(endMarker);
  const parsed = Bun.TOML.parse(current) as { mcp_servers?: Record<string, unknown> };
  const environment = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH"];
  const settings = { enabled: true, required: false, startup_timeout_sec: 10, tool_timeout_sec: 15 };
  if ((begin < 0) !== (end < 0) || (begin >= 0 && (end < begin || current.indexOf(startMarker, begin + startMarker.length) >= 0))) throw new ConnectorError("setup_conflict", "The existing Seeker configuration markers need manual reconciliation.");
  if (parsed.mcp_servers?.seeker && begin < 0) throw new ConnectorError("setup_conflict", "A project MCP server named seeker already exists. Preserve or reconcile it before setup.");
  if (begin >= 0) {
    const block = Bun.TOML.parse(current.slice(begin, end)) as Record<string, unknown>;
    const servers = block.mcp_servers as Record<string, unknown> | undefined;
    const seeker = servers?.seeker as Record<string, unknown> | undefined;
    if (Object.keys(block).some((key) => key !== "mcp_servers") || !servers || Object.keys(servers).some((key) => key !== "seeker") || !seeker || Object.keys(seeker).some((key) => !["command", "args", "env_vars", "enabled", "required", "startup_timeout_sec", "tool_timeout_sec"].includes(key))) throw new ConnectorError("setup_conflict", "The Seeker section contains custom settings. Preserve or reconcile them before setup.");
    if (typeof seeker.command !== "string" || !seeker.command.endsWith("/bin/seeker-codex") || !Array.isArray(seeker.args) || seeker.args.length !== 2 || seeker.args[0] !== "--config" || JSON.stringify(seeker.env_vars) !== JSON.stringify(environment)) throw new ConnectorError("setup_conflict", "The Seeker launcher or environment was customized. Preserve or reconcile it before setup.");
    if (seeker.args[1] !== configPath) throw new ConnectorError("setup_conflict", "This project already uses a different Seeker data directory. Preserve that connection rather than redirecting every task.");
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
  }
  const section = [startMarker, "[mcp_servers.seeker]", `command = ${JSON.stringify(launcher)}`, `args = ["--config", ${JSON.stringify(configPath)}]`, `env_vars = ${JSON.stringify(environment)}`, ...Object.entries(settings).map(([key, value]) => `${key} = ${value}`), endMarker].join("\n");
  const result = begin < 0 ? `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${section}\n` : `${current.slice(0, begin)}${section}${current.slice(end + endMarker.length)}`;
  Bun.TOML.parse(result);
  return result;
}

export async function loadCodexHost(core: SeekerCore, dataDir: string) {
  const path = join(dataDir, "codex-connector.json");
  if (!statIfPresent(path)) return;
  const config = readConnectorConfig(path);
  const host = new CodexHostAdapter(config.hostId, readConnectorCredential(config.credentialFile), { binding: (managerId) => core.managerBinding(config.hostId, managerId), manager: (origin) => core.manager(origin) }, 4_500, () => { core.resumeHost(config.hostId); });
  let listener: Bun.Server<undefined> | undefined;
  let published: Stats | undefined;
  const removePublished = () => {
    const current = statIfPresent(config.socketPath);
    if (published && current?.dev === published.dev && current.ino === published.ino) unlinkSync(config.socketPath);
  };
  try {
    await prepareSocket(config.socketPath);
    // Bun unlinks its bind address during stop. Keep that address private and
    // publish a separate hard link so only our inode check can remove codex.sock.
    const staging = join(privateDirectory(dataDir), `.s${randomBytes(6).toString("base64url")}`);
    if (statIfPresent(staging)) throw new ConnectorError("socket_conflict", "The temporary native socket address is already in use.");
    const server = Bun.serve({ unix: staging, maxRequestBodySize: 65_536, fetch: async (request, nativeServer) => {
      nativeServer.timeout(request, 30);
      return await host.handle(request) ?? new Response(null, { status: 404 });
    } });
    listener = server;
    chmodSync(staging, 0o600);
    const owned = lstatSync(staging);
    linkSync(staging, config.socketPath); // Fails without replacing a newly appeared path.
    published = owned;
    unlinkSync(staging);
    let closing: Promise<void> | undefined;
    return { host, close: () => closing ??= (async () => {
      host.close(); await server.stop(true);
      removePublished();
    })() };
  } catch (error) { host.close(); await listener?.stop(true); removePublished(); throw error; }
}

async function prepareSocket(path: string): Promise<void> {
  const stat = statIfPresent(path);
  if (!stat) return;
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new ConnectorError("socket_conflict", "The private native socket path contains unrelated data.");
  const stale = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new ConnectorError("socket_busy", "The existing native socket could not be safely reconciled.")); }, 500);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); socket.destroy(); if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(true); else reject(error); });
  });
  if (!stale) throw new ConnectorError("socket_busy", "Another native connector listener is already using this data directory.");
  try { const current = lstatSync(path); if (current.dev !== stat.dev || current.ino !== stat.ino) throw new ConnectorError("socket_conflict", "The private native socket changed during recovery."); unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function statIfPresent(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
