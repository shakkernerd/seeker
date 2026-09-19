# Development and packaging

Use Bun 1.4.2, pinned in `.bun-version` and `package.json`. TypeScript and Bun's type declarations are the only development dependencies. Runtime code uses Bun HTTP/SQLite and built-in modules; the lockfile records exact dependency provenance.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test
bun run build
bun run pack
```

The build produces `dist/cli.js`, the `dist/index.js` library, and declarations in `dist/types`. Browser assets are embedded in the build. `bun run pack` produces an installable tarball in `.artifacts/packages`; it does not publish to a registry. Package contents exclude local data, keys, tests, development caches, and proof artifacts.

Install that tarball into a separate consumer directory with `bun add /absolute/path/to/the.tgz`, then run its `node_modules/.bin/seeker --help` or `demo`. The CLI's Bun shebang requires the pinned Bun version on PATH. The package remains private to prevent accidental registry publication; local tarball installation works normally.

The focused tests exercise actual SQLite transactions, immutable revisions, event/choice deduplication, correction chronology, generation fencing, receiver progress, and recovery. Service-level checks use real commands and authenticated HTTP. Controlled host fixtures are labelled and establish only the core/local contract; a real host adapter needs its own native manager-origin and return-path proof.

Keep adapters thin: authenticate and normalize at their boundary, then use the shared core ports. Add coverage only for a distinct failure or protected behavior, preferably through the actual owner/caller path. Never put credentials, raw provider payloads, whole agent conversations, or local operational evidence in the public repository.
