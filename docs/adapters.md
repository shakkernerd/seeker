# Adapter contracts

The package exports its typed contracts and concrete local implementation from `@shakkernerd/seeker`. The canonical definitions are in [`src/contracts.ts`](../src/contracts.ts).

## Host origin and setup

Trusted setup calls `core.bind(binding)` to fix the originating host, individual manager, existing assignment reference, owner generation, and recipient. `core.manager(origin)` exposes only submission, scoped reads, and manager updates. Origin comes from the host, never from model-supplied role, recipient, task, or title fields. Native turn/call identifiers are provenance; they do not prevent the same manager from acting on a later turn.

A same-user process with unrestricted filesystem and process access remains inside the trusted local boundary. An application field or shared bearer credential does not establish isolation against such a process. Each real host adapter must prove its actual admission path independently.

```ts
const manager = core.manager(authenticatedHostOrigin);
const exchange = manager.submit({ requestId: retainedRequestId, decision });
const pending = manager.listPending();
```

`requestId` is retained before the first call. Recover an uncertain create by reading or repeating that same request, never by creating a new identity. `assignmentId` references existing work rather than creating a second task ledger.

`submit`, `get`, and `update` return a bounded `ExchangeRead`: exchange metadata, the complete `current` decision, collection counts, and at most one complete saved item. `get(requestId, { collection, cursor })` pages through `receipts` (the default), `deferred`, `context`, `revisions`, or `deliveries`. Follow the returned `nextCursor` with the same request and collection. Counts expose pending receipts and deferred inputs even when they are outside the selected page. `listPending({ cursor })` returns up to 20 small summaries and a total; open each request to read its content. Reads never mark anything received or handled.

For a host wakeup, fetch the named record directly: `get(requestId, { collection: "receipts", itemId: receiptId })`, or `get(requestId, { collection: "deferred", itemId: eventId, channelId })`. Delivery notices use `collection: "deliveries"` and their delivery ID. A selected record from an older revision includes its complete `itemRevision` beside `current`, preserving the proposal it actually answered. No reply, condition, or decision text is truncated to fit a transport frame. Pagination is a current view of retained records, not a frozen snapshot; use the returned exchange version for mutations.

Manager changes use an expected record version. `revise` changes the immutable decision; `context` adds an idempotent explanation; `cancel` preserves the record. An `acknowledge` names the exact receipt, current version, status, and evidence reference. Merely reading a receipt does not consume it. Handling natural text does not itself close a decision: the manager supplies `resolvesExchange: true` only after interpreting a genuine answer to the current proposal. Handling a context question leaves it open. Declared choices and attention acknowledgments retain their declared endpoints.

`store.transfer` is a separate trusted host operation that advances the owner generation for the same assignment and excludes the old owner. `core.setRecipient(bindingId, expectedGeneration, recipient)` is a privileged setup operation for future requests. Existing exchanges keep their original recipient and reply correlation. A model-facing manager port exposes neither operation. Application setup selects a configured recipient; a host adapter does not know which messaging provider implements it.

## Human channels

`MessagingChannel.send` receives a fixed recipient and immutable revision, including a bounded decision and opaque reply handle. It must return promptly with `accepted`, `retry`, `rejected`, or `unknown`. A retry result means the send is known not to have been accepted; an ambiguous network outcome is `unknown`. Respect the supplied `AbortSignal` and keep credentials out of messages, result codes, references, and logs.

`core.channel(channelId)` gives the channel its private `ChannelIngress`. The adapter authenticates ingress and the actual actor; the core also checks the configured actor and conversation. Call `receive(events, progress)` before acknowledging provider intake. All events, source deduplication, new receipts, and the optional receiver cursor commit as one batch. Storage failure means the batch is not acknowledged.

The channel normalizes only necessary text and provenance, never raw provider payloads. Use an opaque revision handle or a provider message reference. `resolveMessage` is scoped to the channel and conversation. Bare replies require one temporally eligible pending exchange and a recorded accepted initial question before the source-time interval. Normalize the source time and its `occurredAtPrecisionMs` interval when rounded. Missing time, a future revision, unconfirmed presentation, multiple possible targets, or overlapping time uncertainty return `unmatched`; explicit handles remain usable for same-second replies and unknown-send recovery. The adapter asks the person to reply to the intended message instead of guessing the latest manager. Unmatched normalized input is retained, and no decision effect is produced.

Declared choices use the corresponding `kind` and `optionId`. Free text uses `answer` or `question`; it does not manufacture explicit approval. Conditions remain intact. Stops and corrections can be recorded even against an earlier revision or cancelled request.

Results distinguish recorded input, duplicate input, rejected stale/invalid scope, unmatched input, and deferred input. A per-exchange capacity limit returns `deferred`: normalized text, conditions, source and target are durably saved, but no decision is applied. Unrelated events and the batch cursor can still commit. The original manager receives a `DeferredEnvelope` and uses `reconcile-input` with current version and evidence to record handling outside the full conversation. Global storage/queue failure still aborts the batch.

