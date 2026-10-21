import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { EventOwner, EventPort } from "../events.ts";
import { prepareEventCapability } from "./event-client.ts";
import { defaultWatchEndings, eventArmRequest, eventOwner, eventRef, eventWatchRequest } from "./events.ts";
import type { ChannelIngress, ExchangeStore, ExchangeView, InboundReply, ManagerBinding, ManagerOrigin, ManagerPort, ReadOptions, Recipient, ThreadReader, ThreadState } from "../contracts.ts";
import { fail, id, origin as validateOrigin, sameRecipient } from "./validation.ts";

/** Trusted composition owns this object. Expose only a bound ManagerPort to agent tools. */
export class SeekerCore {
  /** `keyDirectory`: where Seeker places producer key files for waits armed without a path; without it a task must name the path. */
  /** Reads a task's latest turn through its host, so a watch knows where the task stood when armed; undefined when the host cannot say now. */
  threadReader?: (reader: ThreadReader, threadId: string, signal?: AbortSignal) => Promise<ThreadState | undefined>;

  constructor(readonly store: ExchangeStore, readonly clock: () => number = Date.now, private readonly options: { keyDirectory?: string } = {}) {
    if (options.keyDirectory) store.events.keyDirectory = options.keyDirectory;
  }

  bind(binding: ManagerBinding): void { this.store.bind(binding); }
  setRecipient(bindingId: string, expectedGeneration: number, recipient: Recipient): void {
    this.store.setRecipient(bindingId, expectedGeneration, recipient);
  }

  managerBinding(hostId: string, managerId: string): ManagerBinding | undefined {
    return this.store.findBinding(hostId, managerId);
  }

  resumeHost(hostId: string): number { const host = id(hostId, "Host"); return this.store.resumeRoute("host", host, this.clock()) + this.store.events.resumeHost(host, this.clock()); }
  resumeChannel(channelId: string): number { return this.store.resumeRoute("channel", id(channelId, "Channel"), this.clock()); }

  manager(input: ManagerOrigin): ManagerPort {
    const origin = Object.freeze(validateOrigin(input));
    this.store.binding(origin);
    const read = (requestId: string, options?: ReadOptions) => {
      const binding = this.store.binding(origin);
      const result = this.store.read(id(requestId, "Request"), binding.id, options);
      if (!result) fail("not_found", "Exchange not found.", 404);
      if (result.exchange.bindingId !== binding.id) fail("origin_denied", "This exchange belongs to another manager.", 403);
      return result;
    };
    return {
      submit: (input) => {
        this.store.execute(origin, { type: "submit", requestId: input.requestId, decision: input.decision }, this.clock());
        return read(input.requestId);
      },
      get: read,
      listPending: (options) => this.store.pending(this.store.binding(origin).id, options?.cursor),
      update: (command) => {
        this.store.execute(origin, command, this.clock());
        return read(command.requestId);
      },
    };
  }

