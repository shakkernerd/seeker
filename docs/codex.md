# Codex Desktop

Seeker connects an existing Codex Desktop manager to your local inbox. The manager
asks through a small MCP connector; your later reply returns to that same task in
the background, including while it is idle, working or unloaded. Your selected
task and window focus stay in place. The manager keeps its workspace, model,
history, permissions and native execution owner.

The connector runs in the runtime supplied by Codex Desktop. Seeker's service,
store and messaging channels run on Bun. Background return is one native
notification that the connector sends on the service's behalf; no model prepares
or approves it. The original manager continues to own the conversation and work.

## Set up a manager

Install the built Seeker package and the qualified Bun version described in the
[local setup guide](local.md). Background return needs nothing beyond the
registered Desktop application and its configured connector.

With Seeker stopped, register the existing task and its project:

```sh
seeker codex setup --project "$PWD" --task NATIVE_TASK_ID --label "Project manager"
seeker start
```

Use the exact task ID from Codex. A task title, workspace path or shared session
identifier cannot designate a manager. Repeat setup for each manager you choose.
Other tasks in the project may discover the tools, but cannot use a registered
manager's identity.

Setup adds an owned section to the project's `.codex/config.toml`, registers the
manager through Seeker's store, and creates private connector files in Seeker's
data directory. It preserves other project settings and uses a separate
credential from the local inbox access key. It refuses to overwrite an existing
custom `seeker` MCP configuration.
Repeat setup retains explicit enabled/required and timeout settings, including a
deliberately disabled connector. It refuses to redirect a project to another
Seeker data directory implicitly.

Reload the Seeker MCP server through Codex Desktop's supported MCP settings. For
an already loaded task, follow the host's supported reload/resume procedure while
keeping its identity. A project must be trusted for its MCP configuration to load.
Ask the manager to use Seeker's `pending` tool once to confirm admission; routine
conversation then needs no polling. Setup does not change native permission
policies or approve other tools.

That first admitted call also records the qualified Desktop application, profile,
native storage locations and process owner in a private `codex-desktop.json`
beside the connector configuration. These values come from the actual native
runtime and its owner; tool arguments cannot supply a launcher or select a
profile. When upgrading an older connector, repeat setup and reload it before
making this call. Setup upgrades only the owned environment forwarding list and
retains existing enabled, required and timeout settings.

Use the same `--data-dir` for setup and startup when overriding the default.
Native traffic uses an owner-protected socket in this directory; the inbox port
is independent. The packaged launcher and connector must remain installed at the
registered location. Re-run setup after moving the package.

## Conversation and receipts

The manager uses `submit` for a new request, `get` to read a reply, and `update` to
add context, revise scope, cancel, or acknowledge receipt. A context question stays
in the same exchange. The authenticated local inbox is the initial owner channel.
An explicit `--channel` selection during setup changes future questions only;
existing exchanges remain bound to their original owner channel. Repeat setup
without this option retains the current route.

After [pairing your Telegram owner](telegram.md), select it with
`seeker codex setup --project "$PWD" --task NATIVE_TASK_ID --label "Project manager" --channel telegram`.
Use `--channel local` to select the local inbox again.

A native notification tells the manager which saved receipt to read. The manager
uses its `collection` and `itemId` with `get` to retrieve the complete reply and
current exchange before treating its content as an instruction. A deferred event
also uses its original `channelId`. Reads include the current proposal and the
selected item's original proposal when different. History is returned in bounded
pages of complete records; pass `nextCursor` unchanged with the same collection
to continue. `pending` similarly pages summaries, without replacing the full
question or reply.
It acknowledges **received** after reading and **handled** after incorporating
the answer. For natural text, it sets `resolvesExchange` only when the actual
answer resolves the question; handling "Why?" leaves it open. Host acceptance is
a separate delivery state. None of these statuses
means the underlying project work is complete or grants native execution
permission.

## Background delivery and recovery

Each notification is one `send_message_to_thread` call to the original Desktop
task, made by the qualified Desktop MCP connector over the host's native tool
socket. The service decides what to send and when: it rechecks the exact target,
the pending input or saved result, the manager generation and cancellation, then
asks the connector over a private, authenticated local socket to make that one
call. The call is stamped with the receiving task and a turn that task has, the
turn that asked the question or armed the wait, so the host can attribute it;
the call identity is fresh for every attempt. No model turn prepares the call,
no approval prompt gates it, and the connector adds nothing of its own.

Delivery does not depend on what the task is doing. An idle task starts a new
turn with the notification; a task that is working receives it in its current
turn. A task that moved on to newer turns since it asked or armed still receives
its notification. Only cancellation, an owner change or an obsolete notice
withholds it. The manager then reads the complete reply or result through
Seeker's tools under its current instructions; the notification itself never
authorizes an action.

