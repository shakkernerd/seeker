import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installApplication, verifyInstallation } from "../src/install/application.ts";
import { relocateMcp, migrateState } from "../src/install/migration.ts";
import { connectEvents } from "../src/install/connector.ts";
import { removeApplication } from "../src/install/removal.ts";
import { servicePlist, managedLog } from "../src/install/service.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "si-"))); directories.push(root); chmodSync(root, 0o700);
  const source = join(root, "package"), home = join(root, "home"); mkdirSync(source, { mode: 0o700 });
  for (const path of ["dist", "bin", "docs"]) mkdirSync(join(source, path));
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "@shakkernerd/seeker", version: "0.1.0", engines: { bun: "1.4.2" } }));
  writeFileSync(join(source, "dist/cli.js"), 'console.log("Usage: seeker");');
  writeFileSync(join(source, "dist/codex-connector.mjs"), 'console.log("connector");');
  writeFileSync(join(source, "bin/seeker-codex"), '#!/bin/sh\nexit 0\n');
  for (const path of ["README.md", "LICENSE", ".bun-version"]) writeFileSync(join(source, path), "fixture");
  return { root, source, home, options: { home, packageDirectory: source, runtime: process.execPath } };
}
test("dry-run does not create a home; install and upgrade preserve private root state", async () => {
  const f = fixture(); const plan = await installApplication({ ...f.options, dryRun: true }); expect(plan.replace).toBe(false);
  expect(Bun.file(join(f.home, "app/installation.json")).size).toBe(0);
  await installApplication(f.options);
  writeFileSync(join(f.home, "access.key"), "retained-key", { mode: 0o600 });
  mkdirSync(join(f.home, "telegram-receivers"), { mode: 0o700 }); writeFileSync(join(f.home, "telegram-receivers/123.lock"), "owned", { mode: 0o600 });
  await installApplication(f.options);
  expect(readFileSync(join(f.home, "access.key"), "utf8")).toBe("retained-key");
  expect(readFileSync(join(f.home, "telegram-receivers/123.lock"), "utf8")).toBe("owned");
  expect(verifyInstallation(f.home).packageVersion).toBe("0.1.0");
  expect(readFileSync(join(f.home, "bin/seeker"), "utf8")).not.toContain(f.source);
});
test("unknown application collisions, changed files and symlink sources fail closed", async () => {
  const f = fixture(); mkdirSync(f.home, { mode: 0o700 }); mkdirSync(join(f.home, "app"));
  await expect(installApplication(f.options)).rejects.toThrow("without Seeker installation identity");
  rmSync(join(f.home, "app"), { recursive: true });
  symlinkSync("/etc/passwd", join(f.source, "dist/unrelated"));
  await expect(installApplication(f.options)).rejects.toThrow("link or special file");
  rmSync(join(f.source, "dist/unrelated")); await installApplication(f.options);
  writeFileSync(join(f.home, "app/unknown"), "preserve");
  await expect(installApplication(f.options)).rejects.toThrow("unknown additions");
  expect(readFileSync(join(f.home, "app/unknown"), "utf8")).toBe("preserve");
});
test("event-only connector preserves human admission and existing settings", async () => {
  const f = fixture(); await installApplication(f.options);
  const config = join(f.root, "config.toml"); const other = 'model = "unchanged"\n[mcp_servers.other]\ncommand = "/other"\n'; writeFileSync(config, other);
  connectEvents(f.home, config, true); expect(readFileSync(config, "utf8")).toBe(other);
  connectEvents(f.home, config); const first = readFileSync(config, "utf8");
  expect(JSON.parse(readFileSync(join(f.home, "cli/codex-connector.json"), "utf8")).hostId).toBe("codex-cli");
  expect(first.startsWith(other)).toBe(true); expect(first).not.toContain('"submit"');
  connectEvents(f.home, config); expect(readFileSync(config, "utf8")).toBe(first);
  expect(Bun.file(join(f.home, "exchanges.sqlite")).size).toBe(0);
});
test("MCP relocation changes only matched paths and preserves filters, trust and approvals", () => {
  const current = '# retained\nmodel = "same"\n[mcp_servers.seeker_events]\ncommand = "/old/bin/seeker-codex"\nargs = ["--config", "/old/data/codex-connector.json", "--runtime", "/old/bun"]\nenabled = false\nrequired = true\nenabled_tools = ["event_get"]\n[mcp_servers.seeker_events.tools]\nevent_get = { approval_mode = "prompt" }\n[projects."/other"]\ntrust_level = "trusted"\n';
  const result = relocateMcp(current, { fromData: "/old/data", fromLauncher: "/old/bin/seeker-codex", home: "/new" });
  expect(result).toContain('args = ["--config","/new/codex-connector.json","--runtime","/new/runtime/bun"]');
  expect(result).toContain('enabled = false\nrequired = true\nenabled_tools = ["event_get"]');
  expect(result).toContain('[projects."/other"]\ntrust_level = "trusted"');
  expect(() => relocateMcp(current, { fromData: "/other", fromLauncher: "/old/bin/seeker-codex", home: "/new" })).toThrow("does not match");
});
test("migration rejects an active writer and collisions, then moves same private data", async () => {
  const f = fixture(); await installApplication(f.options);
  const from = join(f.root, "old"); mkdirSync(from, { mode: 0o700 });
  const store = new SqliteExchangeStore(join(from, "exchanges.sqlite"));
  const options = { home: f.home, fromData: from, fromLauncher: "/old/bin/seeker-codex", configs: [] };
  await expect(migrateState(options)).rejects.toThrow("Stop the source service"); store.close();
  writeFileSync(join(from, "access.key"), "same-private-key", { mode: 0o600 });
  writeFileSync(join(from, "codex.key"), "a".repeat(64), { mode: 0o600 });
  writeFileSync(join(from, "codex-connector.json"), JSON.stringify({ version: 2, hostId: "codex-desktop", socketPath: join(from, "codex.sock"), credentialFile: join(from, "codex.key") }), { mode: 0o600 });
  writeFileSync(join(f.home, "access.key"), "collision", { mode: 0o600 });
  await expect(migrateState(options)).rejects.toThrow("Destination collision"); rmSync(join(f.home, "access.key"));
  await migrateState(options);
  expect(readFileSync(join(f.home, "access.key"), "utf8")).toBe("same-private-key");
  expect(JSON.parse(readFileSync(join(f.home, "codex-connector.json"), "utf8")).credentialFile).toBe(join(f.home, "codex.key"));
  expect(Bun.file(join(from, "exchanges.sqlite")).size).toBe(0);
  const reopened = new SqliteExchangeStore(join(f.home, "exchanges.sqlite")); reopened.close();
});
test("service uses one installed process, crash-only keepalive and private bounded logs", () => {
  const f = fixture(); mkdirSync(f.home, { mode: 0o700 });
  const plist = servicePlist(f.home, "/qualified/bin:/usr/bin");
  expect(plist).toContain("com.seeker.service"); expect(plist).toContain("<key>SuccessfulExit</key><false/>"); expect(plist).toContain("<key>ThrottleInterval</key><integer>10</integer>");
  const log = managedLog(f.home); writeFileSync(join(f.home, "logs/service.log"), Buffer.alloc(10 * 1024 * 1024), { mode: 0o600 });
  log("bounded diagnostic"); expect(readFileSync(join(f.home, "logs/service.log"), "utf8")).toContain("bounded diagnostic");
  expect(Bun.file(join(f.home, "logs/service.log.1")).size).toBe(10 * 1024 * 1024);
});

