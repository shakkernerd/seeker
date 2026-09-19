import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeekerCore } from "../src/core/seeker.ts";
import { SqliteExchangeStore } from "../src/store/sqlite.ts";
import { fixtureBinding, fixtureDecision } from "../src/local/fixture.ts";

const children: ReturnType<typeof Bun.spawn>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const value = await read();
    if (accepts(value)) return value;
    if (Date.now() > deadline) throw new Error("Service state did not settle in five seconds.");
    await Bun.sleep(20);
  }
}

async function start(directory: string, mode = "start") {
  const child = Bun.spawn([process.execPath, "src/cli.ts", mode, "--data-dir", directory, "--port", "0"], { stdout: "pipe", stderr: "pipe" });
  children.push(child);
  let output = "";
  const consume = (async () => { for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk); })();
  const url = await until(async () => output.match(/Open (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? "", Boolean);
  const key = readFileSync(join(directory, "access.key"), "utf8").trim();
  const request = (path: string, body?: unknown, extra: HeadersInit = {}) => fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { child, consume, url, key, request };
}

test("actual CLI serves authenticated questions, context, conditions and explicit fixture handling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seeker-service-")); directories.push(directory);
  const service = await start(directory, "demo");
  expect((await fetch(`${service.url}/api/exchanges`)).status).toBe(401);
  expect((await service.request("/api/exchanges", undefined, { Origin: "https://example.com" })).status).toBe(403);
  expect((await service.request("/api/exchanges", undefined, { Host: "example.com" })).status).toBe(403);
  const login = await fetch(`${service.url}/api/session`, { method: "POST", headers: { Origin: service.url, "Content-Type": "application/json" }, body: JSON.stringify({ token: service.key }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(login.headers.get("set-cookie")).toContain("HttpOnly");
  const session = await login.json() as { csrf: string; mode: string };
  expect(session.mode).toBe("fixture");
  expect((await fetch(`${service.url}/api/logout`, { method: "POST", headers: { Cookie: cookie, Origin: service.url, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  const read = async () => (await (await service.request("/api/exchanges")).json()) as ReturnType<SeekerCore["inbox"]>;
  let view = (await read())[0]!;
  const handle = view.exchange.revisions[0]!.replyHandle;
  const question = await service.request("/api/replies", { eventId: "browser-question", replyHandle: handle, kind: "question", text: "Why is that needed?" });
  expect(question.status).toBe(200);
  view = (await until(read, (items) => items[0]!.exchange.context.length === 1 && items[0]!.exchange.receipts[0]!.disposition.status === "handled"))[0]!;
  expect(view.exchange.state).toBe("waiting");
  expect(view.exchange.context[0]!.text).toContain("sample stays on this machine");
  const answer = await service.request("/api/replies", { eventId: "browser-answer", replyHandle: handle, kind: "approve", optionId: "local", text: "", conditions: "For this demonstration only." });
  expect(answer.status).toBe(200);
  view = (await until(read, (items) => items[0]!.exchange.state === "handled"))[0]!;
  expect(view.exchange.receipts[1]!.conditions).toBe("For this demonstration only.");
  expect(view.exchange.receipts[1]!.disposition.note).toContain("controlled demo fixture");
  service.child.kill("SIGTERM");
  expect(await service.child.exited).toBe(0);
  await service.consume;
}, 15_000);

test("SIGKILL/restart retains an offline manager answer and excludes a second writer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seeker-crash-")); directories.push(directory);
  const store = new SqliteExchangeStore(join(directory, "exchanges.sqlite"));
  const core = new SeekerCore(store);
  core.bind({ ...fixtureBinding, origin: { ...fixtureBinding.origin, hostId: "offline-fixture" } });
  core.manager({ ...fixtureBinding.origin, hostId: "offline-fixture" }).submit({ requestId: "offline-request", decision: fixtureDecision });
  store.close();
  let service = await start(directory);
  const view = (await (await service.request("/api/exchanges")).json()) as ReturnType<SeekerCore["inbox"]>;
  const handle = view[0]!.exchange.revisions[0]!.replyHandle;
  const event = { eventId: "offline-answer", replyHandle: handle, kind: "answer", text: "Use only the local directory.", conditions: "No external delivery." };
  const result = await service.request("/api/replies", event);
  expect(result.status).toBe(200);
  const receipt = await result.json() as { receiptId: string };
  const contender = Bun.spawn([process.execPath, "src/cli.ts", "start", "--data-dir", directory, "--port", "0"], { stdout: "pipe", stderr: "pipe" });
  children.push(contender);
  expect(await contender.exited).toBe(1);
  expect(await new Response(contender.stderr).text()).toContain("Another Seeker process owns");
  service.child.kill("SIGKILL"); await service.child.exited; await service.consume;
  service = await start(directory);
  const recovered = (await (await service.request("/api/exchanges")).json()) as ReturnType<SeekerCore["inbox"]>;
  expect(recovered[0]!.exchange.receipts[0]!.id).toBe(receipt.receiptId);
  expect(recovered[0]!.exchange.receipts[0]!.disposition.status).toBe("pending");
  expect(recovered[0]!.exchange.origin.hostId).toBe("offline-fixture");
  const duplicate = await (await service.request("/api/replies", event)).json() as { status: string; receiptId: string };
  expect(duplicate.status).toBe("duplicate");
  expect(duplicate.receiptId).toBe(receipt.receiptId);
  service.child.kill("SIGTERM"); expect(await service.child.exited).toBe(0); await service.consume;
}, 15_000);
