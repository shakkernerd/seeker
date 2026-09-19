import type { ChildProcess } from "node:child_process";
import { ConnectorError } from "../codex/protocol.ts";
import { captureRestartedCli, originalCliGone, readCliProcess, sameCliProcess, startRegisteredCli, verifyCliOwner, verifyNativeSocket, type CliOwner, type RegisteredCliOwner } from "./owner.ts";
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

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("CLI preparation cancelled")); };
    const timer = setTimeout(finish, ms); timer.unref(); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
}
async function settleStarter(child: ChildProcess, previous: CliOwner): Promise<CliOwner | undefined> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  // A bound host has crossed into its native lifetime. Leave it available to
  // the original UI; subsequent preparation may reconnect but cannot relaunch it.
  try { return await captureRestartedCli(child.pid, previous, AbortSignal.timeout(2_000)); } catch { /* Startup has not reached a verifiable listener. */ }
  const process = await readCliProcess(child.pid, AbortSignal.timeout(2_000)).catch(() => undefined);
  if (!process || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 500))]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const still = await readCliProcess(child.pid, AbortSignal.timeout(2_000)).catch(() => undefined);
  if (still && sameCliProcess(process, still)) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
  }
}

export const nativeCliRuntime: CliRuntime = {
  verify: verifyCliOwner,
  gone: originalCliGone,
  async connect(owner, signal) { verifyNativeSocket(owner.socketPath); return CliRpc.connect(owner.socketPath, signal); },
  async restart(registration, signal) {
    if (!await originalCliGone(registration.owner, signal)) throw new ConnectorError("cli_owner_running", "The original CLI process is still alive; restore its own endpoint.", 503);
    signal.throwIfAborted();
    const child = startRegisteredCli(registration);
    let launchError = false;
    child.on("error", () => { launchError = true; });
    try {
      while (!signal.aborted) {
        if (launchError || !child.pid || child.exitCode !== null || child.signalCode !== null) throw new ConnectorError("cli_start_failed", "The registered CLI host could not restart.", 503);
        try { return await captureRestartedCli(child.pid, registration.owner, signal); }
        catch { signal.throwIfAborted(); }
        await pause(100, signal);
      }
      throw new Error("CLI preparation cancelled");
    } catch (error) {
      const lateOwner = await settleStarter(child, registration.owner);
      // A late listener is still the newly started native host. Its owner must
      // be retained even when cancellation prevents resuming a task this time.
      if (lateOwner) return lateOwner;
      throw error;
    }
  },
};
