import type { SeekerCore } from "../../core/seeker";
import { SeekerError } from "../../core/validation";
import { TelegramApi, TelegramError } from "./api";
import { TelegramChannel } from "./channel";
import { loadTelegramConfig, readTelegramToken } from "./config";

/** Optional concrete adapter composition. Missing configuration performs no network I/O. */
export function loadTelegram(core: SeekerCore, dataDir: string, report: (message: string) => void) {
  const config = loadTelegramConfig(dataDir);
  if (!config) return;
  const api = new TelegramApi(readTelegramToken(config.tokenFile));
  if (api.botId !== config.botId) throw new SeekerError("telegram_identity", "The Telegram token belongs to a different bot than the saved pairing.");
  const channel = new TelegramChannel(api, config, { report });
  const controller = new AbortController();
  let task: Promise<void> | undefined;
  return {
    channel,
    async startReceiver(): Promise<void> {
      if (task) throw new SeekerError("telegram_receiver", "The Telegram receiver has already been started.");
      let ready = false;
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const started = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      task = channel.run(core.channel(channel.id), controller.signal, () => { ready = true; resolveReady(); });
      void task.then(() => {
        if (!ready) rejectReady(new SeekerError("telegram_receiver", "Telegram startup was cancelled."));
      }, (error: unknown) => {
        const message = error instanceof TelegramError ? error.message : "Telegram receiver stopped. Check dedicated-bot ownership, webhook settings, and the private data directory.";
        if (!ready) rejectReady(new SeekerError("telegram_receiver", message));
        else report(message);
      });
      await started;
    },
    async stopReceiver(): Promise<void> {
      controller.abort();
      await task?.catch(() => {});
    },
  };
}
