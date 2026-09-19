import { request } from "node:http";
import { privateSocket } from "./config.ts";
import { maxWireBytes } from "./protocol.ts";

/** No TCP fallback: an unrelated listener cannot receive credentials during downtime. */
export function privateRequest(socketPath: string, path: string, credential: string, body: unknown, signal: AbortSignal): Promise<{ status: number; text: string }> {
  privateSocket(socketPath);
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > maxWireBytes) return Promise.reject(new Error("oversized_request"));
  return new Promise((resolve, reject) => {
    const client = request({ socketPath, path, method: "POST", agent: false, signal, headers: { host: "seeker", authorization: `Bearer ${credential}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxWireBytes) { client.destroy(new Error("oversized_response")); return; }
        chunks.push(bytes);
      });
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 502, text: Buffer.concat(chunks).toString("utf8") }));
    });
    client.once("error", reject);
    client.end(payload);
  });
}
