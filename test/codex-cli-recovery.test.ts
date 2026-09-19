import { afterEach, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectorError } from "../src/hosts/codex/protocol.ts";
import { findRunningCli, type CliOwner, type CliOwnerProbe, type RegisteredCliOwner } from "../src/hosts/codex-cli/owner.ts";
import { createNativeCliRuntime, type CliRuntimeOperations, type NativeCliConnection } from "../src/hosts/codex-cli/runtime.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const signal = () => AbortSignal.timeout(2_000);

function ownerFixture() {
  const directory = realpathSync(mkdtempSync("/tmp/seeker-cli-owner-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, "codex"), socketPath = join(directory, "native.sock");
  const codexHome = join(directory, ".codex"), sqliteHome = join(directory, "sqlite"), cwd = join(directory, "work");
  for (const path of [codexHome, sqliteHome, cwd]) mkdirSync(path);
  // An inert file supplies filesystem identity; all process probes below are controlled.
  writeFileSync(executable, "owned executable metadata fixture", { mode: 0o700 });
  const server = Bun.serve({ unix: socketPath, fetch: () => new Response(null, { status: 503 }) });
  cleanups.push(async () => { await server.stop(true); });
  chmodSync(socketPath, 0o600);
  const file = statSync(executable);
  const previous: CliOwner = {
    process: { pid: 41001, parentPid: 1, uid: process.getuid!(), startedAt: "Sat Sep 19 10:00:00 2026", executable },
    codexHome, sqliteHome, cwd, listen: `unix://${socketPath}`, socketPath,
    executableFile: { dev: file.dev, ino: file.ino, size: file.size, mtimeMs: file.mtimeMs },
  };
  const current: CliOwner = { ...previous, process: { ...previous.process, pid: 41002, startedAt: "Sat Sep 19 10:01:00 2026" } };
  const observed = {
    process: { ...current.process }, home: codexHome, cwd,
    command: `${executable} app-server --listen ${previous.listen}`,
    files: [socketPath, join(sqliteHome, "state_5.sqlite")],
    pids: [current.process.pid], afterPids: undefined as number[] | undefined,
    changeProcess: false, fail: false, processReads: 0, socketReads: 0, homeReads: 0,
  };
  const probe: CliOwnerProbe = async (file, args, signal) => {
    signal.throwIfAborted();
    if (observed.fail) throw new ConnectorError("cli_probe_failed", "Controlled OS probe failure.");
    if (file === "/usr/sbin/lsof" && args.includes("-Fpn0")) {
      expect(args).toEqual(["-n", "-a", "-U", "-u", String(previous.process.uid), "-Fpn0"]);
      const pids = observed.socketReads++ === 0 ? observed.pids : observed.afterPids ?? observed.pids;
      return `p42000\0\nf7\0n${directory}/unrelated.sock\0\n${pids.map((pid) => `p${pid}\0\nf8\0n${socketPath}\0\n`).join("")}`;
    }
    expect(args[args.indexOf("-p") + 1]).toBe(String(current.process.pid));
    if (file === "/bin/ps" && args.at(-1) === "command=") return observed.command;
    if (file === "/bin/ps") {
      const process = observed.process;
      const startedAt = observed.changeProcess && observed.processReads++ > 0 ? "Sat Sep 19 10:02:00 2026" : process.startedAt;
      return `${process.pid} ${process.parentPid} ${process.uid} ${startedAt} ${process.executable}\n`;
    }
    const names = args.includes("cwd") ? [observed.cwd] : observed.files;
    return `p${current.process.pid}\n${names.map((name) => `n${name}\n`).join("")}`;
  };
  const readHome = (process: CliOwner["process"]) => { observed.homeReads += 1; expect(process).toEqual(observed.process); return observed.home; };
  const find = () => findRunningCli(previous, signal(), readHome, probe);
  return { previous, current, observed, find };
}

test("recovery independently verifies a current owner; an empty successful snapshot alone reports absence", async () => {
  const f = ownerFixture();
  expect(await f.find()).toEqual(f.current);
  expect(f.observed.homeReads).toBe(1);
  expect(f.observed.socketReads).toBe(2);
  f.observed.pids = [];
  expect(await f.find()).toBeUndefined();
  expect(f.observed.homeReads).toBe(1);
});

test.each(["home", "SQLite", "cwd", "listener", "executable", "executable file", "OS user", "process changed", "ambiguous", "disappeared", "probe failed"] as const)("recovery refuses %s evidence instead of treating it as absence", async (mismatch) => {
  const f = ownerFixture();
  if (mismatch === "home") f.observed.home = f.previous.cwd;
  else if (mismatch === "SQLite") f.observed.files[1] = join(f.previous.cwd, "state_5.sqlite");
  else if (mismatch === "cwd") f.observed.cwd = f.previous.codexHome;
  else if (mismatch === "listener") f.observed.command += ".other";
  else if (mismatch === "executable") f.observed.process.executable = "/different/codex";
  else if (mismatch === "executable file") f.previous.executableFile = { ...f.previous.executableFile, ino: f.previous.executableFile.ino + 1 };
  else if (mismatch === "OS user") f.observed.process.uid += 1;
  else if (mismatch === "process changed") f.observed.changeProcess = true;
  else if (mismatch === "ambiguous") f.observed.pids.push(41003);
  else if (mismatch === "disappeared") f.observed.afterPids = [];
  else f.observed.fail = true;
  await expect(f.find()).rejects.toBeInstanceOf(ConnectorError);
});

function recoveryFixture() {
  const { previous, current } = ownerFixture();
  const registration: RegisteredCliOwner = { version: 1, owner: previous, remoteControl: "disabled" };
  const calls: string[] = [];
  const behavior = { found: current as CliOwner | undefined, status: "disabled", initialNotice: false, changeMode: false, findError: false, changeOwner: false, findCount: 0 };
  const connections: NativeCliConnection[] = [];
  const operations: CliRuntimeOperations = {
    async verify() { throw new Error("Unexpected verification path"); },
    async gone() { calls.push("gone"); return true; },
    async find() {
      calls.push("find");
      if (behavior.findError) throw new ConnectorError("cli_probe_failed", "Controlled OS probe failure.");
      if (behavior.changeOwner && behavior.findCount++ > 0) return { ...current, process: { ...current.process, pid: 41003 } };
      return behavior.found;
    },
    async connect() {
      calls.push("connect");
      const rpc: NativeCliConnection & { connected: boolean } = {
        connected: true,
        async request<T>(method: string, params: unknown) {
          expect(method).toBe("remoteControl/status/read"); expect(params).toBeNull(); calls.push(method);
          if (behavior.initialNotice) this.onNotice?.("remoteControl/status/changed", { status: behavior.status });
          if (behavior.changeMode) this.onNotice?.("remoteControl/status/changed", { status: "connected" });
          return { status: behavior.status } as T;
        },
        close() { this.connected = false; calls.push("close"); },
      };
      connections.push(rpc); return rpc;
    },
    start() { calls.push("start"); throw new Error("Recovery must reuse or reject before starting a process"); },
    async capture() { throw new Error("Unexpected child capture"); },
    async readProcess() { throw new Error("Unexpected child inspection"); },
  };
  return { registration, current, calls, behavior, connections, operations, runtime: createNativeCliRuntime(operations) };
}

test.each(["disabled", "enabled"] as const)("a verified manual restart preserves %s mode before reuse", async (mode) => {
  const f = recoveryFixture();
  f.registration.remoteControl = mode;
  f.behavior.status = mode === "disabled" ? "disabled" : "connected";
  // Native startup also publishes its current mode; repeating that same value
  // must not be mistaken for a mode change on every fresh recovery connection.
  f.behavior.initialNotice = true;
  expect(await f.runtime.restart(f.registration, signal())).toEqual(f.current);
  expect(f.calls).toEqual(["gone", "find", "connect", "remoteControl/status/read", "find", "close"]);
  expect(f.connections[0]!.connected).toBe(false);
});

test.each(["probe failed", "wrong mode", "unknown mode", "changing mode", "changing owner"] as const)("%s cannot adopt or launch another native owner", async (failure) => {
  const f = recoveryFixture();
  if (failure === "probe failed") f.behavior.findError = true;
  else if (failure === "wrong mode") f.behavior.status = "connected";
  else if (failure === "unknown mode") f.behavior.status = "unknown";
  else if (failure === "changing mode") f.behavior.changeMode = true;
  else f.behavior.changeOwner = true;
  await expect(f.runtime.restart(f.registration, signal())).rejects.toBeInstanceOf(ConnectorError);
  expect(f.calls).not.toContain("start");
  expect(f.connections.every((rpc) => !rpc.connected)).toBe(true);
});

test.each(["absent", "manual startup wins"] as const)("%s retains the single native startup path", async (state) => {
  const f = recoveryFixture();
  f.behavior.found = undefined;
  const child = Object.assign(new EventEmitter(), { pid: 41004, exitCode: state === "absent" ? null : 1, signalCode: null }) as ChildProcess;
  f.operations.start = (registration) => {
    expect(registration).toBe(f.registration); f.calls.push("start");
    if (state === "manual startup wins") f.behavior.found = f.current;
    return child;
  };
  f.operations.capture = async (pid, previous) => {
    expect(pid).toBe(child.pid!); expect(previous).toBe(f.registration.owner);
    f.calls.push("capture"); return { ...f.current, process: { ...f.current.process, pid } };
  };
  const result = await f.runtime.restart(f.registration, signal());
  expect(result.process.pid).toBe(state === "absent" ? child.pid! : f.current.process.pid);
  expect(f.calls.filter((call) => call === "start")).toHaveLength(1);
  expect(f.calls).toEqual(state === "absent"
    ? ["gone", "find", "start", "capture"]
    : ["gone", "find", "start", "find", "connect", "remoteControl/status/read", "find", "close"]);
});
