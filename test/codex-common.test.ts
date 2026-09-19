import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationPermissionRestrictions, installSection } from "../src/hosts/codex-common/install.ts";
import { seekerTools } from "../src/hosts/codex/tools.ts";
import { maxWireBytes } from "../src/hosts/codex/protocol.ts";

const launcher = "/opt/seeker/bin/seeker-codex";
const configPath = "/private/seeker/codex-connector.json";
const bunRuntime = process.execPath;
const runtimeDirectories: string[] = [];
afterEach(() => { for (const directory of runtimeDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function runtimeFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "seeker-runtime-"));
  runtimeDirectories.push(directory);
  const path = join(directory, "bun");
  symlinkSync(bunRuntime, path);
  return path;
}
const legacyEnvironment = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH"];
const desktopEnvironment = [...legacyEnvironment, "CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_SQLITE_HOME"];
const prefix = 'model = "fixture-model"\n[permissions]\ndefault = "read-only"\n[mcp_servers.other]\ncommand = "other-tool"\n';
const suffix = '\n[analytics]\nenabled = false\n';
function existingSection(env: string[]) {
  return [
    "# Seeker native connector: begin", "[mcp_servers.seeker]",
    `command = ${JSON.stringify(launcher)}`, `args = ["--config", ${JSON.stringify(configPath)}]`,
    `env_vars = ${JSON.stringify(env)}`, "enabled = false", "required = true", "startup_timeout_sec = 3.5", "tool_timeout_sec = 45",
    "# Seeker native connector: end",
  ].join("\n");
}
function section(text: string): Record<string, unknown> {
  return (Bun.TOML.parse(text) as { mcp_servers: { seeker: Record<string, unknown> } }).mcp_servers.seeker;
}

test("three-argument setup records the current runtime without changing unrelated configuration", () => {
  const result = installSection(prefix, launcher, configPath);
  expect(result.startsWith(prefix)).toBe(true);
  expect(section(result)).toEqual({ command: launcher, args: ["--config", configPath, "--runtime", process.execPath], env_vars: desktopEnvironment,
    enabled: true, required: false, startup_timeout_sec: 10, tool_timeout_sec: 15 });
  expect(Bun.TOML.parse(result)).toMatchObject({ model: "fixture-model", permissions: { default: "read-only" }, mcp_servers: { other: { command: "other-tool" } } });
  expect(installSection(result, launcher, configPath)).toBe(result);
});

for (const [name, environment] of [["legacy two-variable", legacyEnvironment], ["current Desktop", desktopEnvironment]] as const) {
  test(`${name} setup migrates arguments and preserves operator lifecycle settings`, () => {
    const original = `${prefix}${existingSection([...environment])}${suffix}`;
    const result = installSection(original, "/opt/new-seeker/bin/seeker-codex", configPath, bunRuntime);
    expect(result.startsWith(prefix)).toBe(true); expect(result.endsWith(suffix)).toBe(true);
    expect(section(result)).toEqual({ command: "/opt/new-seeker/bin/seeker-codex", args: ["--config", configPath, "--runtime", bunRuntime], env_vars: desktopEnvironment,
      enabled: false, required: true, startup_timeout_sec: 3.5, tool_timeout_sec: 45 });
    expect(installSection(result, "/opt/new-seeker/bin/seeker-codex", configPath)).toBe(result);
  });
}

test("CLI and Desktop setup coexist in either order without replacing a usable recorded fallback", () => {
  const cliRuntime = runtimeFixture();
  const cliFirst = installSection(prefix, launcher, configPath, cliRuntime);
  expect(installSection(cliFirst, launcher, configPath)).toBe(cliFirst);
  const desktopFirst = installSection(prefix, launcher, configPath);
  expect(installSection(desktopFirst, launcher, configPath, cliRuntime)).toBe(desktopFirst);
  const relocated = installSection(cliFirst, "/opt/updated-seeker/bin/seeker-codex", configPath, bunRuntime);
  expect(section(relocated).args).toEqual(["--config", configPath, "--runtime", cliRuntime]);
  expect(section(relocated).command).toBe("/opt/updated-seeker/bin/seeker-codex");
  expect(relocated.match(/\[mcp_servers\.seeker\]/g)).toHaveLength(1);
});

