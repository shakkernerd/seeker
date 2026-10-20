import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fail } from "../core/validation.ts";
import { privateDirectory, readConnectorConfig } from "../hosts/codex/config.ts";
import { atomicWrite, claimInstallation, layout, present, regular } from "./layout.ts";
import { verifyInstallation } from "./application.ts";

export function storeInUse(home: string): boolean {
  const path = join(home, "exchanges.sqlite");
  if (!present(path)) return false;
  regular(path);
  let db: Database | undefined;
  try { db = new Database(path, { readonly: true }); db.query("SELECT count(*) FROM sqlite_master").get(); return false; }
  catch (error) { if (error instanceof Error && /locked|busy/.test(error.message)) return true; throw error; }
  finally { db?.close(); }
}

/** Change only the three installed paths in explicitly supplied, matching MCP sections. */
export function relocateMcp(current: string, options: { fromData: string; fromLauncher: string; home: string }): string {
  const before = Bun.TOML.parse(current) as { mcp_servers?: Record<string, { command?: string; args?: string[] }> };
  let result = current;
  const expected = structuredClone(before);
  for (const name of ["seeker", "seeker_events"]) {
    const entry = before.mcp_servers?.[name];
    if (!entry) continue;
    const config = entry.args?.[1];
    if (entry.command !== options.fromLauncher || !Array.isArray(entry.args) || entry.args[0] !== "--config" || ![join(options.fromData, "codex-connector.json"), join(options.fromData, "cli/codex-connector.json")].includes(config ?? "") || !(entry.args.length === 2 || (entry.args.length === 4 && entry.args[2] === "--runtime"))) fail("migration_config", "A Seeker MCP entry does not match the declared old installation; it was preserved.");
    const next = expected.mcp_servers![name]!;
    next.command = join(options.home, "bin/seeker-codex");
    next.args = ["--config", join(options.home, config!.slice(options.fromData.length + 1)), "--runtime", join(options.home, "runtime/bun")];
    const header = new RegExp(`^\\[mcp_servers\\.${name}\\]\\s*$`, "m");
    const match = header.exec(result);
    if (!match) fail("migration_config", "Use a conventional Seeker MCP table before relocation.");
    const start = match.index + match[0].length, end = result.slice(start).search(/^\s*\[/m);
    const stop = end < 0 ? result.length : start + end;
    let block = result.slice(start, stop);
    for (const key of ["command", "args"] as const) {
      const pattern = new RegExp(`^${key}\\s*=.*$`, "gm");
      if ([...block.matchAll(pattern)].length !== 1) fail("migration_config", "Reconcile multiline or customized Seeker paths before relocation.");
      block = block.replace(pattern, `${key} = ${JSON.stringify(next[key])}`);
    }
    result = result.slice(0, start) + block + result.slice(stop);
  }
  if (JSON.stringify(Bun.TOML.parse(result)) !== JSON.stringify(expected)) fail("migration_config", "Relocation would change unrelated MCP settings; no configuration was written.");
  return result;
}
async function inactiveSocket(path: string): Promise<void> {
  const stale = await new Promise<boolean>((yes, no) => {
    const socket = createConnection(path), timeout = setTimeout(() => { socket.destroy(); no(new Error("Socket ownership is unresolved.")); }, 500);
    socket.once("connect", () => { clearTimeout(timeout); socket.destroy(); yes(false); });
    socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timeout); socket.destroy(); if (error.code === "ECONNREFUSED" || error.code === "ENOENT") yes(true); else no(error); });
  });
  if (!stale) fail("migration_busy", "A live native connector still owns a socket in the old store. Settle/reload its owner before migration.");
}
async function inspectState(directory: string): Promise<string[]> {
  const sockets: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), stat = present(path)!;
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) fail("migration_state", "State must be private, owned and free of symbolic links before migration.");
    if (stat.isDirectory()) sockets.push(...await inspectState(path));
    else if (stat.isSocket()) { await inactiveSocket(path); sockets.push(path); }
    else if (!stat.isFile()) fail("migration_state", "Unknown special state must be reconciled before migration.");
  }
  return sockets;
}

