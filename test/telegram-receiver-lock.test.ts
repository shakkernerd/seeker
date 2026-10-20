import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimReceiver } from "../src/channels/telegram/receiver-lock";

const roots: string[] = [];
const children: ReturnType<typeof launch>[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), "seeker-receiver-")); roots.push(path); return path; };
function launch(root: string, mode = "current"): Bun.Subprocess<"pipe", "pipe", "pipe"> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/telegram-receiver.ts"), root, mode], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  children.push(child);
  return child;
}
async function ready(child: ReturnType<typeof launch>) {
  const reader = child.stdout.getReader();
  try { return new TextDecoder().decode((await reader.read()).value).trim(); }
  finally { reader.releaseLock(); }
}
async function stop(child: ReturnType<typeof launch>) { child.stdin.write("stop\n"); child.stdin.end(); expect(await child.exited).toBe(0); }
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("SIGKILL releases native ownership and restart reclaims the dead PID marker", async () => {
  const root = directory(), owner = launch(root);
  expect(await ready(owner)).toBe("owned");
  owner.kill("SIGKILL"); await owner.exited;
  expect(existsSync(join(root, "123456789.lock"))).toBe(true);
  const replacement = launch(root);
  expect(await ready(replacement)).toBe("owned");
  await stop(replacement);
  expect(existsSync(join(root, "123456789.lock"))).toBe(false);
  expect(existsSync(join(root, "123456789.guard"))).toBe(true);
});

test("concurrent native contenders have one owner, including stale recovery", async () => {
  const root = directory(), dead = launch(root, "legacy");
  expect(await ready(dead)).toBe("owned");
  dead.kill("SIGKILL"); await dead.exited;
  const contenders = Array.from({ length: 8 }, () => launch(root));
  const results = await Promise.all(contenders.map(ready));
  expect(results.filter((result) => result === "owned")).toHaveLength(1);
  expect(results.filter((result) => result === "blocked")).toHaveLength(7);
  await stop(contenders[results.indexOf("owned")]!);
});

test("old and new receivers exclude one another and reconcile an exited legacy owner", async () => {
  const root = directory(), legacy = launch(root, "legacy");
  expect(await ready(legacy)).toBe("owned");
  await expect(claimReceiver("123456789", root)).rejects.toThrow("Cannot claim");
  legacy.kill("SIGKILL"); await legacy.exited;
  const release = await claimReceiver("123456789", root);
  try { const old = launch(root, "legacy"); expect(await ready(old)).toBe("blocked"); expect(await old.exited).toBe(2); }
  finally { await release(); }
  const old = launch(root, "legacy"); expect(await ready(old)).toBe("owned"); await stop(old);
});

test("failed claims in the same process do not unlock its live owner", async () => {
  const root = directory(), release = await claimReceiver("123456789", root);
  try {
    await expect(claimReceiver("123456789", root)).rejects.toThrow("Cannot claim");
    renameSync(join(root, "123456789.lock"), join(root, "original-marker"));
    const contender = launch(root); expect(await ready(contender)).toBe("blocked"); expect(await contender.exited).toBe(2);
    const other = await claimReceiver("987654321", root); await other();
  } finally { await release(); }
});

test("release is idempotent and preserves a replacement marker", async () => {
  const root = directory(), path = join(root, "123456789.lock");
  const release = await claimReceiver("123456789", root);
  renameSync(path, join(root, "removed-marker"));
  writeFileSync(path, "replacement", { mode: 0o600 });
  const replacement = lstatSync(path).ino;
  await release(); await release();
  expect(lstatSync(path).ino).toBe(replacement);
  expect(readFileSync(path, "utf8")).toBe("replacement");
});

test("live, malformed, unsafe and unreadable legacy ownership fail closed", async () => {
  for (const content of ["", "{", "null", "{}", '{"pid":0}', '{"pid":-1}', '{"pid":"12"}', '{"pid":1.5}', '{"pid":2147483648}', JSON.stringify({ pid: process.pid }), "x".repeat(129)]) {
    const root = directory(), path = join(root, "123456789.lock");
    writeFileSync(path, content, { mode: 0o600 });
    await expect(claimReceiver("123456789", root)).rejects.toThrow("Cannot claim");
    expect(readFileSync(path, "utf8")).toBe(content);
  }
  const root = directory(), path = join(root, "123456789.lock");
  writeFileSync(path, JSON.stringify({ pid: process.pid }), { mode: 0o000 });
  await expect(claimReceiver("123456789", root)).rejects.toThrow("Cannot claim");
  expect(existsSync(path)).toBe(true); chmodSync(path, 0o600);
});

test("symlink and public lock paths are not followed or rewritten", async () => {
  for (const suffix of ["lock", "guard"]) {
    const root = directory(), target = join(root, "unrelated");
    writeFileSync(target, "private unrelated data", { mode: 0o600 });
    symlinkSync(target, join(root, `123456789.${suffix}`));
    await expect(claimReceiver("123456789", root)).rejects.toThrow("Cannot claim");
    expect(readFileSync(target, "utf8")).toBe("private unrelated data");
  }
  const root = directory(); chmodSync(root, 0o755);
  await expect(claimReceiver("123456789", root)).rejects.toThrow("Cannot claim");
});


test("interrupted marker publication is recovered without accumulating staging files", async () => {
  const root = directory(), pending = join(root, "123456789.pending");
  writeFileSync(pending, "", { mode: 0o600 });
  const release = await claimReceiver("123456789", root);
  expect(existsSync(pending)).toBe(false);
  await release();
});
