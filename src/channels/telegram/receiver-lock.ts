import { mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Cross-process ownership on this host. A crash requires explicit stale-lock recovery. */
export async function claimReceiver(botId: string, directory = join(homedir(), ".seeker", "telegram-receivers")): Promise<() => Promise<void>> {
  if (!/^[1-9]\d{0,15}$/.test(botId)) throw new Error("Invalid Telegram bot identity");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${botId}.lock`);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch {
    throw new Error("Cannot claim Telegram receiver. Another receiver or stale lock exists; see Telegram setup recovery.");
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
  } catch {
    await handle.close();
    await unlink(path);
    throw new Error("Cannot record Telegram receiver ownership");
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close();
    await unlink(path);
  };
}
