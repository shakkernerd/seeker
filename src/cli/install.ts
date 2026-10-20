import { resolve } from "node:path";
import { fail } from "../core/validation.ts";
import { runtimeVersion } from "../local/config.ts";
import { installHome } from "../install/layout.ts";
import { installApplication } from "../install/application.ts";
import { migrateState } from "../install/migration.ts";
import { removeApplication } from "../install/removal.ts";
import { connectEvents } from "../install/connector.ts";
import { serviceCommand } from "../install/service.ts";

const help = `Usage:
  seeker install [--home <path>] [--package-dir <built-package>] [--runtime <bun>] [--dry-run]
  seeker install remove [--config <toml> ...] [--home <path>] [--dry-run]
  seeker install connect --config <host-config.toml> [--home <path>] [--dry-run]
  seeker install migrate --from-data <old-store> --from-launcher <old-launcher> [--config <toml> ...] [--home <path>] [--dry-run]
  seeker service start|stop|restart|status|logs|enable|disable [--home <path>] [--dry-run]

Installation replaces only owned app/bin/runtime files. State, keys and logs are retained.
Use the qualified local Bun runtime and built package; nothing is downloaded or built.
Stop Seeker and settle old connectors/producers before upgrade or migration. Inspect with
--dry-run first. Enable explicitly for login startup and crash restart. Stop affects this
login; disable also removes future login startup. Add ~/.seeker/bin to your shell PATH.
Migration rewrites only declared Seeker paths in supplied configs; reload the affected
connectors through their original hosts. No manager is enrolled and no host is restarted.
`;
export async function runInstallCommand(command: "install" | "service", args: string[], packageDirectory: string): Promise<void> {
  if (args.includes("--help")) { console.log(help); return; }
  if (Bun.version !== runtimeVersion) fail("runtime_version", `Use qualified Bun ${runtimeVersion}.`);
  let action = command === "service" ? args.shift() : "install";
  if (command === "install" && ["migrate", "connect", "remove"].includes(args[0] ?? "")) action = args.shift();
  const values: Record<string, string> = {}, configs: string[] = [];
  let dryRun = false;
  const allowed = command === "service" ? ["--home"] : action === "migrate" ? ["--home", "--from-data", "--from-launcher", "--config"] : ["connect", "remove"].includes(action ?? "") ? ["--home", "--config"] : ["--home", "--package-dir", "--runtime"];
  while (args.length) {
    const key = args.shift()!;
    if (key === "--dry-run" && !dryRun) { dryRun = true; continue; }
    const value = args.shift();
    if (!allowed.includes(key) || !value || value.startsWith("--") || (key !== "--config" && values[key] !== undefined)) fail("invalid_option", help);
    if (key === "--config") configs.push(resolve(value)); else values[key] = value;
  }
  const home = resolve(values["--home"] ?? installHome());
  const result = command === "service" ? await serviceCommand(action ?? "status", home, dryRun)
    : action === "migrate" ? await migrateState({ home, fromData: resolve(values["--from-data"] ?? fail("missing_option", help)), fromLauncher: resolve(values["--from-launcher"] ?? fail("missing_option", help)), configs, dryRun })
    : action === "remove" ? await removeApplication(home, configs, dryRun)
    : action === "connect" ? connectEvents(home, configs.length === 1 ? configs[0]! : fail("missing_option", "Choose exactly one --config host TOML path."), dryRun)
    : await installApplication({ home, packageDirectory: resolve(values["--package-dir"] ?? packageDirectory), runtime: resolve(values["--runtime"] ?? process.execPath), dryRun });
  console.log(JSON.stringify(result, null, 2));
}
