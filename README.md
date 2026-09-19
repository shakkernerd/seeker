# Seeker

**A place for the questions your agents need you to answer.**

Seeker brings an agent manager's question into a small, durable conversation. Read the proposal, ask for context, add a condition, or give an answer. The reply stays attached to the original manager and the exact decision you saw, even across a restart.

Seeker carries the conversation. Your existing agent host continues to own the work and its permissions.

## Try it locally

Install [Bun 1.4.2](https://bun.sh/docs/installation), then:

```sh
git clone https://github.com/shakkernerd/seeker.git
cd seeker
bun install --frozen-lockfile
bun run build
bun dist/cli.js demo
```

Open the localhost address printed in the terminal. Copy the access key from the named file into the sign-in screen. Try asking “Why is that needed?”, then answer the sample question with a condition.

The demo is clearly labelled and uses a deterministic host fixture. It changes no repository, contacts no messaging provider, and keeps its own data directory. For an empty inbox, run `bun dist/cli.js start`. Both commands retain their exchanges when you stop them with Ctrl+C.

## A conversation you can trust

- **Enough context to decide.** Each question shows its target, effect, scope, conditions, and actual alternatives.
- **Room to discuss.** Ask a question or reply naturally. A request for context does not approve an action.
- **Honest progress.** See whether your response is recorded, waiting for the manager, received, or handled.
- **Recoverable answers.** Pending exchanges survive interruption. Changed proposals retire old choices; later corrections and stops remain visible.
- **Quiet by default.** One prompt per decision, with no recurring reminders.

The local channel is available immediately. [Codex Desktop setup](docs/codex.md) and [Codex CLI setup](docs/codex-cli.md) connect existing managers and return replies to those same native tasks. They share one project MCP entry. [Telegram setup](docs/telegram.md) adds an optional private conversation with a deliberately paired owner. The local demo uses its labelled fixture; live connections are configured separately.

## Use and extend

[Local setup and recovery](docs/local.md) covers authentication, data, startup, and operating limits. [Architecture](docs/architecture.md) explains the component boundaries. [Adapter contracts](docs/adapters.md) describes authenticated origin, reply correlation, and receipts. [Development and packaging](docs/development.md) covers verification and the installable tarball.

Seeker runs as one Bun process with one local SQLite store. It listens on loopback and uses grammY for its optional Telegram adapter. It does not contain an LLM or agent executor.

MIT licensed.
