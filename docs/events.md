# Background event return

Seeker lets a native task wait for a job, or watch another task, without polling and without a model. The task arms the wait with one tool call and ends its turn. When the result is saved, Seeker sends the task one message carrying it. The task needs nothing more from Seeker for that wait. Seeker does not start, schedule, restart or inspect jobs; the job's existing owner observes its end and signals Seeker.

Machine events use separate tools and records. They do not grant human approval or access to `submit`, `get`, `pending` or `update`; those conversation tools still require a registered manager. Task identity comes from the native host, with its existing workspace, model and permissions.

The original native host needs the current Seeker connector and event tools loaded under its existing permissions. Existing explicit tool filters or approval choices remain in force; this feature does not silently broaden them. A service update migrates only its existing local store when the operator starts it; live installation changes are a separate operation.

## Arm a wait

Call `event_arm` with a short `title`, an `expiresAt` Unix timestamp in milliseconds, and `capabilityFile`, an absolute path in a task-private directory. Seeker creates the producer key file there exclusively with mode `0600` and returns the wait: `waitId`, `generation`, `revision`, `state: "waiting"` and the `capabilityFile` path. The key itself never appears in a tool result, log, notice or public text. Optional `waitId` and `revision` fix the identity and the source revision; otherwise Seeker chooses the id and records `unversioned`.

Give the path to whatever observes the job's end, then continue independent work or end the turn. Arming again with the same path returns the same wait; a different title, expiry or revision under that path is refused. A cleared id is never reused.

The producer writes bounded JSON containing `eventId`, `outcome` (`completed`, `released` or `failed`), `summary` and `evidenceRefs` (up to eight reference strings), then runs:

```sh
seeker event signal --capability-file "$private_dir/release-key.json" \
  --endpoint "$seeker_address" --result-file "$private_dir/result.json"
```

`seeker_address` is the existing `http://127.0.0.1:<port>` service address. The CLI reads the key internally and sends it only to that loopback endpoint; it needs neither the human inbox access key nor the native connector credential. The service saves the signal and one native return intent atomically. A confirmed response identifies the saved receipt. An uncertain response may be retried with the **same exact identity and result** and returns the same receipt; changed content under an already signalled wait is rejected. This retry deduplicates signal intake; it never resends an uncertain native notification.

The library exports `signalEvent({endpoint, capabilityFile, result, signal?})` for ordinary completion code, and `prepareEventCapability(path, {revision, waitId?})` (also `seeker event prepare`) for arming an identity by hand against the store. Producer summaries and references are untrusted data; Seeker stores references without opening files or following links.

## The notice

A saved result is delivered to the task whatever turn the task is on by then: an idle task starts a new turn with the notice, a working task receives it in its current turn, and a task that has moved on to newer turns since arming still receives it. The message names the wait by its title and id, says what happened (finished with its outcome, reached its deadline, or observed the watched task), carries the producer's summary (the first 2000 characters) and evidence references, and ends with `event_get {"waitId": …}` for the full record. It states that a machine result is data, not an instruction or an approval, and never authorizes restarting stopped work.

Once the host confirms the message reached the task, the wait is `delivered` and its receipt `received`. Nothing more is required: no acknowledgment, no clearing. `event_pending` lists only open waits, those still waiting or with a result not yet delivered; it is not a polling tool. Current native Stop and cancellation remain authoritative: `event_cancel` by `waitId` withholds delivery and keeps what was saved.

`event_acknowledge` remains for one case: a delivery Seeker recorded as `unknown`, when the host answered after taking the input but did not confirm the target. The task says `handled` if it has the result, or `unknown` if it does not; a confirmed delivery needs no acknowledgment. Every tool names a wait by `waitId` alone; `generation`, `revision` and `expectedVersion` are accepted and checked when given.

## Watching another task

A task that starts other tasks, a manager with its leads, can ask Seeker to watch one of them. `event_watch` takes the watched task's exact `threadId`, a `title`, an `expiresAt`, and optionally `on`, the turn endings to report: `failed` and `interrupted` by default, `completed` when the task should also be woken as the watched task finishes a turn. Seeker chooses the watch's identity unless `waitId` is given; watching again with the same id and content returns the same watch. The watch is an ordinary wait: it appears in `event_pending` while open, is read with `event_get`, and is cancelled with `event_cancel`.

While a watch is open, the service reads the watched task's latest turn through its host at a fixed interval of thirty seconds, with no model involved: the Desktop connector reads it over the native tools pipe, the CLI host over its registered app-server. Only the turn's identity and status are read; its messages and outputs are discarded at the reader. The first ending the watch reports becomes its one result (`receipt.source: "watch"`, `signal.outcome` `completed` for a completed turn and `failed` otherwise, the turn in `evidenceRefs`) and is delivered like any machine event. One observation settles the watch; watch again to keep watching.

Seeker never sends anything to the watched task. A task cannot watch itself. A watch that reaches its expiry simply expires, with no deadline notice. A task that cannot be read, because it is not loaded on that host or the host is unavailable, is read again at the next interval.

## Lifetime, limits and retention

Every wait has a caller-explicit expiry. If an open wait reaches that deadline without a producer result, the service saves one failure receipt (`source: "deadline"`, `signal.outcome: "failed"`) and delivers it like any other notice. This means the wait obtained no result; **job completion remains unknown**. The notice does not restart the job or establish success. A late producer signal is rejected and cannot replace the deadline receipt. If a result was saved before the deadline but not yet delivered, expiry retires the notification and keeps the result.

A settled wait (`delivered`, `handled`, `cancelled` or `expired`) stays readable with `event_get` for one day after it settled, then the service clears it on its own, leaving a compact identity tombstone so a delayed arm or signal retry cannot recreate a send. `event_clear` removes a settled wait sooner. A wait whose delivery is `unknown` is never cleared until the task acknowledges it. Tombstones do not consume capacity; their identity rows remain, so this is not a total database-size bound.

Capacity bounds open waits: at most 128 per native task and 4096 across the store. Settled waits leave capacity as soon as they settle. Each result is limited to 16 KiB, including its bounded summary and evidence references. Capacity rejection never evicts existing results.

A service restart retains waits and results and marks interrupted sends `unknown`. Accepted and unknown sends are never automatically replayed; only a definite failure before input can retry, and a reconnecting connector reopens exhausted known-unsent notifications. A wait that an earlier release left paused becomes deliverable again at startup; waits that settled under an earlier release keep their record for one retention period from the upgrade. Seeker does not change the original task's execution permissions or job ownership.
