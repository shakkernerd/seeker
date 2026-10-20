import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail } from "../core/validation.ts";
import { verifyInstallation } from "./application.ts";
import { atomicWrite, claimInstallation, layout, present, regular } from "./layout.ts";
import { serviceCommand } from "./service.ts";
import { storeInUse } from "./migration.ts";

export function removeMcp(current: string, home: string): string {
  const parsed = Bun.TOML.parse(current) as { mcp_servers?: Record<string, { command?: string; args?: string[] }> };
  const expected = structuredClone(parsed), remove = new Set<string>();
  for (const name of ["seeker", "seeker_events"]) {
    const entry = parsed.mcp_servers?.[name];
    if (!entry || entry.command !== join(home, "bin/seeker-codex")) continue;
    if (entry.args?.[0] !== "--config" || ![join(home, "codex-connector.json"), join(home, "cli/codex-connector.json")].includes(entry.args[1] ?? "")) fail("removal_config", "An installed connector has a different store; reconcile it before removal.");
    delete expected.mcp_servers![name]; remove.add(name);
  }
  let skipped = false;
  const result = current.split(/(?<=\n)/).filter(line => {
    const table = /^\s*\[([^\]]+)\]/.exec(line);
    if (table) skipped = [...remove].some(name => table[1] === `mcp_servers.${name}` || table[1]!.startsWith(`mcp_servers.${name}.`));
    return !skipped;
  }).join("");
  const actual = Bun.TOML.parse(result) as typeof expected;
  if (expected.mcp_servers && !Object.keys(expected.mcp_servers).length && !actual.mcp_servers) delete expected.mcp_servers;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("removal_config", "Customized MCP tables need reconciliation; no configuration was changed.");
  return result;
}
export async function removeApplication(home: string, configs: string[], dryRun = false) {
  const p = layout(home); verifyInstallation(p.home);
  const edits = [...new Set(configs.map(path => resolve(path)))].map(path => {
    regular(path); const before = readFileSync(path, "utf8");
    return { path, before, after: removeMcp(before, p.home), mode: present(path)!.mode & 0o777 };
  });
  const plan = { home: p.home, remove: [p.app, p.bin, join(p.home, "runtime")], configs: edits.filter(item => item.before !== item.after).map(item => item.path), preserve: "All root data, keys, registrations, helper state, receiver ownership and logs. No data erasure." };
  if (dryRun) return plan;
  if (process.platform === "darwin" && present(p.plist)) await serviceCommand("disable", p.home);
  if (storeInUse(p.home)) fail("removal_busy", "Stop the foreground service and settle connector consumers before removal.");
  const release = claimInstallation(p.home);
  try {
    for (const item of edits) {
      if (readFileSync(item.path, "utf8") !== item.before) fail("removal_changed", "Configuration changed after preflight; retry with its current contents.");
      if (item.after !== item.before) atomicWrite(item.path, item.after, item.mode);
    }
    verifyInstallation(p.home);
    for (const path of plan.remove) rmSync(path, { recursive: true });
  } finally { release(); }
  return plan;
}