test.each(["removed", "nonexecutable"] as const)("setup repairs a %s recorded runtime without changing native settings", (unavailable) => {
  const previousRuntime = runtimeFixture();
  const original = installSection(`${prefix}${existingSection(desktopEnvironment)}${suffix}`, launcher, configPath, previousRuntime);
  // Remove the fixture symlink before replacing it; never change the real Bun executable.
  rmSync(previousRuntime);
  if (unavailable === "nonexecutable") writeFileSync(previousRuntime, "Unavailable runtime fixture", { mode: 0o600 });
  const repaired = installSection(original, launcher, configPath, bunRuntime);
  expect(section(repaired)).toEqual({ ...section(original), args: ["--config", configPath, "--runtime", bunRuntime] });
  expect(repaired.startsWith(prefix)).toBe(true); expect(repaired.endsWith(suffix)).toBe(true);
  expect(installSection(repaired, launcher, configPath, bunRuntime)).toBe(repaired);
});

test("setup rejects data-directory redirection, custom fields and unrecognized launch arguments", () => {
  const original = existingSection(desktopEnvironment);
  expect(() => installSection(original, launcher, "/another/codex-connector.json", bunRuntime)).toThrow("different Seeker data directory");
  expect(() => installSection('[mcp_servers.seeker]\ncommand = "mine"\n', launcher, configPath, bunRuntime)).toThrow("already exists");
  for (const customized of [
    original.replace("# Seeker native connector: end", 'custom_permission = "prompt"\n# Seeker native connector: end'),
    `${original}\ndefault_tools_approval_mode = "prompt"\n`,
    original.replace('args = ["--config",', 'args = ["--other",'),
    original.replace(JSON.stringify(desktopEnvironment), JSON.stringify([...desktopEnvironment, "EXTRA_ENV"])),
    original.replace(JSON.stringify(desktopEnvironment), JSON.stringify([...desktopEnvironment].reverse())),
    installSection("", launcher, configPath, bunRuntime).replace(JSON.stringify(bunRuntime), '"relative-bun"'),
  ]) expect(() => installSection(customized, launcher, configPath, bunRuntime)).toThrow(/custom/);
  expect(() => installSection("", launcher, configPath, "bun")).toThrow("absolute path");
});

test("setup refuses ambiguous ownership markers and invalid lifecycle settings", () => {
  const original = existingSection(desktopEnvironment);
  for (const ambiguous of [
    original.replace("# Seeker native connector: begin", ""),
    original.replace("# Seeker native connector: end", ""),
    `${original}\n# Seeker native connector: begin\n`,
    `${original}\n# Seeker native connector: end\n`,
  ]) expect(() => installSection(ambiguous, launcher, configPath, bunRuntime)).toThrow("markers");
  expect(() => installSection(original.replace("required = true", 'required = "true"'), launcher, configPath, bunRuntime)).toThrow("lifecycle settings");
  expect(() => installSection(original.replace("tool_timeout_sec = 45", "tool_timeout_sec = 0"), launcher, configPath, bunRuntime)).toThrow("timeout settings");
});

function permissionSection(permissions: string, enabled = true): string {
  return `${prefix}${existingSection(desktopEnvironment).replace("enabled = false", `enabled = ${enabled}`).replace("# Seeker native connector: end", `${permissions}\n# Seeker native connector: end`)}${suffix}`;
}

test("ordinary setup preserves native approval modes, filters, output limits and unrelated tools", () => {
  const original = permissionSection([
    'default_tools_approval_mode = "writes"', 'enabled_tools = ["get", "pending", "future.operation"]', 'disabled_tools = ["submit"]',
    '[mcp_servers.seeker.tools]', 'submit = { approval_mode = "prompt", output_token_limit = 80 }', 'get = { approval_mode = "approve" }',
    'pending = { approval_mode = "auto" }', 'update = { approval_mode = "writes" }', '"future.operation" = { approval_mode = "prompt", output_token_limit = 40 }', 'empty = {}',
  ].join("\n"), false);
  const result = installSection(original, launcher, configPath);
  expect(section(result)).toEqual({ ...section(original), args: ["--config", configPath, "--runtime", process.execPath] });
  expect(result.startsWith(prefix)).toBe(true); expect(result.endsWith(suffix)).toBe(true);
  expect(installSection(result, launcher, configPath, bunRuntime, "preserve")).toBe(result);
  expect(conversationPermissionRestrictions(result)).toContain("The Seeker connector is disabled (enabled = false).");
  expect(conversationPermissionRestrictions(prefix)).toEqual(["The Seeker connector is not configured."]);
});

