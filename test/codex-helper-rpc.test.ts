import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HelperRpc } from "../src/hosts/codex/helper-rpc.ts";
import { ConnectorError, maxWireBytes } from "../src/hosts/codex/protocol.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, timeoutMs = 2_000, message = "Owned stdio fixture did not settle"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(10);
  expect(alive(pid)).toBe(false);
}
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("Expected owned helper transport failure"); }, (error: unknown) => {
  expect(error).toBeInstanceOf(ConnectorError);
  expect(error).toMatchObject({ code: "desktop_helper_unavailable" });
  return error;
});

function fixture(body: string, options: { shell?: boolean; notice?: (method: string, params: unknown) => void } = {}) {
  const directory = mkdtempSync("/tmp/seeker-helper-rpc-"), script = join(directory, "fixture.mjs");
  const ready = deferred<{ pid: number; nativePid?: number }>(), lost = deferred<void>();
  let identity: { pid: number; nativePid?: number } | undefined, losses = 0;
  writeFileSync(script, options.shell ? body : `
    import { createInterface } from "node:readline";
    import { spawn } from "node:child_process";
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    const read = (handler) => createInterface({ input: process.stdin }).on("line", (line) => handler(JSON.parse(line)));
    const limit = ${maxWireBytes};
    setTimeout(() => process.exit(89), 10_000);
    ${body}
  `);
  const rpc = new HelperRpc(options.shell ? "/bin/sh" : process.execPath, [script], directory, { PATH: process.env.PATH });
  rpc.events = {
    notice(method, params) {
      if (method === "fixture/ready") { identity = params as typeof identity; ready.resolve(identity!); }
      else options.notice?.(method, params);
    },
    request(id) { rpc.reject(id); },
    lost() { losses += 1; lost.resolve(); },
  };
  cleanups.push(async () => {
    try { await rpc.close(); }
    finally {
      // Each fixture starts a fresh detached group; even a failing cleanup assertion
      // must not leave the deliberately orphaned fixture child running.
      if (identity && (alive(identity.pid) || (identity.nativePid && alive(identity.nativePid)))) {
        try { process.kill(-identity.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      if (identity) await gone(identity.pid);
      if (identity?.nativePid) await gone(identity.nativePid);
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return { rpc, ready: ready.promise, lost: lost.promise, losses: () => losses };
}

test("a closed stdin fails every pending write and reports transport loss once", async () => {
  // POSIX descriptor closure produces a real broken pipe while the process stays alive.
  const f = fixture(`
    printf '{"method":"fixture/ready","params":{"pid":%s}}\\n' "$$"
    IFS= read -r first
    exec 0<&-
    exec sleep 10
  `, { shell: true });
  const { pid } = await bounded(f.ready, 2_000, "Closed-input fixture never became ready");
  const first = failure(f.rpc.request("fixture/first", {}, new AbortController().signal));
  const second = failure(f.rpc.request("fixture/second", { text: "x".repeat(maxWireBytes / 2) }, new AbortController().signal));
  await bounded(Promise.all([first, second, f.lost]), 2_000, "Closed input left pending requests unsettled");
  expect(f.rpc.connected).toBe(false);
  expect(f.losses()).toBe(1);
  expect(alive(pid)).toBe(true); // Broken input, rather than a request deadline or prior process exit.
  await f.rpc.close();
  expect(f.losses()).toBe(1);
  await gone(pid);
});

test("one stdout burst may exceed the aggregate limit when every JSON frame is bounded", async () => {
  const sizes: number[] = [];
  const f = fixture(`
    read((message) => {
      const empty = JSON.stringify({ method: "fixture/frame", params: { text: "" } });
      const frame = JSON.stringify({ method: "fixture/frame", params: { text: "x".repeat(limit - Buffer.byteLength(empty)) } });
      process.stdout.write(frame + "\\n" + frame + "\\n" + JSON.stringify({ id: message.id, result: "complete" }) + "\\n");
    });
    send({ method: "fixture/ready", params: { pid: process.pid } });
  `, { notice(method, params) {
    if (method === "fixture/frame") sizes.push(Buffer.byteLength(JSON.stringify({ method, params })));
  } });
  await bounded(f.ready);
  expect(await bounded(f.rpc.request("fixture/burst", {}, new AbortController().signal))).toBe("complete");
  expect(sizes).toEqual([maxWireBytes, maxWireBytes]);
  expect(f.rpc.connected).toBe(true);
  expect(f.losses()).toBe(0);
});

test("an oversized unfinished UTF-8 frame closes the child and settles its pending request", async () => {
  const f = fixture(`
    read(() => process.stdout.write('{"result":"' + "é".repeat(limit / 2 + 1)));
    send({ method: "fixture/ready", params: { pid: process.pid } });
  `);
  const { pid } = await bounded(f.ready);
  await bounded(Promise.all([failure(f.rpc.request("fixture/incomplete", {}, new AbortController().signal)), f.lost]));
  expect(f.rpc.connected).toBe(false);
  expect(f.losses()).toBe(1);
  await f.rpc.close();
  await gone(pid);
});

test("spawn failure rejects pending RPC and allows idempotent close without an unhandled stream error", async () => {
  const directory = mkdtempSync("/tmp/seeker-helper-spawn-"), lost = deferred<void>();
  const rpc = new HelperRpc(join(directory, "missing-executable"), [], directory, {});
  cleanups.push(async () => { try { await rpc.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  let losses = 0;
  rpc.events = { notice() {}, request() {}, lost() { losses += 1; lost.resolve(); } };
  await bounded(Promise.all([failure(rpc.request("initialize", {}, new AbortController().signal)), lost.promise]));
  expect(rpc.connected).toBe(false);
  expect(losses).toBe(1);
  const closing = rpc.close();
  expect(rpc.close()).toBe(closing);
  await bounded(closing);
});

test("an abruptly exiting launcher cannot leave its pipe-owning native child orphaned after close", async () => {
  const child = `process.on("SIGTERM", () => {}); setTimeout(() => process.exit(89), 10_000);`;
  const f = fixture(`
    const native = spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: ["ignore", "inherit", "inherit"] });
    read(() => process.exit(17));
    send({ method: "fixture/ready", params: { pid: process.pid, nativePid: native.pid } });
  `);
  const { pid, nativePid } = await bounded(f.ready);
  expect(nativePid).toBeDefined();
  await bounded(Promise.all([failure(f.rpc.request("fixture/crash", {}, new AbortController().signal)), f.lost]));
  expect(alive(nativePid!)).toBe(true);
  const closing = f.rpc.close();
  expect(f.rpc.close()).toBe(closing);
  await bounded(closing, 4_000);
  await gone(pid);
  await gone(nativePid!);
  expect(f.losses()).toBe(1);
}, 8_000);
