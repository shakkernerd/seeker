import { openSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { claimReceiver } from "../../src/channels/telegram/receiver-lock";

const [directory, mode] = process.argv.slice(2);
if (!directory) throw new Error("Missing isolated directory");
let release: () => Promise<void>;
try {
  if (mode === "legacy") {
    const path = join(directory, "123456789.lock"), fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    release = async () => { closeSync(fd); unlinkSync(path); };
  } else { release = await claimReceiver("123456789", directory); }
  console.log("owned");
} catch { console.log("blocked"); process.exit(2); }
for await (const _ of console) { await release(); break; }