test("explicit removal deletes only verified application paths and matching MCP entries", async () => {
  const f = fixture(); await installApplication(f.options);
  const config = join(f.root, "host.toml"); writeFileSync(config, 'model = "same"\n[mcp_servers.unrelated]\ncommand = "/keep"\n');
  connectEvents(f.home, config);
  writeFileSync(join(f.home, "access.key"), "retained", { mode: 0o600 });
  await removeApplication(f.home, [config]);
  expect(readFileSync(join(f.home, "access.key"), "utf8")).toBe("retained");
  expect(Bun.TOML.parse(readFileSync(config, "utf8"))).toEqual({ model: "same", mcp_servers: { unrelated: { command: "/keep" } } });
  expect(Bun.file(join(f.home, "app/installation.json")).size).toBe(0);
});

test("event connector setup upgrades a tool list it generated earlier and preserves a custom one", async () => {
  const f = fixture(); await installApplication(f.options);
  const config = join(f.root, "config.toml");
  expect((connectEvents(f.home, config) as { changed: boolean }).changed).toBe(true);
  const written = readFileSync(config, "utf8");
  expect(written).toContain('"event_watch"');
  const older = written.replace(/enabled_tools = \[[^\n]*\]/, 'enabled_tools = ["event_arm", "event_get", "event_pending", "event_cancel", "event_resume", "event_acknowledge", "event_clear"]');
  writeFileSync(config, older);
  expect((connectEvents(f.home, config, true) as { changed: boolean }).changed).toBe(true);
  expect(readFileSync(config, "utf8")).toBe(older);
  connectEvents(f.home, config);
  expect(readFileSync(config, "utf8")).toBe(written);
  const custom = written.replace(/enabled_tools = \[[^\n]*\]/, 'enabled_tools = ["event_get", "event_pending"]');
  writeFileSync(config, custom);
  expect(connectEvents(f.home, config, true)).toMatchObject({ changed: false, enabledTools: expect.stringContaining("preserved") });
  connectEvents(f.home, config);
  expect(readFileSync(config, "utf8")).toBe(custom);
});
