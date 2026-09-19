import { afterEach, describe, expect, test } from "bun:test";
import { TelegramApi, TelegramError, type TelegramTransport } from "../src/channels/telegram/api";

const FAKE_TOKEN = "123456789:TEST_TOKEN_NOT_REAL_0123456789ABCDE";
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function fixture(handler: (request: Request) => Response | Promise<Response>): TelegramTransport {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return (url, init) => {
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://api.telegram.org");
    expect(parsed.pathname).toStartWith(`/bot${FAKE_TOKEN}/`);
    return fetch(new URL(parsed.pathname, server.url), init);
  };
}

describe("Telegram credential-bearing HTTP boundary", () => {
  test("uses fixed origin, JSON POST and prevents redirects", async () => {
    const api = new TelegramApi(FAKE_TOKEN, fixture(async (request) => {
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(await request.json()).toEqual({ chat_id: "42", text: "Why?" });
      return Response.json({ ok: true, result: { message_id: 7 } });
    }));
    expect(await api.call("sendMessage", { chat_id: "42", text: "Why?" })).toEqual({ message_id: 7 });
    expect(JSON.stringify(api)).not.toContain(FAKE_TOKEN);
    let redirected = false;
    const redirect = new TelegramApi(FAKE_TOKEN, fixture((request) => {
      if (new URL(request.url).pathname === "/leak") redirected = true;
      return Response.redirect(new URL("/leak", request.url));
    }));
    await expect(redirect.call("sendMessage", {})).rejects.toMatchObject({ outcome: "unknown" });
    expect(redirected).toBe(false);
  });

  test("honors flood delay and discards secret-bearing descriptions", async () => {
    const api = new TelegramApi(FAKE_TOKEN, fixture(() => Response.json({
      ok: false, error_code: 429, description: `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`,
      parameters: { retry_after: 17 },
    }, { status: 429 })));
    const error = await api.call("sendMessage", {}).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "rate-limited", outcome: "rejected", retryAfterSeconds: 17 });
    expect(String(error)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(error)).not.toContain(FAKE_TOKEN);
  });

  test("separates definite rejection from lost send responses without retry", async () => {
    for (const status of [400, 401, 403, 409, 500, 502]) {
      const api = new TelegramApi(FAKE_TOKEN, fixture(() => Response.json({ ok: false, error_code: status }, { status })));
      await expect(api.call("sendMessage", {})).rejects.toMatchObject({ outcome: status < 500 ? "rejected" : "unknown" });
    }
    let calls = 0;
    const lost = new TelegramApi(FAKE_TOKEN, async (url) => {
      calls++;
      throw new Error(`Connection lost: ${url}`);
    });
    const error = await lost.call("sendMessage", {}).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TelegramError);
    expect(error).toMatchObject({ outcome: "unknown" });
    expect(String(error)).not.toContain(FAKE_TOKEN);
    expect(calls).toBe(1);
  });

  test("cancellation before dispatch is rejected, after dispatch is unknown", async () => {
    const stopped = new AbortController();
    stopped.abort();
    let calls = 0;
    const api = new TelegramApi(FAKE_TOKEN, async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    await expect(api.call("sendMessage", {}, stopped.signal)).rejects.toMatchObject({ outcome: "rejected" });
    expect(calls).toBe(0);
    const running = new AbortController();
    const pending = api.call("sendMessage", {}, running.signal);
    running.abort();
    await expect(pending).rejects.toMatchObject({ outcome: "unknown" });
    expect(calls).toBe(1);
  });

  test("malformed successful responses are uncertain", async () => {
    for (const body of ["not json", "{}", JSON.stringify({ ok: true })]) {
      const api = new TelegramApi(FAKE_TOKEN, fixture(() => new Response(body)));
      await expect(api.call("sendMessage", {})).rejects.toMatchObject({ outcome: "unknown" });
    }
  });
});