export async function migrateState(options: { home: string; fromData: string; fromLauncher: string; configs: string[]; dryRun?: boolean }) {
  const home = privateDirectory(options.home), from = privateDirectory(options.fromData);
  if (home === from || home.startsWith(`${from}/`) || from.startsWith(`${home}/`)) fail("migration_path", "Source and destination must be separate private directories.");
  verifyInstallation(home);
  if (storeInUse(from) || storeInUse(home)) fail("migration_busy", "Stop the source service and settle all producers before moving its store.");
  const entries = readdirSync(from).sort();
  for (const name of entries) if (["app", "bin", "runtime", "logs", ".installation-lock"].includes(name) || present(join(home, name))) fail("migration_collision", `Destination collision: ${name}. Preserve both directories and reconcile it explicitly.`);
  const sockets = await inspectState(from);
  const rewrites: { path: string; before: string; after: string; mode: number }[] = [];
  const rewriteJson = (path: string, transform: (value: Record<string, unknown>) => void) => {
    const before = readFileSync(path, "utf8"), value = JSON.parse(before); transform(value);
    rewrites.push({ path, before, after: `${JSON.stringify(value, null, 2)}\n`, mode: present(path)!.mode & 0o777 });
  };
  for (const suffix of ["", "cli"]) {
    const path = join(from, suffix, "codex-connector.json");
    if (!present(path)) continue;
    readConnectorConfig(path);
    rewriteJson(path, value => { value.socketPath = join(home, suffix, "codex.sock"); value.credentialFile = join(home, suffix, "codex.key"); });
  }
  const helperState = join(from, "codex-helper/session.json");
  if (present(helperState)) rewriteJson(helperState, value => {
    if (value.version !== 1 || typeof value.threadId !== "string" || value.previousWorkspace !== undefined) fail("migration_helper", "Reconcile the saved native helper before another relocation.");
    // The runtime retires only this exact old root through its normal native lifecycle.
    value.previousWorkspace = join(from, "codex-helper");
  });
  if (present(join(from, "telegram.json"))) rewriteJson(join(from, "telegram.json"), value => {
    if (typeof value.tokenFile === "string" && value.tokenFile.startsWith(`${from}/`)) value.tokenFile = join(home, value.tokenFile.slice(from.length + 1));
  });
  for (const config of [...new Set(options.configs.map(path => resolve(path)))]) {
    regular(config); const before = readFileSync(config, "utf8");
    const after = relocateMcp(before, { fromData: from, fromLauncher: resolve(options.fromLauncher), home });
    rewrites.push({ path: config, before, after, mode: present(config)!.mode & 0o777 });
  }
  const plan = { from, home, entries, retiredSockets: sockets, changedConfigs: rewrites.filter(item => item.before !== item.after).map(item => item.path), reload: "Reload each affected connector through its existing host before declaring delivery ready. No host is restarted by migration." };
  if (options.dryRun) return plan;
  const releaseDestination = claimInstallation(home);
  let releaseSource: (() => void) | undefined, settled = false;
  const moved: string[] = [], written: typeof rewrites = [];
  const journal = (phase: string) => atomicWrite(join(home, ".installation-progress.json"), JSON.stringify({ operation: "migration", from, home, phase, entries, moved, writtenConfigs: written.map(item => item.path) }));
  try {
    releaseSource = claimInstallation(from);
    if (storeInUse(from)) fail("migration_busy", "The source store became active; nothing was moved.");
    const dbPath = join(from, "exchanges.sqlite");
    if (present(dbPath)) {
      const db = new Database(dbPath);
      try {
        db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
        const check = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
        if (check?.quick_check !== "ok") fail("migration_database", "The source database failed its integrity check.");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally { db.close(); }
    }
    journal("rewriting known paths");
    for (const item of rewrites) {
      if (readFileSync(item.path, "utf8") !== item.before) fail("migration_changed", "Configuration changed after preflight; retry with the new state.");
      journal(`rewriting ${item.path}`);
      atomicWrite(item.path, item.after, item.mode); written.push(item); journal(`rewritten ${item.path}`);
    }
    for (const socket of sockets) { await inactiveSocket(socket); if (present(socket)) unlinkSync(socket); }
    for (const name of entries) if (present(join(from, name))) { journal(`moving ${name}`); renameSync(join(from, name), join(home, name)); moved.push(name); journal(`moved ${name}`); }
    settled = true;
  } catch (error) {
    for (const name of moved.reverse()) renameSync(join(home, name), join(from, name));
    for (const item of written.reverse()) atomicWrite(item.path, item.before, item.mode);
    settled = true;
    throw error;
  } finally { if (settled) { if (present(join(home, ".installation-progress.json"))) unlinkSync(join(home, ".installation-progress.json")); releaseSource?.(); releaseDestination(); } }
  return plan;
}
