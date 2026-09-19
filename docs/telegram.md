# Telegram

Telegram is an optional channel for discussing Seeker requests with their originating managers. You can answer in ordinary text, ask for more context, or choose a request's buttons. A dedicated bot connects one deliberately paired owner to the same durable exchanges used by Seeker's other adapters.

Start with the [local demo](../README.md) if you want to try Seeker before creating a bot. Telegram setup is separate from designating an agent manager.

## Pair your account

Create a dedicated bot using [Telegram's official setup instructions](https://core.telegram.org/bots/tutorial#obtain-your-bot-token). Keep its token in a private file, outside repositories and shared folders. The file must be owned by your user, with permissions `600`; its parent directory should be private. Do not put the token in command arguments, chat messages, screenshots, or model tool arguments.

```sh
seeker telegram pair --token-file /path/to/private/telegram.token
```

Add `--data-dir /path/to/private/seeker` if you use a custom Seeker directory. Stop the existing Seeker process for that directory first.

1. Open the invitation printed in your terminal using the Telegram account you intend to pair. The invitation expires after ten minutes.
2. Press Start in that private bot chat. Seeker sends a short confirmation code into the chat.
3. Enter that code in the same local terminal. Confirm only if you can see the code in your intended account's chat.

The owner is saved only after that local confirmation. A public username, the first person to message the bot, or possession of the invitation alone does not enroll an owner. Replayed and expired invitations cannot pair another account. Cancelling or restarting an unfinished setup requires a new invitation.

Seeker saves the verified numeric account and private-chat IDs, bot identity, and token-file path in a private `telegram.json` file. The bot token stays in its separate file; neither the invitation nor confirmation code is retained. Pairing does not create a manager or grant an agent access to a recipient. Select the saved Telegram recipient through the host adapter's trusted manager setup.

Changing a manager's selected channel affects new questions. Existing questions keep their original channel and reply references, so continue answering them where you received them. Keep that original channel available until those exchanges are handled.

## Run Seeker

```sh
seeker telegram status
seeker start
```

Use the same `--data-dir` for both commands when it is customized. `status` reports whether a pairing is configured; startup checks provider connectivity, bot identity, and receiver ownership. The normal Seeker process runs the local inbox, core, configured host adapters, and Telegram receiver together. An unconfigured installation starts without contacting Telegram. The controlled local demo does not start the Telegram adapter.

Keep one receiver per bot. Do not give this bot token to another Seeker process, OpenClaw instance, polling client, or webhook service. Seeker refuses a configured webhook and competing receiver errors; it does not delete another application's webhook or take over its bot. A host-local lock also prevents two Seeker processes using the same bot, even with different data directories. Operating the same bot on several machines is unsupported.

Press Ctrl+C to stop. Seeker cancels polling, releases its receiver lock, and retains accepted exchanges and responses. Start again with the same private data directory to recover them.

## Discuss a request

Every prompt identifies its manager, exchange, and revision, and presents the decision's scope and conditions. Telegram requests must fit completely within one 4,096-character message, including this context. Oversized requests are rejected visibly rather than shortened; the manager must provide a smaller complete question.

- Reply to the specific message to answer or ask a follow-up question. Questions ending in `?` remain questions; free text is preserved for the manager to interpret.
- Use **More context** to ask that same manager for an explanation. Its answer arrives within the same exchange.
- Use `/pending` to see open requests, or `/help` for a short reminder of the supported interaction.
- If several requests are open, a bare reply is ambiguous. Seeker asks you to reply to the intended request instead of selecting the newest manager.
- Buffered replies cannot answer a newer question that did not exist when they were sent. If Telegram's rounded timestamp leaves the context uncertain, Seeker asks for a direct reply to the intended request.
- An old choice cannot authorize a materially changed revision. Reply to the current prompt to answer it.
- Reply with `/correct ...` or `/stop ...` to preserve a later correction, including a correction to an old request. Editing an earlier text answer retains its original correlation; an edit without a recoverable original reference is left unmatched.

Your own direct text is the supported input. Photos, voice messages, attachments, captions, forwarded messages, replies to external messages, and selected text quotes are not interpreted as decisions. Seeker asks for an ordinary direct reply to its request so another person's words or partial context cannot become your instruction. Groups, inline-mode interactions, private topics, automatic reminders, urgency exceptions, and public webhooks are outside this first version.

## Delivery and recovery

A successful send means **Telegram accepted the message**. It does not prove that a phone displayed it, that you read it, or that a manager acted. A saved response is separately delivered to its originating host, and manager handling remains a separate state.

If a send response is lost, delivery stays **unknown**. Seeker does not automatically resend that potentially accepted message. An authenticated reply or button can still carry its original exchange handle. A definite rate limit is retried within bounded limits, respecting Telegram's requested delay. Provider errors and transport exceptions are reduced to safe diagnostics; credential-bearing request URLs are not logged.

Received updates are committed with core-owned polling progress before Seeker acknowledges them to Telegram. Duplicate events remain idempotent across restart, and a new correction retains its own event and chronology. Network I/O and local confirmation never hold a store transaction open.

Telegram retains uncollected bot updates for up to 24 hours. This concerns receiver availability, **not how long you may wait before answering a question**: a reply to an old open request creates a new update. After a longer receiver outage, Seeker records a possible input gap rather than claiming the user ignored a request. Use the original manager conversation to reconcile potentially missing input. [Telegram update contract](https://core.telegram.org/bots/api#getting-updates)

Ordinary bot conversations are Telegram cloud chats. Send bounded decision summaries and necessary context, and keep credentials and sensitive operational material on their approved original surfaces. [Telegram privacy](https://telegram.org/privacy#3-3-1-cloud-chats)

## Troubleshooting

**Pairing did not complete.** Check that the token file is private and contains the dedicated bot's current token, the bot has no other receiver or webhook, and the invitation has not expired. Run pairing again to obtain a fresh invitation. Never publish raw provider requests while diagnosing token errors.

**The token was rotated.** Replace the contents of the same private token file while Seeker is stopped, then restart. A token for a different bot is rejected because it does not match the saved pairing. An existing pairing is never silently overwritten.

**A retry budget was exhausted.** After restoring connectivity, restart Seeker to resume requests known to have been rejected temporarily. Their recorded retry deadlines still apply. Unknown and permanent failures are not replayed by this recovery path.

**Receiver ownership remains after a crash.** Normal shutdown removes the host-local lock. After an abrupt crash, Seeker deliberately refuses automatic takeover. Stop every receiver for that bot and verify the process ID recorded in its `~/.seeker/telegram-receivers/<bot-id>.lock` file has exited. Only then remove that one stale lock and restart. Removing a lock while its owner is alive permits competing receivers. The data directory and exchange database must be preserved.

**A reply was not accepted.** Reply directly to the intended request. For a correction to an older request, use `/correct` or `/stop`. If Telegram cannot accept feedback, Seeker reports that failure locally; use the original manager conversation rather than treating silence as confirmation.

**Storage failed.** Seeker stops the receiver before advancing its acknowledgement cursor. Restore access to the same private store and restart; do not remove the database to make an error disappear. SQLite state and its recovery files belong to the core's store lifecycle.

## Verification scope

The repository exercises this adapter against a controlled HTTP provider and the real Seeker store: deliberate pairing, two-manager routing, natural discussion, replay, stale revisions, late corrections, restart, failed persistence, lost send responses, rate limiting, and cancellation. Those tests use unmistakably fake tokens.

Live bot provisioning, owner pairing, Telegram client rendering, device notifications, and human attention require a separately configured account. Controlled tests do not claim those live outcomes.

## Implementation

The adapter uses pinned **grammY 1.46.0** for Bot API methods, serialization, and provider error handling. Its public `grammy/web` entry uses Bun's native fetch without Node-specific fetch defaults. Seeker's small boundary converts SDK errors to safe delivery results and keeps the token and SDK types inside the adapter. [grammY API guide](https://grammy.dev/guide/api), [client options](https://grammy.dev/ref/core/apiclientoptions)

Core owns exchange policy, immutable revisions, response receipts, provider-message correlation, and atomic receiver progress. The adapter calls grammY's `getUpdates` explicitly so a later offset acknowledges only a batch core has durably accepted. It does not use an in-memory polling cursor or a second session store.

Seeker also owns the decision to retry. No auto-retry plugin is installed: retrying a network error or server failure could resend a message that Telegram already accepted. Definite rate limits retain their delay; uncertain sends remain visible. [grammY error handling](https://grammy.dev/guide/errors), [auto-retry behavior](https://grammy.dev/plugins/auto-retry)

Provider fixtures inject fetch at an internal SDK boundary. Production setup cannot select an arbitrary provider URL. This lets the same packaged adapter exercise the actual client path while keeping tests independent of real accounts and tokens.
