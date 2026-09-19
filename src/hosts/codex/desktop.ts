import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ManagerBinding } from "../../contracts.ts";
import { privateDirectory, readPrivateFile } from "./config.ts";
import { inspectDesktop, parseDesktopOwner, sameDesktopProcess, type DesktopOwner, type DesktopProfile } from "./desktop-owner.ts";
import type { CodexHostLifecycle } from "./host.ts";
import { ConnectorError, onlyKeys, record } from "./protocol.ts";

interface DesktopOperations {
  inspect: typeof inspectDesktop;
  open(profile: DesktopProfile, taskId: string, signal: AbortSignal): Promise<void>;
}

/** A native manager's first admitted call pins the host that may resume it later. */
export class CodexDesktopLifecycle implements CodexHostLifecycle {
  readonly #qualified = new Map<string, DesktopOwner>();
  #registered?: DesktopOwner;

  constructor(private readonly statePath: string, private readonly operations: DesktopOperations = { inspect: inspectDesktop, open: openDesktop }) {
    privateDirectory(dirname(statePath));
    if (existsSync(statePath)) {
      const state = record(JSON.parse(readPrivateFile(statePath)));
      onlyKeys(state, ["version", "owner"]);
      if (state.version !== 1) throw new ConnectorError("desktop_registration_invalid", "The saved Desktop registration needs reconciliation.");
      this.#registered = parseDesktopOwner(state.owner);
    }
  }

  async connected(value: unknown): Promise<void> {
    // Existing connectors keep their active transport until setup/reload. They
    // cannot enroll a launch target or borrow an already pinned host identity.
    if (value === undefined && !this.#registered) return;
    const owner = parseDesktopOwner(value);
    if (this.#registered && !sameProfile(owner.profile, this.#registered.profile)) throw new ConnectorError("desktop_profile_changed", "This connector belongs to a different registered Desktop profile.", 403);
    const instances = await this.operations.inspect(owner.profile, AbortSignal.timeout(3_000));
    const current = instances[0];
    if (instances.length !== 1 || !current?.server || !sameDesktopProcess(current.app, owner.app) || !sameDesktopProcess(current.server, owner.server) || current.userDataPath !== owner.profile.userDataPath) {
      throw new ConnectorError("desktop_owner_changed", "The connector's native Desktop owner could not be verified.", 403);
    }
    this.#qualified.set(ownerKey(owner), owner);
    if (this.#qualified.size > 256) this.#qualified.delete(this.#qualified.keys().next().value!);
    // A genuine connector can attest a restarted owner before any human input.
    if (this.#registered && ownerKey(this.#registered) !== ownerKey(owner)) this.#save(owner);
  }

  async admitted(value: unknown): Promise<void> {
    if (value === undefined && !this.#registered) return;
    const owner = parseDesktopOwner(value);
    if (!this.#qualified.has(ownerKey(owner))) throw new ConnectorError("desktop_owner_unqualified", "Qualify the native Desktop connector before manager admission.", 403);
    if (this.#registered && !sameProfile(this.#registered.profile, owner.profile)) throw new ConnectorError("desktop_profile_changed", "The manager belongs to a different Desktop profile.", 403);
    if (!this.#registered) this.#save(owner);
  }

  ready(value: unknown): void {
    if (!this.#registered) return;
    const owner = parseDesktopOwner(value);
    if (ownerKey(owner) !== ownerKey(this.#registered)) throw new ConnectorError("desktop_owner_changed", "Reconnect this receiver to the registered Desktop owner.", 409);
  }

  async resume(binding: ManagerBinding, signal: AbortSignal): Promise<void> {
    const registered = this.#registered;
    if (!registered) throw new ConnectorError("desktop_registration_required", "Reload the updated connector and use Seeker from the registered manager once to enable recovery.");
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(binding.origin.managerId)) throw new ConnectorError("invalid_task", "Resume requires the exact registered native task ID.");
    signal.throwIfAborted();
    const instances = await this.operations.inspect(registered.profile, signal);
    if (instances.length > 1) throw new ConnectorError("desktop_owner_ambiguous", "More than one Desktop instance is running. Preserve the registered owner.");
    const current = instances[0];
    if (current && (!sameDesktopProcess(current.app, registered.app) || current.userDataPath !== registered.profile.userDataPath)) {
      throw new ConnectorError("desktop_owner_unqualified", "A different Desktop instance is running. Qualify its native connector before resuming this manager.");
    }
    signal.throwIfAborted();
    // No prompt or model setting is passed. The host loads the original saved
    // task; its qualified MCP receiver alone can deliver the retained receipt.
    await this.operations.open(registered.profile, binding.origin.managerId, signal);
  }

  #save(owner: DesktopOwner): void {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, owner }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.statePath);
      this.#registered = owner;
    } finally { try { unlinkSync(temporary); } catch { /* A successful rename consumed it. */ } }
  }
}

function sameProfile(first: DesktopProfile, second: DesktopProfile): boolean {
  return first.appPath === second.appPath && first.userDataPath === second.userDataPath && first.codexHome === second.codexHome && first.sqliteHome === second.sqliteHome;
}
function ownerKey(owner: DesktopOwner): string { return JSON.stringify(owner); }

function openDesktop(profile: DesktopProfile, taskId: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== "darwin") return Promise.reject(new ConnectorError("desktop_platform", "Desktop recovery requires its registered local macOS host."));
  const args = ["-a", profile.appPath, "--env", `CODEX_HOME=${profile.codexHome}`, "--env", `CODEX_ELECTRON_USER_DATA_PATH=${profile.userDataPath}`];
  if (profile.sqliteHome) args.push("--env", `CODEX_SQLITE_HOME=${profile.sqliteHome}`);
  args.push("--url", `codex://threads/${encodeURIComponent(taskId)}`);
  const environment = { ...process.env };
  delete environment.CODEX_HOME; delete environment.CODEX_ELECTRON_USER_DATA_PATH; delete environment.CODEX_SQLITE_HOME;
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", args, { env: environment, signal, timeout: 5_000, maxBuffer: 16_384 }, (error) => {
      if (error) reject(new ConnectorError("desktop_start_failed", "The registered Desktop host could not be opened. The reply remains saved."));
      else resolve();
    });
  });
}