The connector stays connected through ordinary background I/O while the manager
is idle and reconnects after a service restart, without model polling. The
service sends through the most recently seen qualified connector for the
registered profile. A connector that cannot be reached before the request is
written is a definite failure and the delivery retries within its ordinary
budget; a request written without an answer is uncertain and is never resent.
The connector reports the host's own confirmation of the target; any other
answer after the request was written, an error included, leaves the delivery
uncertain, because nothing proves the host did not act on it. A connector
loaded from an earlier release announces no sending capability: the service
does not use it, reports `desktop_connector_outdated`, and delivers once a
reloaded connector connects.

Replies and results that arrive while no qualified connector is connected stay
in Seeker. Restoring the connector reopens known-unsent retries, including work
whose retry budget ended meanwhile. Accepted or uncertain notifications are
never replayed.

An unavailable host leaves replies in Seeker. When input might already have
reached Codex because the request was written but its answer was lost, delivery
remains **unknown**. Seeker does not replay that input after a connector or
service restart. The receipt and manager's later acknowledgement remain
available for reconciliation. Restarting Seeker does not create a replacement
manager.

If channel delivery fails or becomes uncertain after submission, a separate
service notice returns to the original manager. It reads the current state and
uses the task's native attention path when needed. This is not an owner reply,
and routine retries do not generate repeated notices. Saved input that could not
be incorporated is separately marked for reconciliation; the manager reads its
original scope and conditions before using `reconcile-input`.

## Compatibility and trust

The initial native path is for a local macOS Codex Desktop host that provides
native task tools and per-invocation MCP metadata. The connector checks those
capabilities at startup and makes the native input call itself; the target is
always the Desktop task. A saved task record in a
different daemon or an ACP adapter that starts another server does not establish
that return path. Requalify native behavior after host updates; the host
integration interfaces are version-sensitive. The qualified layouts include the
legacy bundled `Contents/Resources/codex` and the current nested
`codex-cli/CodexCLI.app/Contents/MacOS/codex`. Both require the actual server to be
a direct child of the registered app; arbitrary executables and indirect owners
are rejected.

[CLI managers](codex-cli.md) use their own explicitly registered native Unix
app-server. Both hosts share the same project MCP entry and tool definitions;
setup preserves their separate private registrations and verifies actual host
ancestry before selecting either path.

Manager admission uses the individual native task identity supplied by the host,
checked against explicit registration. Tool arguments cannot select a manager,
role, recipient or owner generation. Workers sharing a session tree or connector
credential gain no manager role through the normal tool interface.

The connector authenticates through a private socket and private files owned by
your OS user. It has no TCP fallback, so an unrelated local listener cannot take
over the connector's address during service downtime.

This is a trusted local host boundary. An unrestricted process running as your
OS user can read private files or change connector code; Seeker does not claim
isolation from a compromised host or a hostile peer with that access. Keep the
service on loopback and keep connector credentials out of prompts and logs.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Seeker tools are absent | Check that the project is trusted and reload its configured MCP server in Desktop. |
| The task is denied | Verify the exact registered task ID. A lead should report to its manager. |
| Native runtime is unavailable | Launch the connector through Desktop; do not replace its runtime with a PATH CLI or change host authentication. |
| Replies are waiting | Start Seeker with the registered data directory and restore the native connector. |
| Notifications stay pending after an upgrade | Reload the connector through Desktop's MCP settings so the current connector serves the service, then use `pending` from the original manager once. Keep the registered application and profile available. |
| A different Desktop profile or incompatible interface is running | Restore the registered profile and a compatible native connector; saved replies remain available. |
| Delivery is unknown | Read the retained exchange and native receipt before attempting another delivery. |
| Setup reports conflicting settings | Preserve the existing configuration and reconcile the specifically named Seeker section. |

Use `seeker codex setup --help` for the command contract. No credentials, native
session databases, screenshots or conversation transcripts are required for
setup.


## Background completion and dependency events

The same connector exposes separate [machine event tools](events.md) to host-authenticated native task owners, including ordinary workers. These do not register workers as human-decision managers. Existing human conversation tools and native approval/filter choices retain their current gates; conversation-permission setup still concerns only its four human tools.

Prepare a private per-wait producer file with `seeker event prepare`, pass only its digest/identity to `event_arm`, and let the existing job/dependency owner signal through `seeker event signal`. The saved result reaches the task when it is saved, whatever turn the task is on by then; nothing needs reanchoring. Current human stops/instructions remain authoritative when the task reads the notice. Retain the result and restore the original qualified connector instead of polling with models or replaying uncertain input.

For stable installed commands, managed startup and explicit relocation of existing state/configuration, see [installation and migration](installation.md).
