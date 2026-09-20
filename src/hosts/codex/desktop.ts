import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { privateDirectory, readPrivateFile } from "./config.ts";
import { inspectDesktop, parseDesktopOwner, sameDesktopProcess, type DesktopOwner, type DesktopProfile } from "./desktop-owner.ts";
import { readDesktopCodeHome, readDesktopUserData, readDesktopToolsPipe } from "./desktop-selectors.ts";
import type { CodexHostLifecycle } from "./host.ts";
import { ConnectorError, onlyKeys, record } from "./protocol.ts";

interface DesktopOperations {
  inspect: typeof inspectDesktop;
  start(profile: DesktopProfile, signal: AbortSignal): Promise<void>;
  pipe(server: DesktopOwner["server"]): string;
}

/** A native manager's first admitted call pins the host that may resume it later. */
export class CodexDesktopLifecycle implements CodexHostLifecycle {
  readonly #qualified = new Map<string, DesktopOwner>();
  #registered?: DesktopOwner;

  constructor(private readonly statePath: string, private readonly operations: DesktopOperations = { inspect: (profile, signal) => inspectDesktop(profile, signal, readDesktopCodeHome, readDesktopUserData), start: startDesktop, pipe: readDesktopToolsPipe }) {
    privateDirectory(dirname(statePath));
    let present = false;
    try { lstatSync(statePath); present = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (present) {
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
    if (instances.length !== 1 || !current?.server || !sameDesktopProcess(current.app, owner.app) || !sameDesktopProcess(current.server, owner.server) || current.userDataPath !== owner.profile.userDataPath || current.codexHome !== owner.profile.codexHome || current.sqliteHome !== owner.profile.sqliteHome) {
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
    this.ready(owner);
    if (!this.#registered) this.#save(owner);
  }

  ready(value: unknown): void {
    if (!this.#registered) return;
    const owner = parseDesktopOwner(value);
    if (ownerKey(owner) !== ownerKey(this.#registered)) throw new ConnectorError("desktop_owner_changed", "Reconnect this receiver to the registered Desktop owner.", 409);
  }

  /** Preparation only: starting an absent host never selects a task or sends input. */
  async prepare(signal: AbortSignal, isCurrent: () => boolean): Promise<{ owner: DesktopOwner; pipePath: string }> {
    const registered = this.#registered;
    if (!registered) throw new ConnectorError("desktop_registration_required", "Use Seeker from the original Desktop manager once to qualify its native host.");
    if (!registered.profile.sqliteHome) throw new ConnectorError("desktop_storage_unqualified", "Qualify the original native storage directory before allowing Desktop recovery.");
    let started = false;
    for (;;) {
      signal.throwIfAborted();
      const instances = await this.operations.inspect(registered.profile, signal);
      if (instances.length > 1) throw new ConnectorError("desktop_owner_ambiguous", "More than one Desktop instance is running. Preserve the registered owner.");
      const current = instances[0];
      if (current?.server && current.userDataPath === registered.profile.userDataPath && current.codexHome === registered.profile.codexHome && current.sqliteHome === registered.profile.sqliteHome) {
        const pipePath = this.operations.pipe(current.server);
        signal.throwIfAborted();
        if (!isCurrent()) throw new ConnectorError("owner_changed", "The manager assignment changed during Desktop preparation.");
        return { owner: { profile: registered.profile, app: current.app, server: current.server }, pipePath };
      }
      if (current?.server) throw new ConnectorError("desktop_owner_unqualified", "The running Desktop instance does not have the registered native profile and storage.");
      if (!isCurrent()) throw new ConnectorError("owner_changed", "The manager assignment changed during Desktop preparation.");
      if (!current && !started) { signal.throwIfAborted(); await this.operations.start(registered.profile, signal); started = true; }
      await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Desktop preparation cancelled")); };
        const timer = setTimeout(finish, 250); timer.unref(); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }

  #save(owner: DesktopOwner): void {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, owner }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      if (this.#registered) {
        const current = record(JSON.parse(readPrivateFile(this.statePath)));
        onlyKeys(current, ["version", "owner"]);
        if (current.version !== 1 || ownerKey(parseDesktopOwner(current.owner)) !== ownerKey(this.#registered)) throw new ConnectorError("desktop_registration_changed", "The saved Desktop registration changed outside this service.");
        renameSync(temporary, this.statePath);
      } else linkSync(temporary, this.statePath);
      this.#registered = owner;
    } finally { try { unlinkSync(temporary); } catch { /* A successful rename consumed it. */ } }
  }
}

function sameProfile(first: DesktopProfile, second: DesktopProfile): boolean {
  return first.appPath === second.appPath && first.userDataPath === second.userDataPath && first.codexHome === second.codexHome && first.sqliteHome === second.sqliteHome;
}
function ownerKey(owner: DesktopOwner): string { return JSON.stringify(owner); }

function startDesktop(profile: DesktopProfile, signal: AbortSignal): Promise<void> {
  if (process.platform !== "darwin") return Promise.reject(new ConnectorError("desktop_platform", "Desktop recovery requires its registered local macOS host."));
  const args = ["-g", "-a", profile.appPath, "--env", `CODEX_HOME=${profile.codexHome}`, "--env", `CODEX_ELECTRON_USER_DATA_PATH=${profile.userDataPath}`];
  if (profile.sqliteHome) args.push("--env", `CODEX_SQLITE_HOME=${profile.sqliteHome}`);
  const environment = { ...process.env };
  delete environment.CODEX_HOME; delete environment.CODEX_ELECTRON_USER_DATA_PATH; delete environment.CODEX_SQLITE_HOME;
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", args, { env: environment, signal, timeout: 5_000, maxBuffer: 16_384 }, (error) => {
      if (error) reject(new ConnectorError("desktop_start_failed", "The registered Desktop host could not be opened. The reply remains saved."));
      else resolve();
    });
  });
}
