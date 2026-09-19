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

Manager changes use an expected record version. `revise` changes the immutable decision; `context` adds an idempotent explanation; `cancel` preserves the record. An `acknowledge` names the exact receipt, current version, status, and evidence reference. Merely reading a receipt does not consume it. `store.transfer` is a separate trusted host operation that advances the owner generation for the same assignment and excludes the old owner.

## Human channels

`MessagingChannel.send` receives a fixed recipient and immutable revision, including a bounded decision and opaque reply handle. It must return promptly with `accepted`, `retry`, `rejected`, or `unknown`. A retry result means the send is known not to have been accepted; an ambiguous network outcome is `unknown`. Respect the supplied `AbortSignal` and keep credentials out of messages, result codes, references, and logs.

`core.channel(channelId)` gives the channel its private `ChannelIngress`. The adapter authenticates ingress and the actual actor; the core also checks the configured actor and conversation. Call `receive(events, progress)` before acknowledging provider intake. All events, source deduplication, new receipts, and the optional receiver cursor commit as one batch. Storage failure means the batch is not acknowledged.

The channel normalizes only necessary text and provenance, never raw provider payloads. Use an opaque revision handle or a provider message reference. `resolveMessage` is scoped to the channel and conversation. Bare replies correlate only when exactly one exchange is pending for the actor and conversation; otherwise `unmatched` reports ambiguity. The adapter must ask the person to reply to the intended message instead of choosing the latest manager. Unmatched normalized input is retained, and no decision effect is produced.

Declared choices use the corresponding `kind` and `optionId`. Free text uses `answer` or `question`; it does not manufacture explicit approval. Conditions remain intact. Stops and corrections can be recorded even against an earlier revision or cancelled request.

Results distinguish recorded input, duplicate input, rejected stale/invalid scope, and unmatched input. A receiver must make unsupported or unmatched input visible through its supported channel response. A `possible-gap` continuity marker remains visible across subsequent successful polls; successful polling alone cannot prove missing input was recovered.

## Manager return

`HostAdapter.deliver` receives an immutable receipt envelope addressed through the trusted binding. Stable receipt IDs support reconciliation after reconnect. Host acceptance does not mark manager receipt or handling. Only the current manager's explicit acknowledgment changes those dispositions.

Verified original native human messages use `core.receiveNative`, which is separate from the manager tool port. A quoted answer, forwarded text, or a caller-selected user role is not a verified native source. Native and channel receipts preserve their distinct provenance.

## Composition

Create one store and `SeekerCore`, configure the concrete adapters, then call `startRuntime({ core, accessKey, channels, hosts, hostHandler })`. It supplies the local inbox and delivery pump. The caller starts/stops provider receivers and closes the store after the runtime stops. There is no automatic provider discovery or second daemon per channel. A native bridge may mount its narrow, independently authenticated routes through `hostHandler`.
