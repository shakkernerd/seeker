#!/usr/bin/env bun
import { runInstallCommand } from "./cli/install.ts";
import { managedLog } from "./install/service.ts";
import { installHome, present } from "./install/layout.ts";
import { runEventCommand } from "./cli/events.ts";
import { join, resolve } from "node:path";
import { SeekerCore } from "./core/seeker.ts";
import { SeekerError } from "./core/validation.ts";
import { SqliteExchangeStore } from "./store/sqlite.ts";
import { defaultDataDir, ensureDataDir, loadAccessKey, runtimeVersion, version } from "./local/config.ts";
import { FixtureHost, seedFixture } from "./local/fixture.ts";
import { startRuntime } from "./local/runtime.ts";
import { runTelegramCommand } from "./channels/telegram/cli.ts";
import { loadTelegram } from "./channels/telegram/runtime.ts";
import { loadTelegramRecipient } from "./channels/telegram/config.ts";
import { loadCodexHost } from "./hosts/codex/setup.ts";
import { loadCodexCliHost } from "./hosts/codex-cli/setup.ts";
import { runCodexCommand } from "./cli/codex.ts";
import { localRecipient } from "./local/channel.ts";

const help = `Seeker ${version} — durable conversations with your agent managers

Usage: seeker <command> [options]

  install               Install/upgrade the single-home application or migrate state
  service               Manage login startup, crash restart, status and logs
  start                 Start the authenticated local inbox
  demo                  Try the local channel with a labelled host fixture
  event                 Prepare a private wait capability or signal a background result
  access-key            Print the local browser/CLI access key deliberately
  telegram              Pair or inspect the optional Telegram channel
  codex setup           Connect an existing Codex Desktop manager
  codex-cli setup       Connect an existing Codex CLI manager

Options:
  --data-dir <path>     Private Seeker store directory
  --port <number>       Loopback port (default 4317)
  --version            Print the package version
  --help               Show this help

Settings: flags override SEEKER_DATA_DIR / SEEKER_PORT, then defaults.
Seeker listens only on 127.0.0.1. Open the printed address and sign in with
the access key from the named file. Demo uses a separate data directory.
Pending exchanges survive shutdown. A fixture is not a real agent manager.
`;

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === "service" && args[1] === "run") {
    if (args.length !== 4 || args[2] !== "--home") throw new SeekerError("invalid_option", "Managed service requires its installed home.");
    const home = resolve(args[3] ?? installHome());
    const log = managedLog(home);
    console.log = (...values: unknown[]) => log(values.map(String).join(" "));
    console.error = (...values: unknown[]) => log(values.map(String).join(" "));
    return main(["start", "--data-dir", home, "--port", "4317"]);
  }
  if (args[0] === "install" || args[0] === "service") { await runInstallCommand(args[0], args.slice(1), resolve(import.meta.dir, "..")); return; }
  if (args[0] === "event") { await runEventCommand(args.slice(1)); return; }
  if (args[0] === "telegram") { await runTelegramCommand(args.slice(1)); return; }
  if (args[0] === "codex" || args[0] === "codex-cli") {
    await runCodexCommand(args.slice(1), { packageDirectory: resolve(import.meta.dir, ".."), defaultRecipient: localRecipient, resolveRecipient: (dataDir, channel) => {
      if (channel === "local") return localRecipient;
      if (channel === "telegram") {
        const recipient = loadTelegramRecipient(dataDir);
        if (recipient) return recipient;
        throw new SeekerError("channel_unavailable", "Pair the Telegram owner before selecting that channel.");
      }
      throw new SeekerError("channel_unavailable", "Choose local or an explicitly paired Telegram channel.");
    } }, args[0] === "codex-cli" ? "cli" : "desktop");
    return;
  }
  if (args.includes("--help") || args.length === 0) { console.log(help); return; }
  if (args.includes("--version")) { console.log(version); return; }
  const command = args.shift();
  if (!["start", "demo", "access-key"].includes(command ?? "")) throw new SeekerError("unknown_command", "Unknown command. Run seeker --help.");
  const fixture = command === "demo";
  let dataDir = defaultDataDir(fixture);
  let port = Number(process.env.SEEKER_PORT ?? 4317);
  while (args.length) {
    const option = args.shift();
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new SeekerError("invalid_option", "Each option needs a value. Run seeker --help.");
    if (option === "--data-dir") dataDir = resolve(value);
    else if (option === "--port") port = Number(value);
    else throw new SeekerError("invalid_option", "Unknown option. Run seeker --help.");
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new SeekerError("invalid_port", "Use a port from 1 to 65535 (0 selects a free local port).");
  if (Bun.version !== runtimeVersion) throw new SeekerError("runtime_version", `Use qualified Bun ${runtimeVersion}; current runtime is ${Bun.version}.`);
  dataDir = ensureDataDir(dataDir);
  if (present(join(dataDir, ".installation-lock"))) throw new SeekerError("install_busy", "Finish installation or migration before opening the store.");
  const accessKey = loadAccessKey(dataDir);
  if (command === "access-key") { console.log(accessKey); return; }
  const store = new SqliteExchangeStore(join(dataDir, "exchanges.sqlite"));
  const core = new SeekerCore(store, Date.now, { keyDirectory: join(dataDir, "keys") });
  let runtime: ReturnType<typeof startRuntime> | undefined;
  let telegram: ReturnType<typeof loadTelegram>;
  let native: Awaited<ReturnType<typeof loadCodexHost>>;
  let cli: Awaited<ReturnType<typeof loadCodexCliHost>>;
  let initializing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => closing ??= (async () => {
    runtime?.pump.stop();
    const failures: unknown[] = [];
    try { await telegram?.stopReceiver(); } catch (error) { failures.push(error); }
    await initializing?.catch(() => {});
    for (const result of await Promise.allSettled([native?.close(), cli?.close(), runtime?.stop()])) if (result.status === "rejected") failures.push(result.reason);
    store.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (failures.length) throw new AggregateError(failures, "An adapter could not stop cleanly.");
  })();
  const stop = () => { void shutdown().catch(() => { console.error("Seeker could not completely stop its adapters."); process.exitCode = 1; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    initializing = (async () => {
      if (fixture) seedFixture(core);
      native = fixture ? undefined : await loadCodexHost(core, dataDir);
      cli = fixture ? undefined : await loadCodexCliHost(core, dataDir);
      if (closing) return;
      telegram = fixture ? undefined : loadTelegram(core, dataDir, (message) => console.error(`Seeker: ${message}`));
      await telegram?.startReceiver();
      if (closing) return;
      runtime = startRuntime({ core, accessKey, port, mode: fixture ? "fixture" : "local", channels: telegram ? [telegram.channel] : [], hosts: fixture ? [new FixtureHost(core)] : [...(native ? [native.host] : []), ...(cli ? [cli.host] : [])] });
      console.log(`Seeker ${version}${fixture ? " · controlled demo fixture" : ""}\nOpen http://127.0.0.1:${runtime.server.port}\nAccess key: ${join(dataDir, "access.key")}\nStore: ${join(dataDir, "exchanges.sqlite")}\nPress Ctrl+C to stop. Pending exchanges will be retained.`);
    })();
    await initializing;
  } catch (error) {
    if (closing) { await closing; return; }
    await shutdown();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof SeekerError ? `Seeker: ${error.message}` : "Seeker could not start. Check the private data directory, available disk space, and local port.");
  process.exitCode = 1;
});
