import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { runtimeVersion } from "../src/local/config.ts";

if (Bun.version !== runtimeVersion) throw new Error(`Build with qualified Bun ${runtimeVersion}.`);

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
const result = await Bun.build({ entrypoints: ["src/cli.ts", "src/index.ts"], outdir: "dist", target: "bun", packages: "external" });
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
chmodSync("dist/cli.js", 0o755);
const native = await Bun.build({ entrypoints: ["src/hosts/codex/connector.ts"], outdir: "dist", naming: "codex-connector.mjs", target: "node", format: "esm", packages: "external" });
if (!native.success) {
  for (const log of native.logs) console.error(log);
  process.exit(1);
}
chmodSync("bin/seeker-codex", 0o755);
const types = Bun.spawn([process.execPath, "node_modules/typescript/bin/tsc", "--project", "tsconfig.build.json"], { stdout: "inherit", stderr: "inherit" });
if (await types.exited !== 0) process.exit(1);
console.log("Built CLI, native connector, module exports, and type declarations in dist/.");
