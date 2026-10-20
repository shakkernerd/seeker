import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "../core/validation.ts";
import { ensureDataDir, runtimeVersion } from "../local/config.ts";
import { atomicWrite, claimInstallation, digest, fileInventory, layout, present, quote, regular } from "./layout.ts";

interface Installation { version: 1; home: string; packageVersion: string; bunVersion: string; files: Record<string, string>; runtimeHash: string; launchers: Record<string, string> }
export function readInstallation(home: string): Installation | undefined {
  const paths = layout(home);
  if (!present(paths.identity)) return;
  regular(paths.identity);
  const value = JSON.parse(readFileSync(paths.identity, "utf8")) as Installation;
  if (value.version !== 1 || value.home !== paths.home || typeof value.packageVersion !== "string" || typeof value.files !== "object" || !value.files || !value.launchers || value.bunVersion !== runtimeVersion) fail("install_identity", "The installation identity is invalid; preserve and reconcile this home.");
  return value;
}
export function verifyInstallation(home: string): Installation {
  const paths = layout(home), identity = readInstallation(home);
  if (!identity) fail("not_installed", "Install a built Seeker package first.");
  for (const directory of [paths.app, paths.bin, dirname(paths.runtime)]) ensureDataDir(directory);
  const files = fileInventory(paths.app); delete files["installation.json"];
  if (JSON.stringify(files) !== JSON.stringify(identity.files) || digest(paths.runtime) !== identity.runtimeHash || JSON.stringify(fileInventory(paths.bin)) !== JSON.stringify(identity.launchers) || readdirSync(dirname(paths.runtime)).join() !== "bun") fail("install_modified", "Owned application files changed or contain unknown additions; reconcile them before replacement.");
  return identity;
}
function launcher(home: string): string {
  return `#!/bin/sh\nset -eu\nexport SEEKER_DATA_DIR=\${SEEKER_DATA_DIR:-${quote(home)}}\nexec ${quote(join(home, "runtime/bun"))} ${quote(join(home, "app/dist/cli.js"))} "$@"\n`;
}
function connector(home: string): string {
  // Keep exec ancestry: the package launcher chooses Codex's supplied runtime.
  return `#!/bin/sh\nset -eu\nexec ${quote(join(home, "app/bin/seeker-codex"))} "$@"\n`;
}
export async function installApplication(options: { home: string; packageDirectory: string; runtime: string; dryRun?: boolean }) {
  const paths = layout(options.home), source = resolve(options.packageDirectory), runtime = resolve(options.runtime);
  regular(join(source, "package.json")); regular(runtime);
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (manifest.name !== "@shakkernerd/seeker" || manifest.engines?.bun !== runtimeVersion || typeof manifest.version !== "string") fail("install_package", "Select the built Seeker package with its qualified Bun version.");
  for (const path of ["dist/cli.js", "dist/codex-connector.mjs", "bin/seeker-codex"]) regular(join(source, path));
  const probe = Bun.spawn([runtime, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
  const reported = (await new Response(probe.stdout).text()).trim(); await new Response(probe.stderr).text();
  if (await probe.exited !== 0 || reported !== runtimeVersion) fail("runtime_version", `Use qualified Bun ${runtimeVersion}.`);
  const prior = readInstallation(paths.home);
  if (prior) verifyInstallation(paths.home);
  else for (const path of [paths.app, paths.bin, dirname(paths.runtime)]) if (present(path)) fail("install_collision", "An application path already exists without Seeker installation identity; it was preserved.");
  const plan = { home: paths.home, packageVersion: manifest.version, runtimeVersion, replace: Boolean(prior), ownedPaths: [paths.app, paths.bin, dirname(paths.runtime)], preserved: "All root state, credentials, registrations, receiver ownership and logs", service: "Stop the owned service before upgrading; enable explicitly after installation", shell: `Add ${join(paths.home, "bin")} to PATH in your selected shell`, connector: join(paths.bin, "seeker-codex") };
  if (options.dryRun) return plan;
  const release = claimInstallation(paths.home), stage = join(paths.home, `.install-${randomUUID()}`);
  let settled = false;
  const moved: string[] = [], activated: string[] = [];
  const journal = (phase: string) => atomicWrite(join(paths.home, ".installation-progress.json"), JSON.stringify({ operation: "install", home: paths.home, stage, phase, moved, activated }));
  try {
    // Do not replace code under a live service or connector. A caller must first settle its consumers.
    if (prior && (await import("./migration.ts")).storeInUse(paths.home)) fail("store_in_use", "Stop Seeker and settle connector consumers before upgrading.");
    mkdirSync(stage, { mode: 0o700 });
    for (const name of ["app", "runtime", "bin", "previous"]) mkdirSync(join(stage, name), { mode: 0o700 });
    for (const name of ["dist", "bin", "docs", "package.json", "README.md", "LICENSE", ".bun-version"]) {
      const from = join(source, name); if (!present(from)) fail("install_package", "A built package component is missing.");
      if (present(from)!.isDirectory()) fileInventory(from); else regular(from);
      cpSync(from, join(stage, "app", name), { recursive: true, dereference: false });
    }
    chmodSync(join(stage, "app"), 0o700);
    cpSync(runtime, join(stage, "runtime/bun")); chmodSync(join(stage, "runtime/bun"), 0o700);
    writeFileSync(join(stage, "bin/seeker"), launcher(paths.home), { mode: 0o700 });
    writeFileSync(join(stage, "bin/seeker-codex"), connector(paths.home), { mode: 0o700 });
    const check = Bun.spawn([join(stage, "runtime/bun"), join(stage, "app/dist/cli.js"), "--help"], { cwd: stage, env: { PATH: "/usr/bin:/bin", HOME: paths.home }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const help = await new Response(check.stdout).text(); await new Response(check.stderr).text();
    if (await check.exited !== 0 || !help.includes("Usage: seeker")) fail("install_package", "The staged package cannot run independently of its source/dependencies.");
    const identity: Installation = { version: 1, home: paths.home, packageVersion: manifest.version, bunVersion: runtimeVersion, files: fileInventory(join(stage, "app")), runtimeHash: digest(join(stage, "runtime/bun")), launchers: fileInventory(join(stage, "bin")) };
    writeFileSync(join(stage, "app/installation.json"), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    journal("switching");
    for (const name of ["app", "runtime", "bin"]) {
      journal(`switching ${name}`);
      if (prior) { renameSync(join(paths.home, name), join(stage, "previous", name)); moved.push(name); }
      renameSync(join(stage, name), join(paths.home, name)); activated.push(name); journal(`activated ${name}`);
    }
    verifyInstallation(paths.home); settled = true;
  } catch (error) {
    for (const name of activated.reverse()) renameSync(join(paths.home, name), join(stage, name));
    for (const name of moved.reverse()) renameSync(join(stage, "previous", name), join(paths.home, name));
    settled = true;
    throw error;
  } finally { if (settled) { if (present(stage)) rmSync(stage, { recursive: true }); if (present(join(paths.home, ".installation-progress.json"))) rmSync(join(paths.home, ".installation-progress.json")); release(); } }
  return plan;
}
