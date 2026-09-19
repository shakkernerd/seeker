#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExchangeView, IngestResult } from "../src/contracts.ts";

// Run after building. All execution below uses the packed, installed package.
const root = resolve(import.meta.dir, "..");
const startedAt = Date.now();
const deadline = startedAt + 120_000;
const environment = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` };
const processes: Running[] = [];
let phase = "checking build inputs";

interface Running {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  output: { stdout: string; stderr: string; readFailed: boolean };
  finished: Promise<number>;
}

class VerificationFailure extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new VerificationFailure(message);
}

function budget(maximum: number): number {
  const remaining = deadline - Date.now();
  check(remaining > 0, "The two-minute package verification budget expired.");
  return Math.min(maximum, remaining);
}

function launch(command: string[], cwd: string, maximum = 10_000): Running {
  const child = Bun.spawn(command, {
    cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    timeout: budget(maximum), killSignal: "SIGKILL", maxBuffer: 1_048_576,
  });
  const output = { stdout: "", stderr: "", readFailed: false };
  const collect = async (stream: ReadableStream<Uint8Array>, key: "stdout" | "stderr") => {
    try {
      const decoder = new TextDecoder();
      for await (const chunk of stream) output[key] += decoder.decode(chunk, { stream: true });
      output[key] += decoder.decode();
    } catch { output.readFailed = true; }
  };
  const finished = Promise.all([child.exited, collect(child.stdout, "stdout"), collect(child.stderr, "stderr")])
    .then(([code]) => code);
  const running = { child, output, finished };
  processes.push(running);
  return running;
}

function commandFailure(label: string, running: Running, code: number): string {
  // Child output stays private: startup output and dependency errors can contain secrets.
  const missing = /Cannot find (?:package|module)|Module not found|ENOENT/.test(running.output.stderr);
  return `${label} failed (exit ${code}${running.child.signalCode ? `, ${running.child.signalCode}` : ""}).` +
    (missing ? " A required built file or installed dependency could not be resolved." : "");
}

async function run(label: string, command: string[], cwd: string, maximum = 10_000, expected = 0) {
  const running = launch(command, cwd, maximum);
  const code = await running.finished;
  check(!running.output.readFailed, `${label} output could not be read.`);
  check(code === expected, commandFailure(label, running, code));
  return running.output;
}

async function stop(running: Running, requireCleanExit: boolean): Promise<void> {
  if (running.child.exitCode === null) running.child.kill("SIGTERM");
  const force = setTimeout(() => { if (running.child.exitCode === null) running.child.kill("SIGKILL"); }, 3_000);
  try {
    const code = await running.finished;
    if (requireCleanExit) check(code === 0, "The installed demo did not shut down cleanly after SIGTERM.");
  } finally { clearTimeout(force); }
}

async function until<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const limit = Date.now() + budget(8_000);
  while (Date.now() < limit) {
    const value = await read();
    if (ready(value)) return value;
    await Bun.sleep(25);
  }
  throw new VerificationFailure(`${label} did not complete within eight seconds.`);
}

async function startDemo(bin: string, consumer: string, dataDir: string) {
  const running = launch([bin, "demo", "--data-dir", dataDir, "--port", "0"], consumer, budget(90_000));
  const origin = await until("Installed demo startup", async () => {
    if (running.child.exitCode !== null) throw new VerificationFailure(commandFailure("Installed demo startup", running, running.child.exitCode));
    return running.output.stdout.match(/Open (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? "";
  }, Boolean);
  check(running.output.stdout.includes("controlled demo fixture"), "Demo startup must identify its controlled fixture.");
  const accessKey = readFileSync(join(dataDir, "access.key"), "utf8").trim();
  check(/^[a-f0-9]{64}$/.test(accessKey), "Installed demo did not create a usable private access key.");
  check((statSync(dataDir).mode & 0o077) === 0 && (statSync(join(dataDir, "access.key")).mode & 0o077) === 0,
    "Installed demo data and its access key must remain private.");
  const fetchLocal = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, {
    ...init, redirect: "error", signal: AbortSignal.timeout(budget(3_000)),
  });
  const unauthenticated = await fetchLocal("/api/exchanges");
  check(unauthenticated.status === 401, "Installed inbox accepted an unauthenticated request.");
  await unauthenticated.body?.cancel();
  const login = await fetchLocal("/api/session", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: accessKey }),
  });
  check(login.status === 200, "Installed browser session sign-in failed.");
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  const session = await login.json() as { csrf?: string; mode?: string };
  check(cookie && session.csrf && session.mode === "fixture", "Installed browser session did not identify the fixture or issue session credentials.");
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetchLocal(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Cookie: cookie, Origin: origin, "X-Seeker-CSRF": session.csrf!, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    check(response.ok, `Installed local endpoint returned HTTP ${response.status}.`);
    return await response.json() as T;
  };
  return { running, request };
}

async function verify(directory: string) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name: string; version: string; engines: { bun: string }; bin: { seeker: string };
    exports: { ".": { types: string; import: string } };
  };
  const pinned = readFileSync(join(root, ".bun-version"), "utf8").trim();
  check(Bun.version === pinned && manifest.engines.bun === pinned, `Run this check with the package's qualified Bun ${pinned}.`);
  const required = [manifest.bin.seeker, manifest.exports["."].import, manifest.exports["."].types, "dist/codex-connector.mjs", "bin/seeker-codex"];
  check(required.every((path) => existsSync(resolve(root, path))), "Built CLI, library or declarations are missing. Run bun run build first.");

  phase = "packing and inspecting the distributable";
  const packed = join(directory, "packed");
  mkdirSync(packed);
  await run("Bun package creation", [process.execPath, "pm", "pack", "--ignore-scripts", "--destination", packed, "--quiet"], root, 20_000);
  const archives = readdirSync(packed).filter((name) => name.endsWith(".tgz"));
  check(archives.length === 1, "Bun did not produce exactly one installable tarball.");
  const archive = join(packed, archives[0]!);
  const listing = await run("Package content inspection", ["tar", "-tzf", archive], directory);
  const files = listing.stdout.trim().split("\n").filter(Boolean);
  for (const name of files) {
    const relative = name.replace(/^package\//, "");
    const parts = relative.replace(/\/$/, "").split("/");
    check(name.startsWith("package/") && !parts.some((part) => part === ".." || part === "." || part === "" ||
      ["src", "source", "test", "tests", "node_modules", ".artifacts", ".git"].includes(part)), "The tarball contains an unsafe or private path.");
    check(!/\.(?:key|pem|sqlite(?:-wal|-shm)?|db|log|tgz)$/i.test(relative), "The tarball contains a key, database, log or nested archive.");
    const allowed = ["package.json", "README.md", "LICENSE", ".bun-version", "bin/", "bin/seeker-codex"].includes(relative) ||
      /^dist\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.(?:m?js|cjs|d\.[cm]?ts)$/.test(relative) ||
      /^docs\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.md$/.test(relative) ||
      /^(?:dist|docs)(?:\/[a-zA-Z0-9_.-]+)*\/$/.test(relative);
    check(allowed, "The tarball contains a file outside the public distributable allowlist.");
  }
  for (const path of ["package.json", "README.md", "LICENSE", ".bun-version", ...required]) {
    check(files.includes(`package/${path.replace(/^\.\//, "")}`), "The tarball is missing a declared entry point or required package document.");
  }
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");

  phase = "installing into a fresh consumer";
  const consumer = join(directory, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "seeker-package-check", private: true, type: "module" }));
  await run("Fresh consumer installation", [process.execPath, "add", "--ignore-scripts", "--no-progress", "--cache-dir", join(directory, "cache"), archive], consumer, 45_000);
  const installed = join(consumer, "node_modules", manifest.name);
  const bin = join(consumer, "node_modules", ".bin", "seeker");
  check(realpathSync(bin).startsWith(`${realpathSync(installed)}/`) && (statSync(bin).mode & 0o111) !== 0,
    "The installed seeker command does not resolve to an executable in its installed package.");

  phase = "checking the installed CLI and public exports";
  const version = await run("Installed CLI version", [bin, "--version"], consumer);
  check(version.stdout.trim() === manifest.version, "Installed CLI version differs from its package version.");
  const help = await run("Installed CLI help", [bin, "--help"], consumer);
  check(help.stdout.includes("Usage: seeker") && help.stdout.includes("demo") && help.stdout.includes("--data-dir"), "Installed CLI help is incomplete.");
  const invalid = await run("Installed CLI unknown command", [bin, "unknown-package-check"], consumer, 10_000, 1);
  check(invalid.stderr.includes("Unknown command") && invalid.stderr.includes("--help"), "Unknown commands must explain how to find CLI help.");
  check(existsSync(resolve(installed, manifest.exports["."].types)), "Installed public declarations are missing.");
  const probe = join(consumer, "verify-exports.mjs");
  writeFileSync(probe, `import * as seeker from ${JSON.stringify(manifest.name)};
if (!import.meta.resolve(${JSON.stringify(manifest.name)}).startsWith(${JSON.stringify(`${pathToFileURL(realpathSync(installed)).href}/`)})) throw new Error("Package import escaped the fresh installation.");
for (const name of ["SeekerCore", "DeliveryPump", "SeekerError", "SqliteExchangeStore", "LocalChannel", "createLocalServer", "startRuntime", "defaultDataDir", "ensureDataDir", "loadAccessKey", "setupCodex", "loadCodexHost"]) {
  if (typeof seeker[name] !== "function") throw new Error("A public library export is missing.");
}
if (seeker.version !== ${JSON.stringify(manifest.version)} || seeker.runtimeVersion !== Bun.version || seeker.localRecipient.channelId !== "local") throw new Error("Installed library metadata differs from its CLI.");
`);
  await run("Installed library import", [process.execPath, probe], consumer);

  phase = "checking installed native setup";
  const nativeProject = join(directory, "native-project"), nativeData = join(directory, "native-data");
  mkdirSync(nativeProject);
  await run("Installed native manager setup", [bin, "codex", "setup", "--project", nativeProject, "--task", "00000000-0000-7000-8000-000000000001", "--label", "Package proof manager", "--data-dir", nativeData], consumer);
  const projectConfig = Bun.TOML.parse(readFileSync(join(nativeProject, ".codex", "config.toml"), "utf8")) as { mcp_servers?: { seeker?: { command?: string; required?: boolean } } };
  const launcher = join(installed, "bin", "seeker-codex");
  check(projectConfig.mcp_servers?.seeker?.command === realpathSync(launcher) && projectConfig.mcp_servers.seeker.required === false && (statSync(launcher).mode & 0o111) !== 0,
    "Installed setup did not select its executable host launcher without changing required-server policy.");
  const connector = JSON.parse(readFileSync(join(nativeData, "codex-connector.json"), "utf8")) as { version?: number; socketPath?: string; credentialFile?: string };
  check(connector.version === 2 && connector.socketPath === join(realpathSync(nativeData), "codex.sock") && connector.credentialFile === join(realpathSync(nativeData), "codex.key") &&
    (statSync(connector.credentialFile).mode & 0o077) === 0, "Installed native setup did not preserve its private socket and credential boundary.");

  phase = "exercising the installed controlled fixture";
  const dataDir = join(directory, "private-data");
  let service = await startDemo(bin, consumer, dataDir);
  const inbox = await service.request<ExchangeView[]>("/api/exchanges");
  check(inbox.length === 1, "A fresh installed demo must expose exactly its sample exchange.");
  const initial = inbox[0]!;
  check(initial.exchange.origin.hostId === "fixture" && initial.exchange.managerLabel.includes("controlled host fixture"), "The sample exchange must identify its fixture origin.");
  const revision = initial.exchange.revisions[initial.exchange.revision - 1]!;
  const choice = revision.decision.options.find((option) => option.kind === "approve");
  check(choice && revision.decision.scope && revision.decision.conditions, "The sample decision lacks a scoped choice or conditions.");
  const exchangePath = `/api/exchanges/${encodeURIComponent(initial.exchange.id)}`;
  const question = await service.request<IngestResult>("/api/replies", {
    eventId: "package-question", replyHandle: revision.replyHandle, kind: "answer", text: "Why is that needed?",
  });
  check(question.status === "recorded" && question.receiptId, "The installed service did not durably record the context question.");
  const explained = await until("Controlled fixture explanation", () => service.request<ExchangeView>(exchangePath), (view) =>
    view.exchange.context.length > 0 && view.exchange.receipts.find((receipt) => receipt.id === question.receiptId)?.disposition.status === "handled");
  check(explained.exchange.state === "waiting" && explained.exchange.context.some((message) => message.text.includes("sample stays on this machine")),
    "The fixture must explain the request while leaving its decision open.");
  const condition = "Only for this controlled demonstration; do not change another repository or contact an external service.";
  const answer = await service.request<IngestResult>("/api/replies", {
    eventId: "package-answer", replyHandle: revision.replyHandle, kind: "approve", optionId: choice.id, text: "", conditions: condition,
  });
  check(answer.status === "recorded" && answer.receiptId, "The installed service did not durably record the scoped answer.");
  const handled = await until("Controlled fixture handling", () => service.request<ExchangeView>(exchangePath), (view) =>
    view.exchange.state === "handled" && view.exchange.receipts.find((receipt) => receipt.id === answer.receiptId)?.disposition.status === "handled");
  const receipt = handled.exchange.receipts.find((item) => item.id === answer.receiptId)!;
  check(receipt.conditions === condition && receipt.optionId === choice.id && receipt.revision === revision.number &&
    receipt.disposition.note?.includes("controlled demo fixture") && receipt.disposition.evidenceRef?.startsWith("fixture:"),
    "The installed service lost answer scope, conditions or explicit fixture handling evidence.");
  await stop(service.running, true);

  phase = "verifying installed-package restart retention";
  service = await startDemo(bin, consumer, dataDir);
  const retained = await service.request<ExchangeView>(exchangePath);
  check(JSON.stringify(retained.exchange) === JSON.stringify(handled.exchange), "Restart changed or duplicated the durable exchange, context or handled receipts.");
  const retainedInbox = await service.request<ExchangeView[]>("/api/exchanges");
  check(retainedInbox.length === 1, "Restart created another sample exchange.");
  await stop(service.running, true);
  return { package: `${manifest.name}@${manifest.version}`, bun: Bun.version, archiveFiles: files.length, sha256: digest };
}

const directory = mkdtempSync(join(tmpdir(), "seeker-package-"));
let result: Awaited<ReturnType<typeof verify>> | undefined;
try { result = await verify(directory); }
catch (error) {
  const message = error instanceof VerificationFailure ? error.message : "An I/O, dependency or response parsing operation failed.";
  console.error(`Package verification failed while ${phase}: ${message}`);
  process.exitCode = 1;
} finally {
  await Promise.all(processes.map((running) => stop(running, false)));
  rmSync(directory, { recursive: true, force: true });
}
if (result) {
  console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - startedAt,
    proof: "Fresh installed CLI, public exports and private native setup; controlled fixture question, context, conditioned answer, handled receipt and restart retention." }));
}
