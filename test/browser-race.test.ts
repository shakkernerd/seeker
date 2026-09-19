import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("a late confirmed send preserves a newer draft and a newer in-flight response", async () => {
  type Listener = (event: { preventDefault(): void }) => unknown;
  const elements = new Map<string, ReturnType<typeof element>>();
  function element() {
    return {
      value: "", textContent: "", hidden: false, disabled: false, readOnly: false, children: [],
      handlers: new Map<string, Listener>(), classList: { toggle() {} }, setAttribute() {},
      addEventListener(name: string, listener: Listener) { this.handlers.set(name, listener); },
    };
  }
  const replies: ((response: Response) => void)[] = [];
  const context: Record<string, unknown> = {
    document: {
      // Layout and browser polling are covered by the real-browser scenario. This
      // harness drives refresh's receipt reconciliation and the actual form handler.
      hidden: true, addEventListener() {}, createElement: element,
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id)!;
      },
    },
    window: { addEventListener() {} }, AbortController, crypto, expect,
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; },
    fetch(path: string) {
      // Leave automatic session bootstrap pending; the test supplies one local view.
      return new Promise<Response>((resolve) => { if (path === "/api/replies") replies.push(resolve); });
    },
    finishReply(index: number, status = 200) {
      expect(replies[index]).toBeDefined();
      const result = status === 200 ? { status: "recorded", receiptId: `receipt-${index}` }
        : { error: { code: "stale_revision", message: "Read the current question before answering." } };
      replies[index]!(new Response(JSON.stringify(result), {
        status, headers: { "Content-Type": "application/json" },
      }));
    },
  };
  const source = readFileSync(new URL("../src/local/web/app.js", import.meta.url), "utf8");
  runInNewContext(`${source}
    globalThis.completed = (async () => {
      const view = { exchange: { id: "race", revision: 1, state: "waiting", receipts: [], context: [],
        revisions: [{ number: 1, replyHandle: "r_race", decision: { options: [] } }] }, deliveries: [] };
      session = { csrf: "test-session" }; selectedId = view.exchange.id; views.set(selectedId, view);
      const draft = draftFor(view);
      const enter = (text) => {
        $("reply").value = text;
        $("reply").handlers.get("input")({ preventDefault() {} });
      };
      const send = () => $("reply-form").handlers.get("submit")({ preventDefault() {} });
      const confirmFromPoll = () => {
        view.exchange.receipts.push({ source: { eventId: draft.attempt.eventId } });
        reconcileAttempt(view); renderComposer(view);
        expect(draft.attempt).toBeUndefined();
        expect($("reply").readOnly).toBe(false);
      };

      enter("First response");
      const first = send();
      confirmFromPoll();
      enter("Important unsent second response");
      finishReply(0); await first;
      expect(draft.text).toBe("Important unsent second response");
      expect($("reply").value).toBe(draft.text);

      const second = send();
      confirmFromPoll();
      enter("Third response");
      const third = send(), thirdAttempt = draft.attempt;
      finishReply(1); await second;
      expect(draft.text).toBe("Third response");
      expect(draft.attempt).toBe(thirdAttempt);
      expect(draft.sending).toBe(true);
      expect($("send").disabled).toBe(true);
      expect($("reply").readOnly).toBe(true);

      finishReply(2); await third;
      expect(draft.text).toBe("");
      expect(draft.attempt).toBeUndefined();
      expect(draft.sending).toBe(false);

      enter("Retain this reply after a rejected send");
      const rejected = send();
      finishReply(3, 409); await rejected;
      expect(draft.text).toBe("Retain this reply after a rejected send");
      expect(draft.attempt).toBeUndefined();
      expect(draft.sending).toBe(false);
      expect($("send").disabled).toBe(false);
      expect($("reply").readOnly).toBe(false);
    })();
  `, context);
  await context.completed;
});
