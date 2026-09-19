import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CliRpc, NativeRpcError } from "../src/hosts/codex-cli/rpc.ts";
import { maxWireBytes } from "../src/hosts/codex/protocol.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
type Message = { id?: string; method?: string; params?: unknown; result?: unknown; error?: unknown };
type Socket = Bun.ServerWebSocket<undefined>;
async function fixture() {
  // Keep the task-owned socket below the macOS Unix-address length limit.
  const directory = mkdtempSync("/tmp/seeker-cli-rpc-"), path = join(directory, "native.sock");
  const messages: Message[] = [], initialized = deferred<void>();
  const handler = { message: (_socket: Socket, _message: Message) => {} };
  const server = Bun.serve<undefined>({
    unix: path,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as Message; messages.push(message);
        if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: { userAgent: "controlled-cli-fixture" } }));
        else if (message.method === "initialized") initialized.resolve();
        else handler.message(socket, message);
      },
    },
  });
  cleanups.push(async () => { await server.stop(true); rmSync(directory, { recursive: true, force: true }); });
  const rpc = await CliRpc.connect(path, AbortSignal.timeout(1_000));
  cleanups.push(() => rpc.close());
  await initialized.promise;
  return { rpc, messages, handler };
}
const capturedError = (promise: Promise<unknown>) => promise.then(() => { throw new Error("Expected native RPC failure"); }, (error: unknown) => {
  expect(error).toBeInstanceOf(NativeRpcError); return error as NativeRpcError;
});

test("an approval request colliding with a pending ID is ignored, not answered or mistaken for the eventual response", async () => {
  const f = await fixture(), barrier = deferred<void>(), original = deferred<{ socket: Socket; id: string }>();
  const notices: string[] = [];
  f.rpc.onNotice = (method) => { notices.push(method); if (method === "fixture/barrier") barrier.resolve(); };
  f.handler.message = (socket, message) => {
    if (message.method === "turn/start") {
      original.resolve({ socket, id: message.id! });
      socket.send(JSON.stringify({ id: message.id, method: "item/commandExecution/requestApproval", params: { threadId: "fixture-manager", command: "fixture-command" } }));
      socket.send(JSON.stringify({ method: "fixture/barrier", params: {} }));
    } else if (message.method === "fixture/synchronize") socket.send(JSON.stringify({ id: message.id, result: "synchronized" }));
  };
  let settled = false;
  const result = f.rpc.request("turn/start", { threadId: "fixture-manager", input: [] }, AbortSignal.timeout(1_000));
  void result.then(() => { settled = true; }, () => { settled = true; });
  await barrier.promise;
  expect(settled).toBe(false);
  // This ordered round trip also flushes any forbidden client approval response.
  expect(await f.rpc.request<string>("fixture/synchronize", {}, AbortSignal.timeout(1_000))).toBe("synchronized");
  expect(f.messages.every((message) => typeof message.method === "string")).toBe(true);
  expect(notices).toEqual(["fixture/barrier"]);
  expect(settled).toBe(false);
  const { socket, id } = await original.promise;
  socket.send(JSON.stringify({ id, result: { turn: { id: "real-response" } } }));
  expect(await result).toEqual({ turn: { id: "real-response" } });
});

test.each(["timeout", "disconnect"] as const)("%s after a Unix WebSocket write remains written=true", async (failure) => {
  const f = await fixture(), received = deferred<Socket>();
  f.handler.message = (socket) => received.resolve(socket);
  const error = capturedError(f.rpc.request("turn/start", { threadId: "fixture-manager", input: [] }, AbortSignal.timeout(1_000), 100));
  const socket = await received.promise;
  if (failure === "disconnect") socket.close();
  expect(await error).toMatchObject({ written: true, code: failure === "timeout" ? "native_timeout" : "native_connection_lost" });
  expect(f.messages.filter((message) => message.method === "turn/start")).toHaveLength(1);
});

test("an absent Unix listener is known unwritten", async () => {
  const directory = mkdtempSync("/tmp/seeker-cli-offline-");
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  expect(await capturedError(CliRpc.connect(join(directory, "absent.sock"), AbortSignal.timeout(1_000)))).toMatchObject({ written: false, code: "native_offline" });
});

test("oversized outgoing frames are unwritten; an oversized response closes the connection with pending writes uncertain", async () => {
  const f = await fixture();
  expect(await capturedError(f.rpc.request("fixture/oversized", { text: "x".repeat(maxWireBytes) }, AbortSignal.timeout(1_000)))).toMatchObject({ written: false, code: "native_request_too_large" });
  f.handler.message = (socket, message) => {
    if (message.method === "fixture/synchronize") socket.send(JSON.stringify({ id: message.id, result: "bounded" }));
    else socket.send(JSON.stringify({ id: message.id, result: "x".repeat(maxWireBytes) }));
  };
  expect(await f.rpc.request<string>("fixture/synchronize", {}, AbortSignal.timeout(1_000))).toBe("bounded");
  expect(f.messages.some((message) => message.method === "fixture/oversized")).toBe(false);
  expect(await capturedError(f.rpc.request("thread/read", { threadId: "fixture-manager" }, AbortSignal.timeout(1_000)))).toMatchObject({ written: true, code: "native_connection_lost" });
  expect(f.rpc.connected).toBe(false);
});

test("the pending request bound rejects before write and disconnect settles every admitted request", async () => {
  const f = await fixture(), full = deferred<void>();
  let received = 0;
  f.handler.message = () => { if (++received === 32) full.resolve(); };
  const pending = Array.from({ length: 32 }, () => capturedError(f.rpc.request("thread/read", { threadId: "fixture-manager" }, AbortSignal.timeout(1_000))));
  expect(await capturedError(f.rpc.request("fixture/overflow", {}, AbortSignal.timeout(1_000)))).toMatchObject({ written: false, code: "native_capacity" });
  await full.promise;
  f.rpc.close();
  for (const error of await Promise.all(pending)) expect(error).toMatchObject({ written: true, code: "native_connection_lost" });
  expect(received).toBe(32);
  expect(f.messages.some((message) => message.method === "fixture/overflow")).toBe(false);
});
