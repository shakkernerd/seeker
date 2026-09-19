#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { SeekerCore } from "./core/seeker.ts";
import { SeekerError } from "./core/validation.ts";
import { SqliteExchangeStore } from "./store/sqlite.ts";
import { defaultDataDir, ensureDataDir, loadAccessKey, runtimeVersion, version } from "./local/config.ts";
import { FixtureHost, seedFixture } from "./local/fixture.ts";
import { startRuntime } from "./local/runtime.ts";

const help = `Seeker ${version} — durable conversations with your agent managers

Usage: seeker <command> [options]

  start                 Start the authenticated local inbox
  demo                  Try the local channel with a labelled host fixture
  access-key            Print the local browser/CLI access key deliberately

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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
  const accessKey = loadAccessKey(dataDir);
  if (command === "access-key") { console.log(accessKey); return; }
  const store = new SqliteExchangeStore(join(dataDir, "exchanges.sqlite"));
  const core = new SeekerCore(store);
  let runtime: ReturnType<typeof startRuntime> | undefined;
  try {
    if (fixture) seedFixture(core);
    runtime = startRuntime({ core, accessKey, port, mode: fixture ? "fixture" : "local", hosts: fixture ? [new FixtureHost(core)] : [] });
    console.log(`Seeker ${version}${fixture ? " · controlled demo fixture" : ""}\nOpen http://127.0.0.1:${runtime.server.port}\nAccess key: ${join(dataDir, "access.key")}\nStore: ${join(dataDir, "exchanges.sqlite")}\nPress Ctrl+C to stop. Pending exchanges will be retained.`);
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void runtime!.stop().finally(() => { store.close(); process.exitCode = 0; });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    if (runtime) await runtime.stop();
    store.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof SeekerError ? `Seeker: ${error.message}` : "Seeker could not start. Check the private data directory, available disk space, and local port.");
  process.exitCode = 1;
});
