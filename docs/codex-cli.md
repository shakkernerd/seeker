# Codex CLI managers

Seeker connects an existing CLI manager to the same local inbox and optional paired Telegram channel as Desktop. The manager keeps its native task, context, workspace, model and command/filesystem permissions. Only explicitly registered managers can use Seeker; a worker's shared session lineage does not grant its manager's identity.

## Connect the existing manager

Use the qualified Bun 1.4.2 package on macOS. Keep the original CLI task and its local Unix app-server running, and stop Seeker while changing registration. The CLI's default daemon address is shown below; for an existing `--remote unix:///...` connection, use that same socket path.

```sh
bun dist/cli.js codex-cli setup \
  --project /absolute/path/to/project \
  --task <existing-native-task-id> \
  --label "Project manager" \
  --conversation-permissions allow
bun dist/cli.js codex-cli reload \
  --project /absolute/path/to/project \
  --task <existing-native-task-id> \
  --socket "$HOME/.codex/app-server-control/app-server-control.sock"
bun dist/cli.js start
```

Setup updates only the project's Seeker MCP block, preserving other servers and existing Seeker lifecycle settings. The separate `reload` command verifies that the named endpoint already has this task loaded in the selected project, then explicitly refreshes MCP configuration for **all loaded tasks** on that app-server. Healthy unchanged connections and ordinary in-flight calls remain intact; pending MCP changes in other projects may activate, and removed Apps-server subscriptions may stop. Native model and command/filesystem settings are preserved. The command checks this task's connected Seeker runtime and tool inventory after reload; `/mcp` in the existing CLI also shows inventory and is not itself a reload command.

Use Seeker's `pending` tool once from the original manager after starting the service. This genuine invocation records its native execution owner for later return and recovery. Setup alone does not prove admission. Select an already paired channel with `--channel telegram`; use `--channel local` for the inbox. Changes apply to future questions; existing exchanges retain their original route.

Desktop and CLI share one `[mcp_servers.seeker]` entry and the unchanged `submit`, `get`, `pending`, and `update` tools. Each host has its own private registration. Running setup for one preserves the other. The launcher records a qualified Bun fallback and uses Desktop's supplied runtime when available; actual process ancestry chooses the host, including when CLI inherits Desktop variables from a terminal.

## Approve the conversation tools explicitly

Default setup preserves native tool permissions. The example explicitly chooses `--conversation-permissions allow` so an admitted manager can submit, read and handle Seeker conversations without a separate approval prompt for every Seeker call. It sets only these four native approval leaves in the owned project block:

```toml
[mcp_servers.seeker.tools.submit]
approval_mode = "approve"
[mcp_servers.seeker.tools.get]
approval_mode = "approve"
[mcp_servers.seeker.tools.pending]
approval_mode = "approve"
[mcp_servers.seeker.tools.update]
approval_mode = "approve"
```

The native grant is scoped to this project/server configuration, including either host that uses the shared entry. All native tasks using that configuration receive these tool approvals; Seeker's separate actual-task admission still denies unregistered workers. No permission is granted to future tool names, other MCP servers, commands or filesystem actions.

`allow` checks the complete change before writing and refuses a conflicting deliberate approval or enable/filter restriction. Use `--conversation-permissions replace` only when you explicitly intend to replace the four conversation tools' existing approval modes. Other tool settings, output limits, server enablement and tool filters are preserved, and remaining restrictions are reported. Native managed authorization and strict review gates still apply, so configured approval alone is not a claim of unattended readiness.

Codex resolves a tool's explicit approval mode before its server default. The `approve` value is the same native setting used by Always allow. It permits these ordinary MCP calls even with native approval policy `never` and a read-only sandbox; those execution settings themselves stay unchanged. Run the explicit host reload after a permission change, then verify admission from the original manager.

## Replies and recovery

An authenticated reply enters Seeker's existing durable queue. The service sends a short notification through `turn/start` on the original CLI app-server. The native runtime starts an idle turn or steers its active turn. The manager then reads the complete stored reply through `get` and explicitly acknowledges handling with `update`. Transport acceptance alone does not mark a reply handled, and a request for context keeps the decision open.

If that manager is unloaded, Seeker resumes its saved UUID on the same host. If its recorded host process has exited, Seeker can start the captured native executable with the same home, state directory, working directory, Unix listener and observed remote-access mode, then resume the same task. Preparation is bounded and shared by pending deliveries; it does not submit input. A fresh delivery attempt checks the current assignment and exchange before writing.

Native permissions still apply to every tool. In particular, Codex can reject unapproved mutating MCP tools under approval policy `never`, or request permission in its native interface under `on-request`. Seeker does not answer, auto-approve or auto-deny those requests. Reconnect the original CLI interface to answer native approvals after a headless recovery. A Seeker owner reply is not a native execution permission.

Known-unaccepted work may retry after readiness returns. A lost response after a native write remains uncertain and is not replayed automatically. Reconcile it against the original task and retained exchange. No durable native idempotency guarantee is inferred from an input identifier.

## Supported boundary

The native path is qualified against local Unix app-server contracts from Codex CLI 0.153.2 and 0.154.0. These app-server APIs are experimental. An embedded TUI, network WebSocket, custom launch flags, changed executable or ambiguous native profile cannot silently become a different daemon or conversation. Keep the existing task and deliberately reconcile the unsupported host configuration; registration does not migrate it.

The service stores CLI bridge state under the private Seeker data directory's `cli/` subdirectory. It does not copy native conversations, credentials or provider configuration. The native host owns its saved session and authentication. Stop Seeker normally to close its private listener and pending preparation; an already recovered native host retains its own lifetime.
