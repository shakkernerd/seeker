# Local setup and recovery

Seeker requires qualified Bun **1.4.2** on macOS or Linux. `seeker --help` and `seeker --version` describe the installed package. The repository quickstart uses `bun dist/cli.js` in place of `seeker`.

## Start

```sh
seeker start
seeker demo --port 4318
seeker start --data-dir /a/private/seeker-directory --port 4317
```

`start` creates an empty local inbox. Trusted host setup must bind a manager before that manager can submit. `demo` seeds one labelled controlled exchange and supplies a deterministic explanation/receipt handler; it is not native agent proof.

Flags override `SEEKER_DATA_DIR` and `SEEKER_PORT`, then defaults. Normal data lives in `~/.local/share/seeker`; demo data lives in `~/.local/share/seeker-demo`. An explicit data directory applies to either command. Port 4317 is the default; port 0 selects a free local port.

The listener is fixed to `127.0.0.1`. Remote binding, reverse-proxy deployment, multi-host failover, and public exposure are outside this version's setup. The terminal prints the local address and key-file path without printing the key itself.

## Authentication

Copy the value from the printed `access.key` file into the sign-in screen. To display it deliberately from a terminal, use `seeker access-key --data-dir <the-directory-printed-at-startup>`. Treat it as a credential. Do not send it to an agent, paste it into a screenshot, or put it in a URL.

Browser sessions are short-lived, HttpOnly and SameSite=Strict. Mutations require the exact local origin and session CSRF header. Scripted clients may use `Authorization: Bearer <access-key>` without browser cookies. An arbitrary Origin or Host is rejected, including when a bearer credential is supplied. The browser keeps drafts only in the open tab and warns before leaving an unsent or uncertain reply.

The data directory must be private (mode 700) and owned by the current user. The key and store are private files. This protects against other local users; software already running with your unrestricted operating-system identity is within the trusted boundary.

## State and interruption

| State | Meaning |
| --- | --- |
| Available locally / provider accepted | The named channel accepted the request; this does not prove the person read it |
| Response recorded | The authenticated reply and conditions are durably saved |
| Waiting for manager | No explicit current-manager receipt has been recorded |
| Manager received | The manager recorded receipt with an evidence reference |
| Manager handled | The manager recorded its disposition; this is not proof that an external action completed |
| Needs reconciliation | A correction, stop, or conflicting answer requires the existing manager's attention |

Close with Ctrl+C or SIGTERM. Restart with the same data directory. A browser reconnects and can sign in again; accepted replies and request identities remain in the store. An answer received while the manager is offline stays pending for that manager. No replacement task is created.

An interrupted external send becomes `unknown` because it may already have succeeded. Seeker does not automatically repeat an uncertain operation. A failed or uncertain channel contact produces one status notice for the original manager; it is not a human response. The manager can inspect the exchange and use the native attention path. Failure to deliver that notice does not create another notice.

Definite retry failures respect their delay hints and exhaust after five attempts; this never deletes the answer. Starting a configured adapter or restoring its authenticated connection can resume known-unaccepted exhausted work through the core recovery method. Retry deadlines remain in force. Unknown sends and permanent rejections are never automatically requeued.

The local page receives no input while its server is stopped, and an unsent draft exists only in its current browser tab. A provider adapter must separately report its receive-outage limits. Seeker cannot recover a provider reply that expired before intake.

## Storage and capacity

The store is SQLite with WAL, full synchronous commits, and exclusive writer ownership. A second process using the same store fails visibly, even on another port. Use local storage; a copied database on a second host is not a fenced takeover.

Keep `exchanges.sqlite` and its WAL sidecars together. Stop Seeker before copying the whole private data directory for backup. Restoring an older backup requires reconciliation with the real host and existing user decisions before relying on its state; restoration is not proof that an action remains unhandled.

No automatic deletion is implemented. At most 1,000 exchanges are active. Handled and cancelled records remain available without using active capacity. The inbox shows active work and 50 recent handled records; use **Older history** or a retained request link for earlier records. History is fetched in bounded, indexed pages. Source-event identities remain retained for replay protection.

Each exchange admits at most 32 decision revisions, 128 replies, 128 contextual messages, and 256 KiB of decision/conversation content. Manager dispositions are stored separately so a full conversation can still be acknowledged, cancelled, or transferred. The view includes the current and previous owner disposition; older owner records remain stored. These are exchange receipts, not a mirror of an agent conversation.

If one exchange fills, authenticated incoming text and conditions are saved as deferred input for its original manager, without applying a decision. Other exchanges and receiver progress continue. The UI distinguishes this state, and the manager explicitly reconciles the saved input against existing work. The pending deferred-input queue is bounded at 1,000; handled input remains retained history. A global storage/queue failure does not acknowledge an input batch. Use the original manager conversation while intake is unavailable; do not delete open exchanges to clear a warning.

For an occupied port, choose another port. For `store_in_use`, stop the existing owner instead of opening another writer. For an unsafe directory/key error, repair the stated ownership/permissions while Seeker is stopped. Logs contain operational status, not message text, keys, or raw provider URLs.
