# Background event return

Seeker can retain a wait for an existing native task and return a correlated machine completion or dependency release to that task. The existing job or dependency owner observes completion and signals Seeker. Seeker does not start, schedule, restart or inspect jobs.

Machine events use separate tools and records. They do not grant human approval or access to `submit`, `get`, `pending` or `update`; those conversation tools still require a registered manager. Task identity comes from the native host, with its existing workspace, model and permissions.

The original native host needs the current Seeker connector and event tools loaded under its existing permissions. Existing explicit tool filters or approval choices remain in force; this feature does not silently broaden them. A service update migrates only its existing local store when the operator starts it; live installation changes are a separate operation.

## Prepare and arm

Create a task-private directory and prepare a producer capability file with the installed CLI:

```sh
seeker event prepare --capability-file "$private_dir/release-key.json" --revision "$source_revision"
```

The command exclusively creates a mode `0600` file (or recovers an exact retry from the same private path) and prints `{waitId,generation,revision,capabilityDigest}`. Keep the file at its existing job/dependency owner. Its raw contents must never enter model tool arguments or output, command arguments, logs, public text or an evidence attachment. Keep the same private path for a prepare retry; another source revision or explicit wait ID is rejected. Use a fresh path for a new wait. The digest is safe to pass to Seeker's native `event_arm` tool with a short `title` and an explicit `expiresAt` Unix timestamp in milliseconds.

Use the returned identity unchanged. The source `revision` identifies the exact job/dependency version; `generation` distinguishes this particular wait. A wait is immutable. Exact arm retries recover it; a different deadline, title, key or source under the same identity is a conflict. Cancel and prepare a new identity when the wait changes. Never reuse a wait ID, including after clearing it.

After arming, continue independent authorized work. When no independent work remains, end the model turn. The signal producer must run independently of that ended turn; an unfinished model tool chain is not a completion observer.

## Signal from the existing owner

The producer writes bounded JSON containing `eventId`, `outcome` (`completed`, `released` or `failed`), `summary` and `evidenceRefs` (up to eight reference strings), then runs:

```sh
seeker event signal --capability-file "$private_dir/release-key.json" \
  --endpoint "$seeker_address" --result-file "$private_dir/result.json"
```

`seeker_address` is the existing `http://127.0.0.1:<port>` service address. The CLI reads the secret internally and sends it only to that loopback endpoint. It does not need the human inbox access key or the native connector credential. The service saves the signal and one native return intent atomically. A confirmed response identifies the saved receipt; it does not mean the native task has read or handled it.

An uncertain signal response may be retried with the **same exact identity and result**. It returns the same receipt. Changed content or a different event under an already signalled wait is rejected. This retry deduplicates signal intake; it never resends an uncertain native notification.

The library exports `prepareEventCapability(path, {revision, waitId?})` and `signalEvent({endpoint, capabilityFile, result, signal?})` for ordinary completion code. They use the same private-file and signal contract. Producer summaries and evidence references remain untrusted data; Seeker stores references without opening files or following links.

## Native receipt and reconciliation

The native notification contains only the saved wait/receipt identity. Use `event_get` with `waitId`, `generation` and `revision` to retrieve the complete result and delivery record. Inspect the referenced evidence using the task's existing authority. A machine summary is neither an instruction nor a human decision.

Acknowledge the exact receipt with `event_acknowledge`, the current `expectedVersion`, its `receiptId` and `status` (`received`, `handled` or `unknown`). Handling records that the result was incorporated. It does not establish job success or authorize unrelated work.

A newer native turn or interrupted wait pauses automatic return and retains the result. Use `event_pending` once in every new owner turn, including a wake from another event, reconnect or user activity. Read any ready results. Reconcile still-relevant waiting/paused waits with current user instructions, then `event_resume` with each exact identity and current version before ending the turn if this task should keep waiting. This proactive reanchor also applies before a wait has signalled: if waits A and B were armed together and A wakes the task, reanchor still-needed B to that new turn so B can return later. Resume preserves the producer identity, existing job and result; it does not rerun the producer or replay accepted/unknown delivery. Current native Stop and cancellation remain authoritative.

`event_cancel` revokes future admission/return and retains existing evidence. Cancellation after a native grant cannot prove that input did not escape. `event_get` and `event_pending` allow the original owner to reconcile that uncertainty after reconnect or restart.

## Lifetime and limits

Every wait has a caller-explicit expiry. If an uncancelled wait reaches that deadline without a producer result, the service atomically saves one failure receipt (`source: "deadline"`, `signal.outcome: "failed"`) and its native return intent. This means the wait failed to obtain a result; **job completion remains unknown**. The notice does not restart the job or establish success. A late producer signal is rejected and cannot replace the deadline receipt.

The existing native checks still apply to this notice: an active owner waits until its turn ends, a stopped or newer owner turn pauses return until explicit reconciliation, and cancellation prevents new delivery. A wait already paused when its deadline passes retains the failure receipt without sending until the owner explicitly resumes it. The deadline receipt can be retrieved, acknowledged and cleared through the ordinary event tools. Its notification may occur after the original expiry, but accepted and uncertain sends are never replayed.

If a producer result was already saved before the deadline, expiry continues to retire any known-unsent notification while retaining that result. Previously closed waits remain closed. Results, cancelled/expired records and uncertain delivery evidence remain retained until the owner explicitly clears them. There is no automatic age-based deletion and no invented maximum wait duration.

The service admits at most 128 retained waits per native task and 4096 across the store. Each result is limited to 16 KiB, including its bounded summary and evidence references. Capacity rejection never evicts existing results. `event_pending` returns bounded summaries; `event_get` returns one complete result.

Use `event_clear` only after settling the wait; unknown native delivery must first be explicitly reconciled as handled. Clearing removes the saved result and producer digest. A compact revoked identity tombstone remains so delayed arm/signal retries cannot recreate a send. Tombstones retain only the wait/owner identity, cleared state and its version/time. They do not consume retained-result capacity; their identity rows remain indefinitely, so this is not a total database-size bound. Remove the producer's private capability/result files through the existing owner's finished-work cleanup after required assessment.

A service restart retains waits/results and changes interrupted sends to `unknown`. Accepted and uncertain sends are never automatically replayed. Only a definite failure before input can retry; native recovery may reopen exhausted known-unsent preparation. Seeker does not change the original task's execution permissions or job ownership.