  /** Trusted host composition supplies this identity; event access never grants ManagerPort. */
  events(input: EventOwner): EventPort {
    const origin = eventOwner(input);
    const binding = this.managerBinding(origin.hostId, origin.taskId);
    if (binding) { origin.bindingId = binding.id; origin.ownerGeneration = binding.origin.generation; }
    const current = () => {
      const live = this.managerBinding(origin.hostId, origin.taskId);
      if ((live?.id !== origin.bindingId) || (live?.origin.generation !== origin.ownerGeneration)) fail("owner_changed", "This event port's native assignment changed. Reconnect from the current owner.", 409);
    };
    const mutate = (ref: unknown, expectedVersion: number | undefined, command: Parameters<ExchangeStore["events"]["mutate"]>[3]) => { current(); return this.store.events.mutate(origin, eventRef(ref), expectedVersion, command, this.clock()); };
    return {
      arm: (raw) => {
        current();
        const request = eventArmRequest(raw, this.clock());
        // The producer key is created here, once: under Seeker's own key directory unless the task named a place. Only its digest enters the store.
        const waitId = request.waitId ?? `wait-${randomUUID()}`;
        let capabilityFile = request.capabilityFile;
        if (capabilityFile === undefined) {
          if (!this.options.keyDirectory) fail("capability_path_required", "This service has no key directory; give capabilityFile, an absolute path in a private directory.", 409);
          mkdirSync(this.options.keyDirectory, { recursive: true, mode: 0o700 });
          capabilityFile = join(this.options.keyDirectory, `${waitId}.json`);
        }
        let grant;
        // A task-chosen path without a chosen id recovers whatever wait that file already names.
        try { grant = prepareEventCapability(capabilityFile, { revision: request.revision ?? "unversioned", ...(request.waitId !== undefined || request.capabilityFile === undefined ? { waitId } : {}) }); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") fail("capability_directory_missing", "The directory for the producer key file does not exist; create it, or omit capabilityFile and let Seeker place the key.", 409);
          if (code === "EACCES" || code === "EPERM" || code === "EROFS") fail("capability_unwritable", "The producer key file path is not writable by the service.", 409);
          throw error;
        }
        const { capabilityDigest, created, ...address } = grant;
        const arm = { ...address, title: request.title, expiresAt: request.expiresAt, capabilityDigest, ...(request.capabilityFile === undefined ? { keyFile: `${waitId}.json` } : {}) };
        try { return { ...this.store.events.arm(origin, arm, this.clock()), capabilityFile }; }
        catch (error) {
          // A key written for a wait the store refused is removed; a key that already belonged to a wait stays.
          if (created && request.capabilityFile === undefined) { try { unlinkSync(capabilityFile); } catch { /* already gone */ } }
          throw error;
        }
      },
      watch: async (raw, signal) => {
        current();
        const request = eventWatchRequest(raw, this.clock());
        if (request.threadId === origin.taskId) fail("invalid_input", "A task cannot watch itself.");
        // Where the task stands now: a turn already ended is old news, one running is reported when it ends.
        let seen: { turnId: string; status: ThreadState["status"] } | undefined;
        if (this.threadReader) {
          const state = await this.threadReader({ hostId: origin.hostId, taskId: origin.taskId, turnId: origin.turnId }, request.threadId, signal);
          if (state?.taskId === request.threadId) seen = { turnId: state.turnId, status: state.status };
        }
        // The caller must still be there to receive the watch's identity; an ended request arms nothing.
        if (signal?.aborted) fail("request_ended", "The request ended before the watch was armed. Arm it again.", 499);
        current();
        return this.store.events.watch(origin, { waitId: request.waitId ?? `watch-${randomUUID()}`, generation: randomUUID(), revision: "watch", title: request.title, expiresAt: request.expiresAt, threadId: request.threadId, on: request.on ?? [...defaultWatchEndings], ...(seen ? { seen } : {}) }, this.clock());
      },
      get: (ref) => { current(); return this.store.events.get(origin, eventRef(ref), this.clock()); },
      pending: () => { current(); return this.store.events.pending(origin, this.clock()).map(({ waitId, generation, revision, title, expiresAt, version, state, updatedAt, reason, receipt, watch, delivery }) => ({ waitId, generation, revision, title, expiresAt, version, state, updatedAt, ...(reason ? { reason } : {}), ...(receipt ? { receiptId: receipt.id } : {}), ...(watch ? { watch } : {}), ...(delivery ? { delivery: { state: delivery.state, ...(delivery.code ? { code: delivery.code } : {}) } } : {}) })); },
      cancel: (ref, options) => mutate(ref, options?.expectedVersion, { type: "cancel" }),
      acknowledge: (ref, status, options) => mutate(ref, options?.expectedVersion, { type: "acknowledge", status, ...(options?.receiptId !== undefined ? { receiptId: options.receiptId } : {}) }),
      clear: (ref, options) => mutate(ref, options?.expectedVersion, { type: "clear" }),
    };
  }

  channel(channelId: string): ChannelIngress {
    id(channelId, "Channel");
    if (channelId.startsWith("native:")) fail("origin_denied", "Native sources use the trusted host adapter port.", 403);
    return {
      receive: (events, progress) => this.store.ingest(channelId, events, progress, this.clock()),
      progress: () => this.store.progress(channelId),
      pending: (recipient) => {
        if (recipient.channelId !== channelId) fail("recipient_denied", "Wrong channel for this recipient.", 403);
        return this.store.list({ recipient, pendingOnly: true });
      },
      resolveMessage: (conversationId, reference) => this.store.resolveMessage(channelId, conversationId, reference),
    };
  }

  /** Only a host-verified original human message may reach this separate ingress. */
  receiveNative(origin: ManagerOrigin, requestId: string, revision: number, reply: InboundReply) {
    return this.store.ingestNative(origin, requestId, revision, reply, this.clock());
  }

  inbox(recipient: Recipient): ExchangeView[] { return this.store.list({ recipient }); }
  history(recipient: Recipient, cursor?: string) { return this.store.history(recipient, cursor); }
  forRecipient(requestId: string, recipient: Recipient): ExchangeView {
    const view = this.store.get(id(requestId, "Request"));
    if (!view || !sameRecipient(view.exchange.recipient, recipient)) fail("not_found", "Exchange not found.", 404);
    return view;
  }
}
