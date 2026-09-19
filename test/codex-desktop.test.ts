import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagerBinding } from "../src/contracts.ts";
import { CodexDesktopLifecycle } from "../src/hosts/codex/desktop.ts";
import type { DesktopOwner, DesktopProfile } from "../src/hosts/codex/desktop-owner.ts";
import { localRecipient } from "../src/local/channel.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const taskId = "00000000-0000-7000-8000-000000000001";
const binding: ManagerBinding = { id: "manager", label: "Manager", origin: { hostId: "codex-desktop", managerId: taskId, assignmentId: taskId, generation: 1 }, recipient: localRecipient };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "seeker-desktop-test-")); directories.push(directory);
  const profile: DesktopProfile = { appPath: "/Applications/Registered.app", appVersion: "1.0.0", appBuild: "1", userDataPath: "/private/desktop-profile", codexHome: "/private/codex-home", sqliteHome: "/private/codex-sqlite" };
  const owner: DesktopOwner = {
    profile,
    app: { pid: 101, parentPid: 1, startedAt: "Sat Sep 19 10:00:00 2026", executable: `${profile.appPath}/Contents/MacOS/Registered` },
    server: { pid: 102, parentPid: 101, startedAt: "Sat Sep 19 10:00:01 2026", executable: `${profile.appPath}/Contents/Resources/codex` },
  };
  let instances = [{ app: owner.app, server: owner.server, userDataPath: profile.userDataPath }];
  const opened: { profile: DesktopProfile; taskId: string }[] = [];
  const operations = {
    inspect: async () => instances,
    open: async (value: DesktopProfile, id: string, signal: AbortSignal) => { signal.throwIfAborted(); opened.push({ profile: value, taskId: id }); },
  };
  const statePath = join(directory, "codex-desktop.json");
  const lifecycle = new CodexDesktopLifecycle(statePath, operations);
  return { statePath, owner, profile, opened, operations, lifecycle, instances: (value: typeof instances) => { instances = value; } };
}

test("only an admitted native manager pins durable Desktop recovery, without borrowing legacy identity", async () => {
  const f = fixture();
  await f.lifecycle.connected(undefined); await f.lifecycle.admitted(undefined);
  expect(existsSync(f.statePath)).toBe(false);
  await f.lifecycle.connected(f.owner);
  expect(existsSync(f.statePath)).toBe(false);
  await f.lifecycle.admitted(f.owner);
  expect(JSON.parse(readFileSync(f.statePath, "utf8"))).toEqual({ version: 1, owner: f.owner });
  expect(statSync(f.statePath).mode & 0o777).toBe(0o600);
  await expect(f.lifecycle.connected(undefined)).rejects.toThrow();
  expect(() => f.lifecycle.ready(undefined)).toThrow();
  f.lifecycle.ready(f.owner);
});

test("service restart can reuse the pinned live owner or start its stopped profile and original task", async () => {
  const f = fixture();
  await f.lifecycle.connected(f.owner); await f.lifecycle.admitted(f.owner);
  const restarted = new CodexDesktopLifecycle(f.statePath, f.operations);
  await restarted.resume(binding, new AbortController().signal);
  expect(f.opened).toEqual([{ profile: f.profile, taskId }]);
  f.instances([]);
  await restarted.resume(binding, new AbortController().signal);
  expect(f.opened[1]).toEqual({ profile: f.profile, taskId });
});

test("an unknown running instance must qualify the same profile before it can be navigated", async () => {
  const f = fixture();
  await f.lifecycle.connected(f.owner); await f.lifecycle.admitted(f.owner);
  const replacement: DesktopOwner = { ...f.owner, app: { ...f.owner.app, pid: 201 }, server: { ...f.owner.server, pid: 202, parentPid: 201 } };
  f.instances([{ app: replacement.app, server: replacement.server, userDataPath: f.profile.userDataPath }]);
  await expect(f.lifecycle.resume(binding, new AbortController().signal)).rejects.toThrow("different Desktop instance");
  expect(f.opened).toHaveLength(0);
  await expect(f.lifecycle.connected({ ...replacement, profile: { ...replacement.profile, codexHome: "/private/other-home" } })).rejects.toThrow("different registered Desktop profile");
  await f.lifecycle.connected(replacement);
  await f.lifecycle.resume(binding, new AbortController().signal);
  expect(f.opened).toHaveLength(1);
  expect(() => f.lifecycle.ready(f.owner)).toThrow("registered Desktop owner");
});

test("multiple running instances and changed native storage cannot replace registration", async () => {
  const f = fixture();
  await f.lifecycle.connected(f.owner); await f.lifecycle.admitted(f.owner);
  f.instances([
    { app: f.owner.app, server: f.owner.server, userDataPath: f.profile.userDataPath },
    { app: { ...f.owner.app, pid: 201 }, server: { ...f.owner.server, pid: 202, parentPid: 201 }, userDataPath: f.profile.userDataPath },
  ]);
  await expect(f.lifecycle.resume(binding, new AbortController().signal)).rejects.toThrow("More than one Desktop");
  await expect(f.lifecycle.connected(f.owner)).rejects.toThrow("could not be verified");
  await expect(f.lifecycle.connected({ ...f.owner, profile: { ...f.profile, sqliteHome: "/private/other-sqlite" } })).rejects.toThrow("different registered Desktop profile");
  expect(f.opened).toHaveLength(0);
  expect(JSON.parse(readFileSync(f.statePath, "utf8")).owner).toEqual(f.owner);
});

test("cancellation after owner inspection prevents the launch command", async () => {
  const f = fixture();
  await f.lifecycle.connected(f.owner); await f.lifecycle.admitted(f.owner);
  const controller = new AbortController();
  const cancelled = new CodexDesktopLifecycle(f.statePath, { ...f.operations, inspect: async () => { controller.abort(); return []; } });
  await expect(cancelled.resume(binding, controller.signal)).rejects.toThrow();
  expect(f.opened).toHaveLength(0);
});
