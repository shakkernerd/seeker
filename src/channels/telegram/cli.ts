import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { SeekerCore } from "../../core/seeker";
import { SeekerError } from "../../core/validation";
import { defaultDataDir, ensureDataDir, runtimeVersion } from "../../local/config";
import { SqliteExchangeStore } from "../../store/sqlite";
import { TelegramApi } from "./api";
import { loadTelegramConfig, readTelegramToken, saveTelegramConfig } from "./config";
import { pairTelegram } from "./pairing";

const help = `Telegram — optional private messaging for Seeker

Usage:
  seeker telegram pair --token-file <path> [--data-dir <path>]
  seeker telegram status [--data-dir <path>]

Pairing runs in your terminal. Open the invitation in your intended Telegram
account, then enter the code that appears in that private chat. Only then is
the owner binding saved. Invitations expire after ten minutes and one use.

The token file must be a private regular file (mode 600), owned by your user.
Never pass a bot token as a command argument. Use a dedicated bot; stop any
existing Seeker receiver before pairing. Run seeker start after setup.
See docs/telegram.md for operation, limits, and recovery.
`;

export async function runTelegramCommand(args: string[]): Promise<void> {
  if (!args.length || args.includes("--help")) { console.log(help); return; }
  const [command, ...options] = args;
  if (command !== "pair" && command !== "status") throw new SeekerError("invalid_option", "Run seeker telegram --help for available commands.");
  let dataDir = defaultDataDir();
  let tokenFile: string | undefined;
  while (options.length) {
    const option = options.shift();
    const value = options.shift();
    if (!value || value.startsWith("--")) throw new SeekerError("invalid_option", "Each Telegram option needs a value. Run seeker telegram --help.");
    if (option === "--data-dir") dataDir = resolve(value);
    else if (option === "--token-file" && command === "pair") tokenFile = resolve(value);
    else throw new SeekerError("invalid_option", "Unknown Telegram option. Run seeker telegram --help.");
  }
  if (command === "status") {
    console.log(loadTelegramConfig(dataDir) ? "Telegram is paired with one fixed private owner. Connectivity is checked when Seeker starts." : "Telegram is not configured. The local channel is available.");
    return;
  }
  if (Bun.version !== runtimeVersion) throw new SeekerError("runtime_version", `Use qualified Bun ${runtimeVersion}.`);
  if (!tokenFile) throw new SeekerError("telegram_token", "Provide --token-file with a private token file. Never put the token in command arguments.");
  if (!process.stdin.isTTY) throw new SeekerError("telegram_pairing", "Pair Telegram from an interactive local terminal so you can deliberately confirm the account.");
  dataDir = ensureDataDir(dataDir);
  if (loadTelegramConfig(dataDir)) throw new SeekerError("telegram_paired", "Telegram is already paired. Use the existing pairing; see docs/telegram.md for recovery.");
  const api = new TelegramApi(readTelegramToken(tokenFile));
  const store = new SqliteExchangeStore(join(dataDir, "exchanges.sqlite"));
  const core = new SeekerCore(store);
  const signal = new AbortController();
  const cancel = () => signal.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  terminal.on("SIGINT", cancel);
  try {
    await pairTelegram(api, core.channel(`telegram:${api.botId}`), {
      invitation: (url) => console.log(`Open this invitation in your intended Telegram account (expires in ten minutes):\n${url}`),
      readCode: (abort) => terminal.question("Code shown in that Telegram chat: ", { signal: abort }),
      status: (message) => console.log(message),
    }, (recipient) => saveTelegramConfig(dataDir, recipient, tokenFile!), signal.signal);
    console.log("Telegram owner pairing saved. Run seeker start to receive replies; choose Telegram when binding a manager.");
  } catch {
    throw new SeekerError("telegram_pairing", signal.signal.aborted ? "Telegram pairing was cancelled." : "Telegram pairing did not complete. Check the token, dedicated-bot receiver ownership, invitation expiry, and private data directory; then retry.");
  } finally {
    terminal.close();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    store.close();
  }
}
