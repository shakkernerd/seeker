import { describe, expect, test } from "bun:test";
import { desktopAppFromRuntime, desktopSqliteFromFiles, desktopUserDataFromArguments, parseDesktopOwner, parseDesktopProcesses, sameDesktopProcess, type DesktopOwner } from "../src/hosts/codex/desktop-owner.ts";

const bundle = "/Applications/ChatGPT.app";
const effectiveUid = 501;
function owner(): DesktopOwner {
  return {
    profile: { appPath: bundle, appVersion: "26.915.31945", appBuild: "9922", userDataPath: "/Users/example/Library/Application Support/Codex", codexHome: "/Users/example/.codex", sqliteHome: "/Users/example/codex-state" },
    app: { pid: 100, parentPid: 1, startedAt: "Sat Sep 19 09:00:00 2026", executable: `${bundle}/Contents/MacOS/ChatGPT` },
    server: { pid: 101, parentPid: 100, startedAt: "Sat Sep 19 09:00:01 2026", executable: `${bundle}/Contents/Resources/codex` },
  };
}

describe("Desktop process ownership", () => {
  test("recognizes the executing bundled runtime, not an inherited runtime path claim", () => {
    expect(desktopAppFromRuntime(`${bundle}/Contents/Resources/cua_node/bin/node`)).toBe(bundle);
    for (const runtime of ["/usr/local/bin/node", "/opt/bun", `${bundle}/Contents/Resources/node`, "/tmp/cua_node/bin/node", `${bundle}/Contents/Resources/cua_node/bin/../bin/node`]) {
      expect(() => desktopAppFromRuntime(runtime)).toThrow();
    }
  });

  test("parses executable paths with spaces and retains independent process start identities", () => {
    const processes = parseDesktopProcesses(`    0     0     0 Sat Sep 19 08:59:00 2026 kernel_task\n  501   100     1 Sat Sep 19 09:00:00 2026 ${bundle}/Contents/MacOS/ChatGPT\n  501   102   100 Sat Sep 19 09:00:02 2026 ${bundle}/Contents/Frameworks/Codex Framework.framework/Versions/153.0.8010.48/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)\n`, effectiveUid);
    expect(processes).toHaveLength(2);
    expect(processes[0]).toEqual(owner().app);
    expect(processes[1]!.executable).toContain("Codex Framework.framework");
    expect(sameDesktopProcess(owner().app, { ...owner().app })).toBe(true);
    for (const change of [{ startedAt: "Sat Sep 19 09:00:03 2026" }, { pid: 102 }, { parentPid: 2 }, { executable: "/tmp/ChatGPT" }]) {
      expect(sameDesktopProcess(owner().app, { ...owner().app, ...change })).toBe(false);
    }
    expect(() => parseDesktopProcesses("501 100 malformed metadata", effectiveUid)).toThrow();
    expect(() => parseDesktopProcesses(`501 100 1 Sat Sep 19 09:00:00 2026 /a\n501 100 1 Sat Sep 19 09:00:01 2026 /b`, effectiveUid)).toThrow();
  });

  test("foreign effective UIDs are excluded before malformed or decoy owner fields are parsed", () => {
    const local = `501 100 1 Sat Sep 19 09:00:00 2026 ${bundle}/Contents/MacOS/ChatGPT`;
    const foreign = [
      `502 200 1 Sat Sep 19 09:00:00 2026 ${bundle}/Contents/MacOS/ChatGPT`,
      `502 100 1 Sat Sep 19 09:00:00 2026 ${bundle}/Contents/MacOS/ChatGPT`,
      `0 101 100 Sat Sep 19 09:00:01 2026 ${bundle}/Contents/Resources/codex`,
      `502 malformed process fields ${bundle}/Contents/MacOS/ChatGPT`,
      "502 102 100 invalid-start relative/path",
    ].join("\n");
    expect(parseDesktopProcesses(`${foreign}\n${local}`, effectiveUid)).toEqual([owner().app]);
    expect(parseDesktopProcesses(foreign, effectiveUid)).toEqual([]);
    expect(() => parseDesktopProcesses(local, Number.NaN)).toThrow();
  });

  test("an unrelated non-normalized process path cannot block or impersonate a Desktop owner", () => {
    const [entry] = parseDesktopProcesses("501 200 1 Sat Sep 19 09:00:00 2026 /opt/tool/bin/../lib/tool\n", effectiveUid);
    expect(entry?.executable).toBe("/opt/tool/bin/../lib/tool");
    expect(() => parseDesktopOwner({ ...owner(), app: entry })).toThrow();
    expect(() => parseDesktopOwner({ ...owner(), app: { ...owner().app, executable: `${bundle}/Contents/Resources/../MacOS/ChatGPT` } })).toThrow();
  });

  test("private IPC rejects swapped bundles, indirect owners, and extra caller-selected fields", () => {
    const value = owner();
    expect(parseDesktopOwner(value)).toEqual(value);
    const cases = [
      { ...value, role: "manager" },
      { ...value, server: { ...value.server, parentPid: 200 } },
      { ...value, server: { ...value.server, executable: "/usr/local/bin/codex" } },
      { ...value, app: { ...value.app, executable: "/Applications/Other.app/Contents/MacOS/Other" } },
      { ...value, app: { ...value.app, startedAt: "unknown" } },
      { ...value, profile: { ...value.profile, userDataPath: "relative/profile" } },
      { ...value, profile: { ...value.profile, codexHome: "/Users/example/../other" } },
      { ...value, profile: { ...value.profile, launchArguments: ["--unsafe"] } },
    ];
    for (const candidate of cases) expect(() => parseDesktopOwner(candidate)).toThrow();
    const parsed = parseDesktopOwner(value); parsed.app.pid = 999;
    expect(value.app.pid).toBe(100);
  });
});

