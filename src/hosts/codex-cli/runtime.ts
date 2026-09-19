import type { ChildProcess } from "node:child_process";
import { ConnectorError, record } from "../codex/protocol.ts";
import { readDesktopCodeHome } from "../codex/desktop-selectors.ts";
import { captureRestartedCli, findRunningCli, originalCliGone, readCliProcess, sameCliProcess, sameCliProfile, startRegisteredCli, verifyCliOwner, verifyNativeSocket, type CliOwner, type RegisteredCliOwner } from "./owner.ts";
import { CliRpc } from "./rpc.ts";

export interface NativeCliConnection {
  readonly connected: boolean;
  onNotice?: (method: string, params: unknown) => void;
  request<T = unknown>(method: string, params: unknown, signal: AbortSignal, timeoutMs?: number): Promise<T>;
  close(): void;
}
export interface CliRuntime {
  verify(owner: CliOwner, signal: AbortSignal): Promise<void>;
  gone(owner: CliOwner, signal: AbortSignal): Promise<boolean>;
  connect(owner: CliOwner, signal: AbortSignal): Promise<NativeCliConnection>;
  restart(registration: RegisteredCliOwner, signal: AbortSignal): Promise<CliOwner>;
}
export interface CliRuntimeOperations extends Pick<CliRuntime, "verify" | "gone" | "connect"> {
  find(owner: CliOwner, signal: AbortSignal): Promise<CliOwner | undefined>;
  start: typeof startRegisteredCli;
  capture: typeof captureRestartedCli;
  readProcess: typeof readCliProcess;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("CLI preparation cancelled")); };
    const timer = setTimeout(finish, ms); timer.unref(); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
}
async function settleStarter(child: ChildProcess, previous: CliOwner, operations: CliRuntimeOperations): Promise<CliOwner | undefined> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  // A bound host has crossed into its native lifetime. Leave it available to
  // the original UI; subsequent preparation may reconnect but cannot relaunch it.
  try { return await operations.capture(child.pid, previous, AbortSignal.timeout(2_000)); } catch { /* Startup has not reached a verifiable listener. */ }
  const process = await operations.readProcess(child.pid, AbortSignal.timeout(2_000)).catch(() => undefined);
  if (!process || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 500))]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const still = await operations.readProcess(child.pid, AbortSignal.timeout(2_000)).catch(() => undefined);
  if (still && sameCliProcess(process, still)) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
  }
}

export function createNativeCliRuntime(operations: CliRuntimeOperations): CliRuntime {
  async function reuse(registration: RegisteredCliOwner, signal: AbortSignal): Promise<CliOwner | undefined> {
    const owner = await operations.find(registration.owner, signal);
    if (!owner) return;
    if (!sameCliProfile(owner, registration.owner)) throw new ConnectorError("cli_owner_changed", "The running CLI does not match its registered profile.", 503);
    const rpc = await operations.connect(owner, signal);
    const expected = registration.remoteControl === "disabled" ? ["disabled"] : ["connecting", "connected", "errored"];
    let modeChanged = false;
    rpc.onNotice = (method, params) => {
      if (method !== "remoteControl/status/changed") return;
      // Native startup announces the current mode on a new connection too.
      // Only a different or unknown effective mode invalidates this recovery.
      try { modeChanged ||= !expected.includes(String(record(params).status)); }
      catch { modeChanged = true; }
    };
    try {
      const status = record(await rpc.request("remoteControl/status/read", null, signal)).status;
      if (!expected.includes(String(status))) throw new ConnectorError("cli_mode_changed", "The running CLI has a different or unverified effective launch mode.", 503);
      // Bind the RPC observation to the same independently inspected process.
      const confirmed = await operations.find(registration.owner, signal);
      if (!confirmed || !sameCliProcess(owner.process, confirmed.process) || !sameCliProfile(owner, confirmed)) throw new ConnectorError("cli_owner_changed", "CLI ownership changed during recovery.", 503);
      if (modeChanged) throw new ConnectorError("cli_mode_changing", "The native launch mode is changing; retry after it settles.", 503);
      signal.throwIfAborted();
      return confirmed;
    } finally { rpc.onNotice = undefined; rpc.close(); }
  }
  return {
    verify: operations.verify,
    gone: operations.gone,
    connect: operations.connect,
    async restart(registration, signal) {
      if (!await operations.gone(registration.owner, signal)) throw new ConnectorError("cli_owner_running", "The original CLI process is still alive; restore its own endpoint.", 503);
      const running = await reuse(registration, signal);
      if (running) return running;
      signal.throwIfAborted();
      const child = operations.start(registration);
      let launchError = false;
      child.on("error", () => { launchError = true; });
      try {
        while (!signal.aborted) {
          if (launchError || !child.pid || child.exitCode !== null || child.signalCode !== null) throw new ConnectorError("cli_start_failed", "The registered CLI host could not restart.", 503);
          try { return await operations.capture(child.pid, registration.owner, signal); }
          catch { signal.throwIfAborted(); }
          await pause(100, signal);
        }
        throw new Error("CLI preparation cancelled");
      } catch (error) {
        const lateOwner = await settleStarter(child, registration.owner, operations);
        // A late listener is still the newly started native host. Its owner must
        // be retained even when cancellation prevents resuming a task this time.
        if (lateOwner) return lateOwner;
        // A manual native launch may have won the same endpoint's startup lock.
        if (!signal.aborted) {
          const concurrent = await reuse(registration, signal);
          if (concurrent) return concurrent;
        }
        throw error;
      }
    },
  };
}

export const nativeCliRuntime = createNativeCliRuntime({
  verify: verifyCliOwner,
  gone: originalCliGone,
  async connect(owner, signal) { verifyNativeSocket(owner.socketPath); return CliRpc.connect(owner.socketPath, signal); },
  // Keep the OS selector reader (and Bun FFI) out of the shared Node MCP bundle.
  find: (owner, signal) => findRunningCli(owner, signal, readDesktopCodeHome),
  start: startRegisteredCli,
  capture: captureRestartedCli,
  readProcess: readCliProcess,
});