A receiver must make unsupported, unmatched, or deferred input visible through its supported channel response. A question revised or closed after a buffered reply cannot make another question its inferred destination; retained presentation/change evidence instead requires clarification. Corrections that edit an existing message use its original `sourceRef` and reply correlation; unchanged metadata-only edits coalesce against that message's latest content, while A/B/A edits remain distinct. A `possible-gap` continuity marker remains visible across subsequent successful polls; successful polling alone cannot prove missing input was recovered.

## Manager return

`HostAdapter.deliver` receives a `HostEnvelope` addressed through the trusted binding: a human receipt, saved deferred input, or an operational delivery notice. The latter two are explicitly distinguished from a human decision. Stable identities support reconciliation after reconnect. Host acceptance does not mark manager receipt or handling. Only the current manager's explicit acknowledgment changes those dispositions.

After restoring a genuine authenticated transport connection, call `core.resumeHost(hostId)` once to resume only known-unaccepted retry exhaustion; do not call it every poll. Configured adapters receive the same recovery at runtime startup. The corresponding channel method is `resumeChannel`. These methods retain retry deadlines and never replay unknown or permanent failures.

Verified original native human messages use `core.receiveNative`, which is separate from the manager tool port. A quoted answer, forwarded text, or a caller-selected user role is not a verified native source. Native and channel receipts preserve their distinct provenance.

## Composition

Create one store and `SeekerCore`, configure the concrete adapters, then call `startRuntime({ core, accessKey, channels, hosts })`. It supplies the local inbox and delivery pump. The caller starts/stops provider receivers and closes the store after the runtime stops. There is no automatic provider discovery or second daemon per channel. The built-in service loads the Codex Desktop and CLI adapters through `loadCodexHost` and its internal `loadCodexCliHost` helper. Each adapter owns a private Unix listener whose lifecycle is separate from the local inbox listener.

The Desktop adapter keeps manager admission and conversation tools on the original task. Delivery is one `send_message_to_thread` call that the qualified Desktop MCP connector makes over the host's native tool socket on the service's behalf, through a private authenticated local socket between them. During a current delivery attempt, the service rechecks the exact target, notification, binding generation, cancellation and pending receipt, deferred input or notice, then asks the connector for that one call stamped with the receiving task and a turn it has. It resolves delivery from the host's own confirmation of the target. No model prepares, approves or narrates the call, and nothing about the task's current turn holds it back. Background return preserves task selection, window focus and manager settings; an absent registered application may open in the background without a task URI.

A connector that cannot be reached before the request is written is a definite, retryable failure; a request written without an answer is uncertain and cannot be replayed on restart. See [Desktop setup and recovery](codex.md) for profile qualification.

The CLI adapter directs input to its registered native app-server, with startup and same-UUID resumption outside `deliver`'s short I/O budget. Preparation never sends a notification. The next delivery attempt rechecks the full binding generation, cancellation and receipt before writing. Native server requests are ignored without a JSON-RPC response so the original CLI's approval callbacks remain available. See [CLI setup and recovery](codex-cli.md) for the native host and permission boundaries.


## Machine event ports

`SeekerCore.events` binds a host-produced native task/turn/call identity to a separate `EventPort`. It does not create a `ManagerBinding` or expose human decision tools. The host authenticates invocation metadata and admits only the calling task; model arguments and producer capabilities cannot choose the return target. Preserve any existing manager-assignment generation independently of the wait's producer generation/source revision.

The store's `events` port commits one immutable signal/result and native outbox intent atomically, shares the existing single-writer connection, and retains explicit receipt/delivery evidence. Custom stores must implement that contract; an in-memory fallback is not equivalent. See [event lifetime, limits and clearing](events.md).

`HostAdapter.threadState`, when a host implements it, reads the latest turn of a task that host serves, stamped with the watching task, and returns only the turn's identity, status and, when the host reports it, completion time; the service's thread watcher calls it for every open watch at a fixed interval and hands each read to the store, which records an observation for the first ending of a reported kind that happened after the watch was armed. A host without it serves no watches.

`HostAdapter.deliver` receives a minimal `NativeReturnTarget` and a `NativeEnvelope`: either the existing human envelope or a distinct `EventEnvelope`. An event carries the saved wait/receipt identities and the bounded result (title, source, outcome, truncated summary, evidence references) that the host puts in the notice; the summary is untrusted producer data and the notice says so. An adapter that admits event owners must implement the native event variant and its currency fences. Existing human-only adapters should explicitly reject an event variant if supplied; they must not interpret it as a human decision.

Delivery is not anchored to the turn that armed the wait. The adapter sends when the result is saved and the wait is still current; the host decides whether that starts a new turn or joins the active one. An accepted outcome settles the wait as delivered. Cancellation after a written request does not retract accepted input. Accepted and unknown outcomes remain attached for reconciliation and never replay. Producer identity and saved receipt remain unchanged.
