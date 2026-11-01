import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCodexConnector } from "../codex/connector.ts";
import { captureDesktopOwner } from "../codex/desktop-owner.ts";
import { ConnectorError } from "../codex/protocol.ts";
import { NativeFailure } from "../codex/native.ts";
import { cliConfigPath } from "../codex-cli/config.ts";
import { createCliConnector } from "../codex-cli/connector.ts";
import { captureCliOwner } from "../codex-cli/owner.ts";
import { serveSeekerTools, type SeekerToolsConnector } from "./mcp.ts";

/** Positive native ancestry selects a host. Inherited Desktop variables never do. */
async function connect(configPath: string, signal: AbortSignal): Promise<SeekerToolsConnector> {
  const desktop = await captureDesktopOwner(signal).catch((error: unknown) => {
    // Only a definite non-Desktop host permits CLI qualification. In particular,
    // a transient Desktop probe error is not evidence of a different owner.
    if (!(error instanceof ConnectorError) || !["native_host_required", "desktop_platform_unsupported"].includes(error.code)) throw error;
  });
  signal.throwIfAborted();
  if (desktop) {
    if (existsSync(configPath)) return createCodexConnector(configPath, desktop, signal);
    throw new ConnectorError("native_host_unregistered", "Run seeker codex setup to register this existing Desktop manager.", 403);
  }
  const cli = await captureCliOwner(signal);
  signal.throwIfAborted();
  const cliPath = cliConfigPath(dirname(configPath));
  if (existsSync(cliPath)) return createCliConnector(cliPath, cli);
  throw new ConnectorError("native_host_unregistered", "Run seeker codex-cli setup to register this existing CLI manager.", 403);
}

const transient = new Set(["desktop_probe_failed", "desktop_profile_unavailable", "desktop_owner_changed", "cli_probe_failed", "cli_owner_changed", "native_unavailable"]);

export async function runNativeConnector(configPath: string): Promise<void> {
  const lifetime = new AbortController();
  let connector: SeekerToolsConnector | undefined, connecting: Promise<SeekerToolsConnector> | undefined;
  function prepare(): Promise<SeekerToolsConnector> {
    lifetime.signal.throwIfAborted();
    if (connector) return Promise.resolve(connector);
    if (connecting) return connecting;
    connecting = (async () => {
      for (let attempt = 0; ; attempt++) {
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(4_000)]);
        try {
          const ready = await connect(configPath, signal);
          if (lifetime.signal.aborted) { await ready.close(); lifetime.signal.throwIfAborted(); }
          connector = ready;
          return ready;
        } catch (cause) {
          if (lifetime.signal.aborted) throw cause;
          const error = cause instanceof ConnectorError ? cause
            : cause instanceof NativeFailure ? new ConnectorError(cause.code, `Native Desktop qualification failed (${cause.code}).`, 503)
            : new ConnectorError("native_initialization_failed", "Native connector initialization failed. Check its private configuration and host runtime.", 503);
          // Keep the original diagnostic code without logging OS output, paths,
          // credentials or a native response that may contain private data.
          console.error(`Seeker native connector initialization failed: ${error.code}.`);
          if (attempt !== 0 || !transient.has(error.code)) throw error;
          await delay(250, undefined, { signal: lifetime.signal });
        }
      }
    })().finally(() => { connecting = undefined; });
    return connecting;
  }
  // Preserve idle Desktop delivery. Failed startup is retried by later calls,
  // and concurrent calls share preparation; no operation is submitted here.
  void prepare().catch(() => {});
  await serveSeekerTools({
    async invoke(origin, operation, args, signal) {
      signal.throwIfAborted();
      const ready = await prepare();
      signal.throwIfAborted();
      // Never retry an invocation: it may have been accepted before I/O failed.
      return ready.invoke(origin, operation, args, signal);
    },
    async close() {
      lifetime.abort();
      try { await connecting; } catch { /* Preparation owns its partial cleanup. */ }
      await connector?.close();
    },
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--config") { console.error("Use seeker codex setup or seeker codex-cli setup to configure the native connector."); process.exitCode = 1; }
  else await runNativeConnector(args[1]!).catch(() => { console.error("Seeker's native connector could not start. Check its private configuration and host runtime."); process.exitCode = 1; });
}
