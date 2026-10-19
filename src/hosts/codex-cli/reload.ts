import { realpathSync } from "node:fs";
import { ConnectorError, record } from "../codex/protocol.ts";
import { verifyNativeSocket } from "./owner.ts";
import { CliRpc } from "./rpc.ts";
import { conversationTools, seekerTools } from "../codex/tools.ts";

/** The operator names the original endpoint; setup neither discovers nor starts a replacement host. */
export async function prepareCliReload(socketPath: string, threadId: string, project: string) {
  verifyNativeSocket(socketPath);
  const rpc = await CliRpc.connect(socketPath, AbortSignal.timeout(3_000));
  try {
    const value = record(await rpc.request("thread/read", { threadId, includeTurns: false }, AbortSignal.timeout(3_000))), thread = record(value.thread);
    if (thread.id !== threadId || record(thread.status).type === "notLoaded" || thread.cwd !== realpathSync(project)) throw new ConnectorError("wrong_cli_target", "Select the Unix app-server already owning this exact manager and project.", 409);
    return {
      // This native method refreshes MCP config for all loaded tasks on this
      // endpoint. It preserves their native settings and does not submit input.
      async reload() {
        const signal = AbortSignal.timeout(10_000);
        await rpc.request("config/mcpServer/reload", null, signal, 4_500);
        const expected = conversationTools.map((tool) => tool.name);
        const known = new Set<string>(seekerTools.map((tool) => tool.name));
        while (!signal.aborted) {
          const result = record(await rpc.request("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly", limit: 100 }, signal));
          const servers = Array.isArray(result.data) ? result.data.map(record) : [];
          const seeker = servers.find((server) => server.name === "seeker");
          if (seeker?.runtimeStatus === "connected" && seeker.toolsError == null) {
            const actual = Object.keys(record(seeker.tools));
            if (expected.every((name) => actual.includes(name)) && actual.every((name) => known.has(name))) return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new ConnectorError("cli_mcp_pending", "MCP configuration refreshed, but this manager's Seeker tools are not ready. Inspect /mcp in the original CLI task.", 503);
      },
      close() { rpc.close(); },
    };
  } catch (error) { rpc.close(); throw error; }
}
