import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareEventCapability, signalEvent } from "../src/core/event-client.ts";
import { SeekerCore } from "../src/core/seeker.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";
import { createLocalServer } from "../src/local/server.ts";
async function cli(args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, "src/cli.ts", "event", ...args], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, err).toBe(0); return out;
}
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("ordinary producer signals a privately armed native wait through the real service and can safely retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seeker-producer-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "producer.json"), grant = JSON.parse(await cli(["prepare", "--capability-file", path, "--revision", "release-12"]));
  const raw = JSON.parse(readFileSync(path, "utf8"));
  expect(JSON.stringify(grant).includes(raw.capability)).toBe(false);
  expect(grant.created).toBe(true);
  expect(prepareEventCapability(path, { revision: "release-12" })).toEqual({ ...grant, created: false });
  expect(() => prepareEventCapability(path, { revision: "other" })).toThrow();
  const store = new SqliteExchangeStore(":memory:"); cleanups.push(() => store.close());
  const core = new SeekerCore(store), port = core.events({ hostId: "codex-desktop", taskId: "native-owner", turnId: "original-turn", callId: "original-call" });
  // Arming with the path the CLI prepared recovers that key and identity instead of writing a second key.
  const armed = port.arm({ title: "Release", expiresAt: Date.now() + 60_000, capabilityFile: path, revision: "release-12" });
  expect(armed).toMatchObject({ waitId: grant.waitId, generation: grant.generation, revision: grant.revision, capabilityFile: path });
  expect(armed).not.toHaveProperty("capabilityDigest");
  const server = createLocalServer({ core, accessKey: "browser-key", port: 0 }); cleanups.push(() => server.stop(true));
  const endpoint = `http://127.0.0.1:${server.port}`;
  const result = { eventId: "release-12-finished", outcome: "released" as const, summary: "External dependency is available.", evidenceRefs: ["artifact:release-12"] };
  const resultPath = join(dir, "result.json"); writeFileSync(resultPath, JSON.stringify(result), { mode: 0o600 });
  const first = JSON.parse(await cli(["signal", "--capability-file", path, "--endpoint", endpoint, "--result-file", resultPath]));
  expect(first.status).toBe("recorded");
  expect(await signalEvent({ endpoint, capabilityFile: path, result })).toEqual({ ...first, status: "duplicate" });
  expect(port.get(grant).receipt?.signal.summary).toBe(result.summary);
  expect(store.events.claim(1, Date.now(), [])[0]?.owner.taskId).toBe("native-owner");
  const denied = await fetch(`${endpoint}/api/events/signal`, { method: "POST", headers: { Authorization: "Bearer browser-key", "Content-Type": "application/json" }, body: JSON.stringify({ ...grant, ...result }) });
  expect(denied.ok).toBe(false);
  expect((await fetch(`${endpoint}/api/events/signal`, { method: "POST", headers: { Origin: endpoint, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  await expect(signalEvent({ endpoint: "http://example.com", capabilityFile: path, result })).rejects.toThrow("loopback");
  chmodSync(path, 0o644);
  await expect(signalEvent({ endpoint, capabilityFile: path, result })).rejects.toThrow("private regular");
});
