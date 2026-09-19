# Codex Desktop

Seeker connects an existing Codex Desktop manager to your local inbox. The manager
asks through a small MCP connector; your later reply returns to that same task,
including while it is idle or already working. The task keeps its workspace,
model, history, permissions and native execution owner.
After native registration, Seeker can also resume a task that Desktop has
unloaded, or start its registered Desktop host when it is stopped.

The connector runs in the runtime supplied by Codex Desktop. Seeker's service,
store and messaging channels run on Bun. No additional model or agent executor
is involved.

## Set up a manager

Install the built Seeker package and the qualified Bun version described in the
[local setup guide](local.md). With Seeker stopped, register the existing task and
its project:

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

When a saved reply has no receiving connector, Seeker allows normal polling gaps
and in-flight native input to finish before requesting one host wake. It uses the
registered application's existing-task link without adding a model prompt or
overriding task settings. Desktop may come to the foreground and show that task.
If the app is stopped, it starts with the registered profile and native storage
locations. The authentic connector must qualify again before receiving input.
Starting the app is separate from delivering the reply: slow startup leaves the
reply saved and retryable, and receiver readiness restores known-undelivered
work even after its ordinary retries have ended.

An ordinary manual app restart can change the process IDs. Seeker verifies the
running application's actual Desktop profile, code home and native database
location before resuming the original task; a matching process ID alone is not
the host identity. The connector then qualifies again before receiving input.
A different or unreadable profile, ambiguous instances, missing storage evidence,
or a changed application build remains blocked until the original native host can
be qualified. Keep one Desktop profile per Seeker data directory.

An unavailable host leaves replies in Seeker. When input might already have
reached Codex but its result was lost, delivery remains **unknown**; Seeker does
not blindly submit the same native input again. The receipt and manager's later
acknowledgement remain available for reconciliation. Restarting Seeker does not
create a replacement manager.

If channel delivery fails or becomes uncertain after submission, a separate
service notice returns to the original manager. It reads the current state and
uses the task's native attention path when needed. This is not an owner reply,
and routine retries do not generate repeated notices. Saved input that could not
be incorporated is separately marked for reconciliation; the manager reads its
original scope and conditions before using `reconcile-input`.

## Compatibility and trust

The initial native path is for a local macOS Codex Desktop host that provides
native task tools and per-invocation MCP metadata. The connector checks those
capabilities at startup. A standalone CLI, an ACP adapter that starts another
server, and a saved task record in a different daemon are not attachment to the
Desktop task. Requalify native behavior after host updates; the host integration
interfaces are version-sensitive.

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
| Automatic Desktop recovery is unavailable | Repeat setup after upgrading, reload the connector, and use `pending` from the original manager once. Keep the registered application and profile available. |
| A different Desktop instance or build is running | Qualify its authentic connector in the original manager before retrying; do not substitute another profile or daemon. |
| Delivery is unknown | Read the retained exchange and native receipt before attempting another delivery. |
| Setup reports conflicting settings | Preserve the existing configuration and reconcile the specifically named Seeker section. |

Use `seeker codex setup --help` for the command contract. No credentials, native
session databases, screenshots or conversation transcripts are required for
setup.
