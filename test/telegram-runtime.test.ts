import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelIngress, ReceiveProgress } from "../src/contracts";
import { TelegramApi } from "../src/channels/telegram/api";
import { TelegramChannel } from "../src/channels/telegram/channel";
import { loadTelegramConfig, readTelegramToken, saveTelegramConfig } from "../src/channels/telegram/config";
import { loadTelegram } from "../src/channels/telegram/runtime";
import { SeekerCore } from "../src/core/seeker";
import { SqliteExchangeStore } from "../src/store/sqlite";

const TOKEN = "123456789:TEST_TOKEN_NOT_REAL_0123456789ABCDE";
const owner = { actorId: "42", conversationId: "42" };
const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const ingress: ChannelIngress = { progress: () => undefined, receive: () => [], pending: () => [], resolveMessage: () => undefined };

test("polling cancels an in-flight SDK request and releases ownership before returning", async () => {
  let polls = 0;
  let released = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const method = new URL(request.url).pathname.split("/").at(-1);
    if (method === "getMe") return Response.json({ ok: true, result: { id: 123456789, is_bot: true, username: "seeker_test_bot" } });
    if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
    polls++;
    return new Promise<Response>((resolve) => request.signal.addEventListener("abort", () => resolve(Response.json({ ok: true, result: [] })), { once: true }));
  } });
  closes.push(() => server.stop(true));
  const api = new TelegramApi(TOKEN, (url, init) => fetch(new URL(new URL(url).pathname, server.url), init));
  const channel = new TelegramChannel(api, owner, { claim: async () => async () => { released = true; } });
  const controller = new AbortController();
  const running = channel.run(ingress, controller.signal);
  closes.push(async () => { controller.abort(); await running; });
  for (let i = 0; i < 200 && polls === 0; i++) await Bun.sleep(1);
  expect(polls).toBe(1);
  await expect(channel.run(ingress, controller.signal)).rejects.toThrow("already running");
  controller.abort();
  await running;
  expect(released).toBe(true);
});

test("webhook and conflicting poller failures are visible without taking over the bot", async () => {
  for (const webhook of [true, false]) {
    const methods: string[] = [];
    let released = false;
    const api = new TelegramApi(TOKEN, async (url) => {
      const method = url.split("/").at(-1)!;
      methods.push(method);
      if (method === "getMe") return Response.json({ ok: true, result: { id: 123456789, is_bot: true, username: "seeker_test_bot" } });
      if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: webhook ? "https://webhook.invalid/private" : "" } });
      return Response.json({ ok: false, error_code: 409, description: `secret ${TOKEN}` }, { status: 409 });
    });
    const channel = new TelegramChannel(api, owner, { claim: async () => async () => { released = true; } });
    const error = await channel.run(ingress, new AbortController().signal).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain("webhook.invalid");
    expect(released).toBe(true);
    expect(methods).toEqual(webhook ? ["getMe", "getWebhookInfo"] : ["getMe", "getWebhookInfo", "getUpdates"]);
  }
});

test("a receive gap is recorded from downtime, not numerical gaps between updates", async () => {
  let progress: ReceiveProgress = { cursor: "5", lastReceivedAt: 1_000, continuity: "continuous" };
  const reports: string[] = [];
  const api = new TelegramApi(TOKEN, async () => Response.json({ ok: true, result: [] }));
  const channel = new TelegramChannel(api, owner, { now: () => 1_000 + 25 * 60 * 60_000, report: (message) => reports.push(message) });
  await channel.pollOnce({ ...ingress, progress: () => progress, receive: (_events, next) => { progress = next!; return []; } }, new AbortController().signal);
  expect(progress.continuity).toBe("possible-gap");
  expect(progress.cursor).toBe("5");
  expect(reports).toHaveLength(1);
});

test("private config stores only fixed owner and credential path; invalid or changed identity fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seeker-telegram-config-"));
  closes.push(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const store = new SqliteExchangeStore(":memory:");
  closes.push(() => store.close());
  const core = new SeekerCore(store);
  expect(loadTelegram(core, directory, () => {})).toBeUndefined();
  saveTelegramConfig(directory, { channelId: "telegram:123456789", ...owner }, tokenFile);
  const saved = await readFile(join(directory, "telegram.json"), "utf8");
  expect(saved).not.toContain(TOKEN);
  expect(loadTelegramConfig(directory)).toMatchObject({ botId: "123456789", ...owner, tokenFile });
  expect(() => saveTelegramConfig(directory, { channelId: "telegram:123456789", actorId: "99", conversationId: "99" }, tokenFile)).toThrow("Existing configuration was preserved");
  expect(await readFile(join(directory, "telegram.json"), "utf8")).toBe(saved);
  await writeFile(tokenFile, TOKEN.replace("123456789", "987654321"));
  expect(() => loadTelegram(core, directory, () => {})).toThrow("different bot");
  await chmod(tokenFile, 0o644);
  expect(() => readTelegramToken(tokenFile)).toThrow("private regular file");
  await chmod(tokenFile, 0o600);
  const linked = join(directory, "linked-token");
  await symlink(tokenFile, linked);
  expect(() => readTelegramToken(linked)).toThrow("private regular file");
});

test.skipIf(process.platform === "win32")("nonregular token files fail promptly instead of blocking receiver startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seeker-telegram-fifo-"));
  closes.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "token-pipe");
  expect(Bun.spawnSync(["mkfifo", "-m", "600", path]).exitCode).toBe(0);
  const script = `import {readTelegramToken} from ${JSON.stringify(new URL("../src/channels/telegram/config.ts", import.meta.url).pathname)};try{readTelegramToken(process.argv[1]);process.exitCode=2;}catch{console.log("rejected");}`;
  const child = Bun.spawn([process.execPath, "-e", script, path], { stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<"timed-out">((resolve) => { timer = setTimeout(() => resolve("timed-out"), 1_000); });
  try {
    const result = await Promise.race([child.exited, deadline]);
    if (result === "timed-out") child.kill("SIGKILL");
    expect(result).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe("rejected");
  } finally {
    clearTimeout(timer!);
    child.kill("SIGKILL");
    await child.exited;
  }
});
