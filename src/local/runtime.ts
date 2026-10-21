import type { HostAdapter, MessagingChannel } from "../contracts.ts";
import { DeliveryPump } from "../core/delivery.ts";
import { ThreadWatcher } from "../core/watch.ts";
import { LocalChannel } from "./channel.ts";
import { createLocalServer, type LocalServerOptions } from "./server.ts";

export interface RuntimeOptions extends LocalServerOptions {
  channels?: readonly MessagingChannel[];
  hosts?: readonly HostAdapter[];
}

/** One explicitly composed server, inbox and outbox pump; the caller owns its store and receivers. */
export function startRuntime(options: RuntimeOptions) {
  const channels = [new LocalChannel(), ...(options.channels ?? [])];
  const hosts = options.hosts ?? [];
  if (new Set(channels.map((item) => item.id)).size !== channels.length || new Set(hosts.map((item) => item.id)).size !== hosts.length) {
    throw new Error("Adapter identities must be unique.");
  }
  const server = createLocalServer(options);
  const pump = new DeliveryPump(options.core, channels, hosts);
  const watcher = new ThreadWatcher(options.core, hosts);
  try { pump.start(); watcher.start(); }
  catch (error) { watcher.stop(); void server.stop(true); throw error; }
  return {
    server, pump, watcher,
    async stop() { watcher.stop(); pump.stop(); await server.stop(true); },
  };
}