test("allow grants exactly four literal tools and preserves other tool policy and existing output limits", () => {
  const original = permissionSection([
    '[mcp_servers.seeker.tools]', 'get = { approval_mode = "approve", output_token_limit = 80 }', 'pending = { output_token_limit = 40 }',
    '"future.operation" = { approval_mode = "prompt", output_token_limit = 20 }', 'unknown_future_tool = {}',
  ].join("\n"));
  const result = installSection(original, launcher, configPath, bunRuntime, "allow");
  expect(section(result).tools).toEqual({
    submit: { approval_mode: "approve" }, get: { approval_mode: "approve", output_token_limit: 80 },
    pending: { approval_mode: "approve", output_token_limit: 40 }, update: { approval_mode: "approve" },
    "future.operation": { approval_mode: "prompt", output_token_limit: 20 }, unknown_future_tool: {},
  });
  expect(section(result).default_tools_approval_mode).toBeUndefined();
  expect(conversationPermissionRestrictions(result)).toEqual([]);
  expect(installSection(result, launcher, configPath, bunRuntime, "allow")).toBe(result);
  expect(installSection(result, launcher, configPath)).toBe(result);
  const fresh = installSection(prefix, launcher, configPath, bunRuntime, "allow");
  expect(section(fresh).tools).toEqual({ submit: { approval_mode: "approve" }, get: { approval_mode: "approve" }, pending: { approval_mode: "approve" }, update: { approval_mode: "approve" } });
  expect(conversationPermissionRestrictions(installSection(prefix, launcher, configPath, bunRuntime))).toHaveLength(4);
});

test("allow rejects every deliberate effective policy or enable/filter conflict before returning a grant", () => {
  const conflicts = [
    ...["auto", "prompt", "writes"].map((mode) => permissionSection(`default_tools_approval_mode = "${mode}"`)),
    ...["auto", "prompt", "writes"].map((mode) => permissionSection(`[mcp_servers.seeker.tools.update]\napproval_mode = "${mode}"`)),
    permissionSection("", false), permissionSection('enabled_tools = ["submit", "get", "pending"]'), permissionSection('disabled_tools = ["update"]'),
  ];
  for (const original of conflicts) {
    let result = original;
    expect(() => { result = installSection(original, launcher, configPath, bunRuntime, "allow"); }).toThrow("explicitly replace");
    expect(result).toBe(original);
  }
  const multiple = permissionSection('disabled_tools = ["update"]\n[mcp_servers.seeker.tools.submit]\napproval_mode = "prompt"');
  expect(() => installSection(multiple, launcher, configPath, bunRuntime, "allow")).toThrow(/submit.*prompt.*update.*disabled_tools/);
});

test("existing per-tool approval takes precedence over the preserved server default", () => {
  const original = permissionSection([
    'default_tools_approval_mode = "prompt"', 'enabled_tools = ["submit", "get", "pending", "update"]', 'disabled_tools = ["future"]',
    '[mcp_servers.seeker.tools]', ...["submit", "get", "pending", "update"].map((name) => `${name} = { approval_mode = "approve" }`),
    'future = { approval_mode = "prompt" }',
  ].join("\n"));
  const result = installSection(original, launcher, configPath, bunRuntime, "allow");
  expect(section(result)).toEqual({ ...section(original), args: ["--config", configPath, "--runtime", bunRuntime] });
  expect(conversationPermissionRestrictions(result)).toEqual([]);
  expect(installSection(result, launcher, configPath, bunRuntime, "allow")).toBe(result);
});

test("replace changes only the four approval leaves and reports the enable/filter restrictions it preserves", () => {
  const original = permissionSection([
    'default_tools_approval_mode = "prompt"', 'enabled_tools = ["get", "pending", "future.operation"]', 'disabled_tools = ["update", "future.operation"]',
    '[mcp_servers.seeker.tools]', 'submit = { approval_mode = "writes", output_token_limit = 80 }', 'get = { approval_mode = "auto" }',
    'pending = { output_token_limit = 40 }', 'update = { approval_mode = "prompt" }', '"future.operation" = { approval_mode = "prompt", output_token_limit = 20 }',
  ].join("\n"), false);
  const result = installSection(original, launcher, configPath, bunRuntime, "replace");
  expect(section(result)).toEqual({ ...section(original), args: ["--config", configPath, "--runtime", bunRuntime], tools: {
    submit: { approval_mode: "approve", output_token_limit: 80 }, get: { approval_mode: "approve" },
    pending: { approval_mode: "approve", output_token_limit: 40 }, update: { approval_mode: "approve" },
    "future.operation": { approval_mode: "prompt", output_token_limit: 20 },
  } });
  expect(conversationPermissionRestrictions(result)).toEqual([
    "The Seeker connector is disabled (enabled = false).", "Seeker submit is excluded by enabled_tools.",
    "Seeker update is excluded by enabled_tools.", "Seeker update is disabled by disabled_tools.",
  ]);
  expect(result.startsWith(prefix)).toBe(true); expect(result.endsWith(suffix)).toBe(true);
  expect(installSection(result, launcher, configPath, bunRuntime, "replace")).toBe(result);
  expect(installSection(result, launcher, configPath)).toBe(result);
  expect(() => installSection(result, launcher, configPath, bunRuntime, "allow")).toThrow("disabled");
});

