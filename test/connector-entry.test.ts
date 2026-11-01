import { expect, test } from "bun:test";

// Only the external host probe and transport are controlled. The production
// entry point, MCP protocol, caller identity and channel store run unchanged.
async function fixture(mode: string) {
  const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const child = Bun.spawn([process.execPath, "--no-install", "--eval", `
    import { mock } from "bun:test";
    import { createInterface } from "node:readline";
    import { ConnectorError } from ${module("../src/hosts/codex/protocol.ts")};
    import { serveSeekerTools } from ${module("../src/hosts/codex-common/mcp.ts")};
    import { invokeEvent } from ${module("../src/hosts/codex/event-tools.ts")};
    import { SeekerCore } from ${module("../src/core/seeker.ts")};
    import { SqliteExchangeStore } from ${module("../src/store/sqlite.ts")};
    const mode = ${JSON.stringify(mode)};
    const store = new SqliteExchangeStore(":memory:"), core = new SeekerCore(store);
    let probes = 0, created = 0, invoked = 0, closed = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mock.module(${module("../src/hosts/codex/desktop-owner.ts")}, () => ({
      async captureDesktopOwner(signal) {
        probes++;
        if (mode === "closing" || (mode === "concurrent" && probes === 2)) {
          console.log(JSON.stringify({ probeHeld: true }));
          await Promise.race([gate, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
        }
        if (mode === "wrong-host") throw new ConnectorError("native_host_required", "The connector was not launched directly by this Desktop app-server.", 503);
        if (probes === 1 || (mode === "later" && probes === 2)) throw new ConnectorError("desktop_probe_failed", "Desktop ownership metadata could not be read safely.", 503);
        return {};
      }
    }));
    mock.module(${module("../src/hosts/codex-cli/owner.ts")}, () => ({
      async captureCliOwner() { throw new ConnectorError("native_cli_required", "Use the original standalone Codex CLI app-server.", 503); }
    }));
    function create() {
      created++;
      return {
        async invoke(origin, operation, args, signal) {
          invoked++;
          if (mode === "uncertain") throw new ConnectorError("service_unavailable", "Response was lost after submission.", 503);
          return invokeEvent(core.events({ hostId: "entry-fixture", taskId: origin.threadId, turnId: origin.turnId, callId: origin.callId }), operation, args, signal);
        },
        close() { closed++; }
      };
    }
    mock.module(${module("../src/hosts/codex/connector.ts")}, () => ({
      async createCodexConnector() { return create(); },
      async runCodexConnector() { await serveSeekerTools(create()); }
    }));
    const { runNativeConnector } = await import(${module("../src/hosts/codex-common/entry.ts")});
    const running = runNativeConnector(${module("../package.json")}.replace("file://", ""));
    const control = createInterface({ input: process.stdin });
    control.on("line", line => { if (JSON.parse(line).method === "notifications/fixture-ready") release(); });
    await running;
    console.log(JSON.stringify({ settled: true, probes, created, invoked, closed }));
    store.close();
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL" });
  const messages: Array<Record<string, any>> = [];
  const consume = (async () => {
    const decoder = new TextDecoder(); let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
    }
  })();
  const errors = new Response(child.stderr).text();
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const until = async (predicate: (message: Record<string, any>) => boolean) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const message = messages.find(predicate); if (message) return message;
      if (child.exitCode !== null) throw new Error(`MCP exited: ${await errors}`);
      await Bun.sleep(5);
    }
    throw new Error("MCP response timed out.");
  };
  const expiresAt = Date.now() + 60_000;
  const call = (id: number) => send({ jsonrpc: "2.0", id, method: "tools/call", params: {
    name: "channel_open", arguments: { waitId: "entry-grant", peerTaskId: "peer", title: "Reports", expiresAt },
    _meta: { threadId: "receiver", callId: `call-${id}`, "x-codex-turn-metadata": { thread_id: "receiver", turn_id: "turn" } }
  } });
  send({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await until((message) => message.id === 0);
  return { child, send, call, until, async close() {
    child.stdin.end();
    await child.exited; await consume;
    const diagnostics = await errors;
    if (mode === "closing") expect(diagnostics).toBe("");
    else expect(diagnostics).toMatch(/Seeker native connector initialization failed: (desktop_probe_failed|native_cli_required)\./);
    expect(diagnostics).not.toContain("file://");
    return messages.find((message) => message.settled);
  } };
}

test("native MCP recovers a failed startup probe without reload before opening a channel", async () => {
  const f = await fixture("transient");
  try {
    f.call(1);
    const reply = await f.until((message) => message.id === 1);
    expect(reply.result.isError).not.toBe(true);
    expect(JSON.parse(reply.result.content[0].text)).toMatchObject({ waitId: "entry-grant", owner: { taskId: "receiver" } });
  } finally {
    const counts = await f.close();
    expect(counts).toMatchObject({ probes: 2, created: 1, invoked: 1, closed: 1 });
  }
});

test("a failed bounded attempt does not poison a later MCP call", async () => {
  const f = await fixture("later");
  try {
    f.call(1);
    const failed = await f.until((message) => message.id === 1);
    expect(JSON.parse(failed.result.content[0].text)).toMatchObject({ error: "desktop_probe_failed" });
    f.call(2);
    const recovered = await f.until((message) => message.id === 2);
    expect(recovered.result.isError).not.toBe(true);
  } finally {
    expect(await f.close()).toMatchObject({ probes: 3, created: 1, invoked: 1, closed: 1 });
  }
});

test("concurrent MCP calls share preparation and cancellation cannot submit an operation", async () => {
  const f = await fixture("concurrent");
  try {
    await f.until((message) => message.probeHeld === true);
    f.call(1); f.call(2);
    f.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    f.send({ jsonrpc: "2.0", id: "barrier", method: "ping" });
    await f.until((message) => message.id === "barrier");
    f.send({ jsonrpc: "2.0", method: "notifications/fixture-ready" });
    const cancelled = await f.until((message) => message.id === 1);
    const continued = await f.until((message) => message.id === 2);
    expect(cancelled.result.isError).toBe(true);
    expect(continued.result.isError).not.toBe(true);
  } finally {
    expect(await f.close()).toMatchObject({ probes: 2, created: 1, invoked: 1, closed: 1 });
  }
});

test("an uncertain invocation is never retried by initialization recovery", async () => {
  const f = await fixture("uncertain");
  try {
    f.call(1);
    const failed = await f.until((message) => message.id === 1);
    expect(JSON.parse(failed.result.content[0].text)).toMatchObject({ error: "service_unavailable" });
  } finally {
    expect(await f.close()).toMatchObject({ probes: 2, created: 1, invoked: 1, closed: 1 });
  }
});

test("an unqualified native host remains rejected with its diagnostic", async () => {
  const f = await fixture("wrong-host");
  try {
    f.call(1);
    const failed = await f.until((message) => message.id === 1);
    expect(JSON.parse(failed.result.content[0].text)).toMatchObject({ error: "native_cli_required" });
  } finally {
    expect(await f.close()).toMatchObject({ created: 0, invoked: 0, closed: 0 });
  }
});

test("closing MCP during preparation settles recovery without creating a transport", async () => {
  const f = await fixture("closing");
  await f.until((message) => message.probeHeld === true);
  expect(await f.close()).toMatchObject({ created: 0, invoked: 0, closed: 0 });
});
