# Install and manage Seeker

Seeker uses one private home, `~/.seeker`. Its application is in `app/`, its qualified Bun runtime in `runtime/`, stable commands in `bin/`, and bounded operational logs in `logs/`. The database, credentials and native registrations remain at the home root. An application upgrade replaces only the owned application, runtime and launchers. Existing explicit `--data-dir` and `SEEKER_DATA_DIR` overrides still select a separate store; they are never silently merged.

## Install an exact local package

Build or unpack the selected Seeker package and supply the existing qualified Bun 1.4.2 executable. The installer consumes a built package; it does not download dependencies, install another host, publish a package or schedule updates. Production dependencies are included in the built CLI.

```sh
/path/to/bun /path/to/package/dist/cli.js install --runtime /path/to/bun --dry-run
/path/to/bun /path/to/package/dist/cli.js install --runtime /path/to/bun
~/.seeker/bin/seeker --help
```

The plan shows exact owned paths, version and integration steps. An existing `app`, `bin` or `runtime` without the matching installation identity is a collision, not permission to replace it. The installer also refuses modified files, unknown additions and symbolic links in the package. It validates the staged application without its source directory or dependency installation before switching it into place. Keep the home private (mode 0700); credentials and logs are mode 0600.

Add `export PATH="$HOME/.seeker/bin:$PATH"` once to the startup file for your selected shell. The installer prints this step and does not edit shell files. Service and connector commands use absolute paths.

## Connect native event tools

```sh
~/.seeker/bin/seeker install connect --config "$HOME/.codex/config.toml" --dry-run
~/.seeker/bin/seeker install connect --config "$HOME/.codex/config.toml"
```

This prepares separate private Desktop and CLI transport credentials and adds the event-only `seeker_events` entry. It checks the existing official Codex CLI prerequisite and reports an unavailable runtime without installing one. It does not register a human manager, expose conversation tools, or change existing filters, approvals, trust or timeouts. Existing entries from another installation require the explicit migration below. Human-manager setup remains project-local through `seeker codex setup` or `seeker codex-cli setup`.

Reload the affected MCP server using the original host's supported settings, preserving active tasks. Seeker never restarts Codex. Invoke `event_pending` in a genuine native task to qualify admission, then complete an arm/signal/original-task return scenario. A healthy service and a config file alone do not establish native delivery readiness. Keep the official Codex CLI on the service's PATH; the native connector continues using the runtime supplied by Codex.

## macOS login service

```sh
seeker service enable
seeker service status
seeker service logs
seeker service stop
seeker service start
seeker service restart
seeker service disable
```

`enable` installs the per-user `~/Library/LaunchAgents/com.seeker.service.plist`, starts the service and enables login startup. launchd restarts unsuccessful exits with a ten-second throttle. It runs one installed process on `127.0.0.1:4317`. It does not run before login or keep the computer awake. The existing SQLite owner check prevents a second writer.

`stop` unloads the service for the current login session and waits for its process to settle. It stays stopped until `start` or the next login. `disable` also removes the owned login definition and disables subsequent login startup. Start never creates a missing login definition; use explicit enable. Foreground `seeker start` remains available, including on other platforms. `--dry-run` shows a lifecycle plan without changing it.

`status` reports installation, service PID/state, store presence and connector configuration separately. It does not make a model call or claim that native delivery is ready. `logs` returns at most the last 64 KiB; the managed service keeps three log files of at most 10 MiB each. Durable exchanges and event evidence are not log rotation targets.

## Upgrade and migrate

For an ordinary upgrade, settle the old connector consumers, stop the owned service, run the selected new package's `install --dry-run` and `install`, then start the service and reload/qualify its connectors. Retain the original package until qualification completes. No automatic code updates occur. An interrupted operation leaves `.installation-lock` and, during a switch, `.installation-progress.json` with the exact source, stage and completed moves. Do not start a service, discard staged files, remove the lock or substitute an empty store until the recorded moves have been reconciled. Recover using a binary compatible with the same authoritative store; never restore a stale database copy.

To move a previous installation, stage the new application first while the existing service continues running. Inventory active producers and loaded connectors before scheduling the cutover. Stop only after each producer is settled or can retry the same immutable signal, and all old connectors can be reloaded. Then move the store explicitly:

```sh
seeker install migrate --from-data /old/private/data \
  --from-launcher /old/package/bin/seeker-codex \
  --config "$HOME/.codex/config.toml" \
  --config /existing/project/.codex/config.toml --dry-run
# Run the same command without --dry-run after reviewing the plan.
```

Supply every affected host/project configuration. Migration refuses a live database writer, active native sockets, private-state violations or destination collisions. It checks SQLite integrity and checkpoints the stopped store, then moves the complete state; it does not leave a second writable copy. Only known connector socket/credential and internal Telegram token paths are relocated. Task identities, registrations, receipts, event payloads and external producer files are preserved. The shared `telegram-receivers` directory is active ownership state and must remain intact.

Migration refuses to move the state while an open wait holds a producer key Seeker placed under the old home; let those waits finish or cancel them first. MCP relocation accepts only entries matching the declared old launcher and store. It changes command/config/runtime paths while preserving every other parsed setting. Customized or multiline path definitions require explicit reconciliation. The source directory remains as an empty origin after success. Reload and qualify each affected connector before retiring old packages or claiming migration complete. No accepted or uncertain notification is replayed by relocation.

A different computer gets its own home, store and registrations. Never copy an active Telegram receiver's credentials or share a writable database between hosts.

## Remove the application

Run `seeker install remove --config /path/to/host/config.toml --config /path/to/project/.codex/config.toml --dry-run` to inspect exact targets, then repeat without `--dry-run`. Supply every affected configuration and settle its loaded connector first. Removal disables the owned login service, removes only matching installed Seeker MCP entries and verified `app`, `bin` and `runtime` paths. It preserves the database, credentials, registrations, helper state, receiver ownership and logs. Data erasure is deliberately not an uninstall operation. Remove the disclosed shell PATH line yourself if no longer needed.