test("all permission modes reject malformed native fields and custom tool settings instead of dropping them", () => {
  const invalid = [
    'default_tools_approval_mode = "deny"', 'enabled_tools = "submit"', 'disabled_tools = [1]', 'tools = ["submit"]',
    '[mcp_servers.seeker.tools.submit]\napproval_mode = "deny"', '[mcp_servers.seeker.tools.submit]\nenabled = false',
    ...["0", "-1", "1.5", '"80"'].map((limit) => `[mcp_servers.seeker.tools.future]\noutput_token_limit = ${limit}`),
  ];
  for (const permissions of ["preserve", "allow", "replace"] as const) {
    for (const settings of invalid) expect(() => installSection(permissionSection(settings), launcher, configPath, bunRuntime, permissions)).toThrow();
  }
  expect(() => conversationPermissionRestrictions(permissionSection(invalid[0]!))).toThrow("approval mode");
});

test("shared stdio preserves schemas, trusted invocation identity, cancellation and request bounds", async () => {
  const module = new URL("../src/hosts/codex-common/mcp.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "--no-install", "--eval", `
    import { serveSeekerTools } from ${JSON.stringify(module)};
    let closed = false;
    await serveSeekerTools({
      async invoke(origin, operation, args, signal) {
        if (operation === "pending") await new Promise(resolve => {
          signal.addEventListener("abort", resolve, { once: true });
          if (signal.aborted) resolve();
        });
        return { origin, operation, args, cancelled: signal.aborted };
      },
      close() { closed = true; }
    });
    console.log(JSON.stringify({ fixtureClosed: closed }));
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 8_000, killSignal: "SIGKILL", maxBuffer: 2 * maxWireBytes });
  const messages: Array<Record<string, any>> = [];
  const consume = (async () => {
    const decoder = new TextDecoder(); let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
    }
  })();
  const errors = new Response(child.stderr).text();
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const until = async (predicate: (message: Record<string, any>) => boolean) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const message = messages.find(predicate); if (message) return message;
      if (child.exitCode !== null) throw new Error("Controlled MCP process exited before its response.");
      await Bun.sleep(5);
    }
    throw new Error("Controlled MCP response timed out.");
  };
  const metadata = { threadId: "fixture-manager", callId: "fixture-call", "x-codex-turn-metadata": { thread_id: "fixture-manager", turn_id: "fixture-turn" } };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect((await until((item) => item.id === 1)).result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "seeker", version: "0.1.0" } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await until((item) => item.id === 2)).result.tools).toEqual(seekerTools);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get", arguments: { requestId: "request" }, _meta: metadata } });
    expect(JSON.parse((await until((item) => item.id === 3)).result.content[0].text)).toEqual({ origin: { threadId: "fixture-manager", turnId: "fixture-turn", callId: "fixture-call" }, operation: "get", args: { requestId: "request" }, cancelled: false });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get", arguments: {}, _meta: { ...metadata, threadId: "another-task" } } });
    expect(JSON.parse((await until((item) => item.id === 4)).result.content[0].text).error).toBe("origin_mismatch");
    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pending", arguments: {}, _meta: metadata } });
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } });
    expect(JSON.parse((await until((item) => item.id === 5)).result.content[0].text).cancelled).toBe(true);
    for (let index = 0; index < 16; index++) send({ jsonrpc: "2.0", id: `held-${index}`, method: "tools/call", params: { name: "pending", arguments: {}, _meta: metadata } });
    send({ jsonrpc: "2.0", id: "overflow", method: "ping" });
    expect((await until((item) => item.id === "overflow")).error.code).toBe(-32600);
    child.stdin.write(`${"x".repeat(maxWireBytes + 1)}\n`);
    expect((await until((item) => item.id === null && item.error?.message === "MCP request too large.")).error.code).toBe(-32600);
    child.stdin.end();
    expect(await child.exited).toBe(0); await consume;
    expect(messages.some((item) => item.fixtureClosed === true)).toBe(true);
    expect(await errors).toBe("");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited; await consume; await errors;
  }
}, 10_000);
