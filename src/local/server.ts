import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "bun";
import type { InboundReply } from "../contracts.ts";
import { SeekerCore } from "../core/seeker.ts";
import { fail, object, SeekerError, text } from "../core/validation.ts";
import { localRecipient } from "./channel.ts";
import { version } from "./config.ts";
import html from "./web/index.html" with { type: "text" };
import javascript from "./web/app.js" with { type: "text" };
import css from "./web/style.css" with { type: "text" };

interface Session { csrf: string; expires: number }
export interface LocalServerOptions {
  core: SeekerCore;
  accessKey: string;
  port?: number;
  mode?: "local" | "fixture";
  hostHandler?: (request: Request, server: Server<undefined>) => Response | undefined | Promise<Response | undefined>;
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export function createLocalServer(options: LocalServerOptions): Server<undefined> {
  const sessions = new Map<string, Session>();
  const failedLogins: number[] = [];
  let base = "";
  const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers: { ...securityHeaders, "Content-Type": "application/json; charset=utf-8", ...extra } });
  const sessionFor = (request: Request): Session | undefined => {
    const key = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("seeker_session="))?.slice("seeker_session=".length);
    const session = key ? sessions.get(key) : undefined;
    if (session && session.expires > Date.now()) return session;
    if (key) sessions.delete(key);
    return undefined;
  };
  const authorized = (request: Request, mutation: boolean): Session | undefined => {
    const origin = request.headers.get("origin");
    if (origin && origin !== base) fail("origin_denied", "Open Seeker from its local address.", 403);
    if (request.headers.get("sec-fetch-site") === "cross-site") fail("origin_denied", "Cross-site requests are not accepted.", 403);
    const bearer = request.headers.get("authorization");
    if (bearer && equal(bearer, `Bearer ${options.accessKey}`)) return undefined;
    const session = sessionFor(request);
    if (!session) fail("authentication_required", "Sign in with the local access key.", 401);
    if (mutation && (origin !== base || !equal(request.headers.get("x-seeker-csrf") ?? "", session.csrf))) {
      fail("csrf_denied", "The request is missing its same-origin session confirmation.", 403);
    }
    return session;
  };
  const body = async (request: Request) => {
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") fail("invalid_content_type", "Use application/json.", 415);
    try { return object(await request.json()); }
    catch (error) {
      if (error instanceof SeekerError) throw error;
      fail("invalid_json", "The request is not valid JSON.");
    }
  };
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: options.port ?? 4317,
    maxRequestBodySize: 65_536, idleTimeout: 10,
    async fetch(request, server) {
      try {
        const url = new URL(request.url);
        if (request.headers.get("host") !== new URL(base).host || url.origin !== base) fail("host_denied", "Use the exact local Seeker address.", 403);
        const path = url.pathname;
        if (options.hostHandler) {
          const response = await options.hostHandler(request, server);
          if (response) return response;
        }
        if (request.method === "GET") {
          if (path === "/favicon.ico") return new Response(null, { status: 204, headers: securityHeaders });
          const assets: Record<string, [string, string]> = {
            // Bun's ambient HTML type describes its default bundler; this import explicitly uses its text loader.
            "/": [html as unknown as string, "text/html"], "/app.js": [javascript, "text/javascript"], "/style.css": [css, "text/css"],
          };
          const asset = assets[path];
          if (asset) return new Response(asset[0], { headers: { ...securityHeaders, "Content-Type": `${asset[1]}; charset=utf-8` } });
          if (path === "/health") return json({ status: "ok", version });
        }
        if (path === "/api/session" && request.method === "POST") {
          if (request.headers.get("origin") !== base || request.headers.get("sec-fetch-site") === "cross-site") fail("origin_denied", "Sign in from Seeker's local page.", 403);
          const now = Date.now();
          while (failedLogins[0] !== undefined && failedLogins[0] < now - 60_000) failedLogins.shift();
          if (failedLogins.length >= 10) fail("try_later", "Too many sign-in attempts. Try again in a minute.", 429);
          const input = await body(request);
          if (!equal(text(input.token, "Access key", 128), options.accessKey)) {
            failedLogins.push(now);
            fail("invalid_key", "That access key was not accepted.", 401);
          }
          for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
          if (sessions.size >= 16) sessions.delete(sessions.keys().next().value!);
          const key = randomBytes(32).toString("hex");
          const session = { csrf: randomBytes(32).toString("hex"), expires: now + 12 * 60 * 60_000 };
          sessions.set(key, session);
          return json({ authenticated: true, csrf: session.csrf, mode: options.mode ?? "local" }, 200, {
            "Set-Cookie": `seeker_session=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
          });
        }
        const session = authorized(request, request.method !== "GET");
        if (path === "/api/session" && request.method === "GET") return json({ authenticated: true, csrf: session?.csrf ?? "", mode: options.mode ?? "local" });
        if (path === "/api/logout" && request.method === "POST") {
          if (session) for (const [key, value] of sessions) if (value === session) sessions.delete(key);
          return json({ signedOut: true }, 200, { "Set-Cookie": "seeker_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
        }
        if (path === "/api/exchanges" && request.method === "GET") return json(options.core.inbox(localRecipient));
        if (path === "/api/history" && request.method === "GET") return json(options.core.history(localRecipient, url.searchParams.get("cursor") ?? undefined));
        if (path.startsWith("/api/exchanges/") && request.method === "GET") {
          const id = decodeURIComponent(path.slice("/api/exchanges/".length));
          return json(options.core.forRecipient(id, localRecipient));
        }
        if (path === "/api/replies" && request.method === "POST") {
          const input = await body(request);
          const reply = {
            eventId: input.eventId, replyHandle: input.replyHandle, kind: input.kind,
            text: input.text, conditions: input.conditions, optionId: input.optionId,
            actorId: localRecipient.actorId, conversationId: localRecipient.conversationId,
            sourceRef: `local:${text(input.eventId, "Event", 128)}`,
          } as InboundReply;
          const result = options.core.channel("local").receive([reply])[0]!;
          if (result.status === "rejected") return json({ error: { code: result.code, message: "This reply could not apply. Refresh the question; your draft is still available." } }, 409);
          return json(result);
        }
        return json({ error: { code: "not_found", message: "Unknown local endpoint." } }, 404);
      } catch (error) {
        if (error instanceof SeekerError) return json({ error: { code: error.code, message: error.message } }, error.status);
        return json({ error: { code: "unavailable", message: "Seeker could not complete this operation. Its durable state has not been reported as handled." } }, 503);
      }
    },
    error() { return json({ error: { code: "unavailable", message: "Seeker is temporarily unavailable." } }, 503); },
  });
  base = `http://127.0.0.1:${server.port}`;
  return server;
}