describe("narrow Desktop profile metadata", () => {
  test("extracts the native selector with spaces without exposing unrelated arguments", () => {
    const directory = owner().profile.userDataPath;
    expect(desktopUserDataFromArguments(`/native/Codex (Renderer) --type=renderer --user-data-dir=${directory} --lang=en-US --private-value=do-not-return`)).toBe(directory);
    expect(desktopUserDataFromArguments(`/native/Codex --user-data-dir=${directory}`)).toBe(directory);
    expect(desktopUserDataFromArguments("/native/Codex --type=gpu-process")).toBeUndefined();
  });

  test("rejects duplicate, missing, relative, multiline, and unqualified selector forms", () => {
    const malformed = [
      "/native/Codex --user-data-dir=/a --user-data-dir=/b",
      "/native/Codex --user-data-dir=",
      "/native/Codex --user-data-dir=relative",
      "/native/Codex --user-data-dir /a",
      '/native/Codex --user-data-dir="/a b"',
      "/native/Codex --user-data-dir=/a\n--private-value=do-not-return",
      "/native/Codex --user-data-dir=/a/../b",
    ];
    for (const command of malformed) {
      let thrown: unknown;
      try { desktopUserDataFromArguments(command); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).not.toContain("do-not-return");
    }
  });

  test("SQLite FDs prove only one agreeing queue/state root, independently of code home", () => {
    const prefix = "p101\nfcwd\nn/Users/example\nf7\nn/Users/example/private-unrelated-file\n";
    expect(desktopSqliteFromFiles(`${prefix}n/Users/example/codex-state/state_5.sqlite\nn/Users/example/codex-state/queue_1.sqlite\nn/Users/example/codex-state/state_5.sqlite-wal\n`)).toBe("/Users/example/codex-state");
    expect(desktopSqliteFromFiles(`${prefix}n/Users/example/codex-state/state_5.sqlite\n`)).toBeUndefined();
    expect(desktopSqliteFromFiles(prefix)).toBeUndefined();
    for (const files of [
      "n/a/state_5.sqlite\nn/b/queue_1.sqlite\n",
      "n/a/state_5.sqlite\nn/a/queue_1.sqlite\nn/b/state_5.sqlite\n",
      "n/a/state_5.sqlite\nn/a/queue_1.sqlite\nn/b/queue_1.sqlite\n",
    ]) expect(() => desktopSqliteFromFiles(files)).toThrow();
  });
});
