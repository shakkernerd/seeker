const $ = (id) => document.getElementById(id);
const views = new Map();
const drafts = new Map();
const rows = new Map();
let session, selectedId, refreshing = false, detailKey = "", materialKey = "";
let recentViews = [], olderViews = [], historyCursor, nextHistoryCursor;
let historyStarted = false, historyEnded = false, historyBusy = false, historyRequested = false, historyGeneration = 0, selectedLoad;
const kindNames = { approve: "Approval", decline: "Declined", answer: "Reply", question: "Question", acknowledge: "Acknowledged", correction: "Correction", stop: "Stop request" };

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function notice(id, text = "", error = false) {
  $(id).textContent = text;
  $(id).hidden = !text;
  $(id).classList.toggle("error", error);
}
function connection(text, state = "") { if ($("connection").textContent !== text) $("connection").textContent = text; $("connection").className = `connection ${state}`; }
function currentRevision(view) { return view.exchange.revisions.find((item) => item.number === view.exchange.revision); }
function draftFor(view) {
  if (!drafts.has(view.exchange.id)) drafts.set(view.exchange.id, { text: "", conditions: "", kind: "answer", revision: view.exchange.revision, replyHandle: currentRevision(view).replyHandle });
  return drafts.get(view.exchange.id);
}
function time(value) { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function pendingDeferred(view) { return (view.deferredReplies || []).some((item) => item.disposition.status === "pending"); }
function deferredStatus(item) { return item.disposition.status === "handled" ? "Manager reconciled saved input" : "Saved for manager review · no decision applied"; }
function receiptStatus(receipt, view) {
  if (receipt.disposition.status === "handled") return "Response recorded · Manager handled";
  if (receipt.disposition.status === "received") return "Response recorded · Manager received";
  if (receipt.disposition.status === "unknown") return "Response recorded · Manager outcome unconfirmed";
  const delivery = view.deliveries.findLast((item) => item.lane === "host" && item.receiptId === receipt.id && item.state !== "retired" && item.ownerGeneration === view.exchange.origin.generation);
  if (delivery?.state === "accepted") return "Response recorded · Host accepted; waiting for the manager to confirm receipt";
  if (delivery?.state === "unknown") return "Response recorded · Delivery unconfirmed; awaiting reconciliation";
  if (delivery?.state === "rejected") return "Response recorded · Delivery needs attention; manager receipt unconfirmed";
  return "Response recorded · Waiting for manager";
}
function status(view) {
  const exchange = view.exchange;
  if (pendingDeferred(view)) return "Saved input needs review";
  if (exchange.state === "cancelled") return "Cancelled";
  if (exchange.state === "handled") return "Manager handled";
  if (exchange.state === "reconcile") return "Follow-up needs review";
  if (exchange.state === "waiting") return "Needs your response";
  const receipt = [...exchange.receipts].reverse().find((item) => item.revision === exchange.revision);
  return receipt?.disposition.status === "received" ? "Manager received" : "Response recorded";
}
async function api(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { "Accept": "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(session ? { "x-seeker-csrf": session.csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let value;
    try { value = await response.json(); }
    catch {
      if (!response.ok) throw Object.assign(new Error(response.status === 413 ? "The request is too large for the local service. Your text is kept; shorten it before sending." : "Seeker could not complete this request. Your draft is kept."), { status: response.status });
      throw new Error("The local service returned an unreadable response.");
    }
    if (!response.ok) throw Object.assign(new Error(value.error?.message || "The request could not be completed."), { status: response.status, code: value.error?.code });
    return value;
  } finally { clearTimeout(timeout); }
}
function showLogin(message = "") {
  session = undefined;
  $("login").hidden = false; $("workspace").hidden = true; $("logout").hidden = true; $("fixture").hidden = true; $("offline").hidden = true;
  connection("Locked"); notice("login-error", message, Boolean(message));
}
async function openSession(value) {
  session = value;
  if (!views.size) emptyMessage("Loading your inbox…", "Seeker is checking for your requests.", "…");
  $("login").hidden = true; $("workspace").hidden = false; $("logout").hidden = false; $("fixture").hidden = value.mode !== "fixture";
  await refresh();
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("unlock").disabled = true; notice("login-error");
  const token = $("access-key").value;
  try { await openSession(await api("/api/session", { token })); }
  catch (error) { notice("login-error", error.status ? error.message : "Cannot reach Seeker. Check that the local service is running, then try again.", true); }
  finally { $("access-key").value = ""; $("unlock").disabled = false; }
});
$("logout").addEventListener("click", async () => {
  $("logout").disabled = true;
  try { await api("/api/logout", {}); drafts.clear(); views.clear(); rows.clear(); recentViews = []; resetHistory(); selectedLoad = undefined; $("request-list").replaceChildren(); selectedId = undefined; detailKey = materialKey = ""; showLogin(); }
  catch { connection("Could not lock · retry", "offline"); }
  finally { $("logout").disabled = false; }
});
function renderList() {
  const listed = new Map([...olderViews, ...recentViews].map((view) => [view.exchange.id, views.get(view.exchange.id) || view]));
  const items = [...listed.values()].sort((a, b) => b.exchange.createdAt - a.exchange.createdAt || a.exchange.id.localeCompare(b.exchange.id));
  $("count").textContent = String(items.length); $("inbox-empty").hidden = items.length > 0;
  for (const [id, row] of rows) if (!listed.has(id)) { row.remove(); rows.delete(id); }
  items.forEach((view, index) => {
    const exchange = view.exchange;
    let row = rows.get(exchange.id);
    if (!row) { row = node("button", "request-item"); row.type = "button"; row.addEventListener("click", () => select(exchange.id)); rows.set(exchange.id, row); }
    const signature = JSON.stringify([exchange.managerLabel, currentRevision(view).decision, status(view)]);
    if (row.dataset.signature !== signature) {
      const top = node("span", "item-top"); top.append(node("span", "item-manager", exchange.managerLabel), node("span", "", new Date(exchange.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })));
      row.replaceChildren(top, node("strong", "", currentRevision(view).decision.title), node("span", "item-preview", currentRevision(view).decision.question), node("span", "item-state", status(view)));
      row.dataset.signature = signature;
    }
    row.setAttribute("aria-current", String(exchange.id === selectedId));
    if ($("request-list").children[index] !== row) $("request-list").insertBefore(row, $("request-list").children[index] || null);
  });
}
function decisionDetails(decision) {
  return ["target", "effect", "scope", "conditions"].map((key) => {
    const field = node("div"); field.append(node("dt", "", key[0].toUpperCase() + key.slice(1)), node("dd", "", decision[key] || "None specified")); return field;
  });
}
function renderRequest(view) {
  const revision = currentRevision(view), decision = revision.decision;
  $("request-kind").textContent = { decision: "Decision requested", information: "Information requested", attention: "For your attention" }[decision.kind];
  $("revision").textContent = `Revision ${revision.number}`;
  $("question").textContent = decision.question; $("context").textContent = decision.context; $("context").hidden = !decision.context;
  $("decision-details").replaceChildren(...decisionDetails(decision));
  $("recommendation").textContent = decision.recommendation ? `Suggested approach: ${decision.recommendation}` : ""; $("recommendation").hidden = !decision.recommendation;
  $("options").replaceChildren(...decision.options.map((option) => {
    const button = node("button", "choice"); button.type = "button"; button.dataset.option = option.id;
    button.append(node("small", "", { approve: "Approve", decline: "Decline", answer: "Answer" }[option.kind]), node("strong", "", option.label), node("span", "", option.meaning));
    button.addEventListener("click", () => { const draft = draftFor(view); draft.optionId = option.id; draft.kind = option.kind; draft.notice = ""; renderComposer(view); $("reply").focus(); });
    return button;
  }));
  $("history").replaceChildren(...view.exchange.revisions.filter((item) => item.number !== revision.number).map((item) => {
    const history = node("details"), details = node("dl", "decision-details"), options = node("ul"); details.append(...decisionDetails(item.decision));
    for (const option of item.decision.options) options.append(node("li", "", `${option.label} (${kindNames[option.kind]}): ${option.meaning}`));
    history.append(node("summary", "", `Earlier request · Revision ${item.number}`), node("h3", "", item.decision.title), node("p", "", item.decision.question), node("p", "", item.decision.context), details, options);
    if (item.decision.recommendation) history.append(node("p", "recommendation", `Suggested approach: ${item.decision.recommendation}`));
    return history;
  }));
}
function renderMessages(view) {
  const exchange = view.exchange;
  const events = [
    ...exchange.context.map((message) => ({ at: message.createdAt, sequence: message.sequence, message })),
    ...exchange.receipts.map((receipt) => ({ at: receipt.source.recordedAt, sequence: receipt.sequence, receipt })),
    ...(view.deferredReplies || []).map((deferred) => ({ at: deferred.recordedAt, deferred })),
  ].sort((a, b) => a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence || a.at - b.at : a.at - b.at);
  $("messages").replaceChildren(...events.map(({ at, message, receipt, deferred }) => {
    const input = receipt || deferred?.event || message;
    const revision = deferred?.revision ?? input.revision;
    const item = node("li", `message${receipt || deferred ? " reply" : ""}${deferred || receipt?.classification === "correction" || receipt?.kind === "stop" ? " correction" : ""}${deferred ? " saved-input" : ""}`);
    const heading = node("div", "message-heading");
    const label = deferred ? `You · Saved input · ${kindNames[input.kind]}` : receipt ? `You · ${kindNames[receipt.kind]}${receipt.classification === "correction" && !["stop", "correction"].includes(receipt.kind) ? " · Later change" : ""}` : exchange.managerLabel;
    heading.append(node("span", "", `${label} · Revision ${revision}`), node("time", "", time(at)));
    item.append(heading);
    if (input.text) item.append(node("p", "", input.text));
    if (deferred?.event.optionId) {
      const option = exchange.revisions.find((entry) => entry.number === revision)?.decision.options.find((entry) => entry.id === deferred.event.optionId);
      item.append(node("p", "", `Requested choice: ${option ? `${option.label} — ${option.meaning}` : deferred.event.optionId}`));
    }
    if (input.conditions) item.append(node("p", "message-conditions", `Conditions: ${input.conditions}`));
    if (receipt) item.append(node("p", "message-status", receiptStatus(receipt, view) + (receipt.disposition.note ? ` · ${receipt.disposition.note}` : "")));
    if (deferred) item.append(node("p", "message-status", deferredStatus(deferred) + (deferred.disposition.note ? ` · ${deferred.disposition.note}` : "")));
    return item;
  }));
}
function renderComposer(view) {
  const draft = draftFor(view), stale = draft.revision !== view.exchange.revision;
  const option = view.exchange.revisions.find((item) => item.number === draft.revision)?.decision.options.find((item) => item.id === draft.optionId);
  const late = ["stop", "correction"].includes(draft.kind), locked = Boolean(draft.attempt), closed = view.exchange.state === "cancelled";
  if ($("reply").value !== draft.text) $("reply").value = draft.text;
  if ($("conditions").value !== draft.conditions) $("conditions").value = draft.conditions;
  $("reply").readOnly = locked; $("conditions").readOnly = locked; $("reply-kind").disabled = locked;
  const limitErrors = [];
  for (const [id, text, max, label] of [["reply", draft.text, 8000, "Your reply"], ["conditions", draft.conditions, 2000, "Your conditions"]]) {
    const over = text.length > max;
    $(id).setAttribute("aria-invalid", String(over));
    $(`${id}-limit`).textContent = `${text.length.toLocaleString()} / ${max.toLocaleString()} characters`;
    $(`${id}-limit`).classList.toggle("over-limit", over);
    if (over) limitErrors.push(`${label}: keep the text within ${max.toLocaleString()} characters. Nothing has been removed.`);
  }
  $("selected-choice").hidden = !option; $("selected-choice").textContent = option ? `Decision: ${option.label}` : "Selected decision";
  $("reply-kind").value = option ? "choice" : draft.kind;
  $("choice-note").hidden = !option; $("choice-note").textContent = option ? `${kindNames[option.kind]} selected: ${option.meaning}` : "";
  $("revised").hidden = !stale;
  $("revision-message").textContent = `This request is now at revision ${view.exchange.revision}. Your draft for revision ${draft.revision} is kept. Review the current details before sending a choice. A correction or stop request can still refer to the earlier revision.`;
  $("use-current").disabled = locked; $("use-current").textContent = `Reply to revision ${view.exchange.revision}`;
  for (const button of $("options").children) { button.disabled = locked || stale || closed; button.setAttribute("aria-pressed", String(!stale && button.dataset.option === draft.optionId)); }
  $("compose-hint").textContent = draft.kind === "stop" ? "This asks the manager to stop. It does not confirm that work has stopped." : option ? `Your ${option.kind === "approve" ? "approval" : option.kind === "decline" ? "decline" : "answer"} and any conditions apply to revision ${draft.revision}.` : closed ? "This request was cancelled. You can still send a correction or stop request." : currentRevision(view).decision.options.length ? "A written reply is not an approval. Choose a decision above to approve or decline." : "Your response and any conditions stay with this request.";
  $("send").textContent = draft.sending ? "Sending…" : draft.attempt ? "Retry same response" : "Send response ↑";
  $("send").disabled = Boolean(draft.sending) || (!draft.attempt && (limitErrors.length > 0 || (!draft.text.trim() && !option) || ((stale || closed) && !late)));
  notice("reply-notice", limitErrors.join(" ") || draft.notice || "", limitErrors.length > 0 || Boolean(draft.error));
}
function renderDetail(force = false) {
  const view = views.get(selectedId); $("empty").hidden = Boolean(view); $("exchange").hidden = !view;
  if (!view) {
    if (selectedLoad?.status === "loading" && selectedLoad.id === selectedId) emptyMessage("Loading this request…", "Opening its saved conversation.", "…");
    else if (selectedLoad?.status === "offline" && selectedLoad.id === selectedId) emptyMessage("This request is temporarily unavailable.", "Keep this tab open. Seeker will try again when the local service is available.", "…");
    else emptyMessage(selectedId ? "This request is not available." : "Nothing needs your attention.", selectedId ? "Check the request link, or choose a request from your inbox." : "When your manager asks something, it will appear here. You can leave this inbox open.", selectedId ? "?" : "✓");
    return;
  }
  $("history-origin").hidden = recentViews.some((item) => item.exchange.id === selectedId);
  const key = JSON.stringify(view); if (!force && key === detailKey) return; detailKey = key;
  $("manager").textContent = `FROM ${view.exchange.managerLabel}`;
  $("title").textContent = currentRevision(view).decision.title;
  $("state").textContent = status(view); $("state").classList.toggle("attention", pendingDeferred(view) || ["waiting", "reconcile"].includes(view.exchange.state));
  const latest = [...view.exchange.receipts].reverse().find((item) => item.revision === view.exchange.revision || (item.classification === "correction" && item.disposition.status !== "handled"));
  const pending = (view.deferredReplies || []).find((item) => item.disposition.status === "pending");
  const latestSaved = [...(view.deferredReplies || [])].sort((a, b) => b.recordedAt - a.recordedAt)[0];
  $("receipt-status").textContent = pending ? deferredStatus(pending) : latestSaved && (!latest || latestSaved.recordedAt >= latest.source.recordedAt) ? deferredStatus(latestSaved) : latest ? receiptStatus(latest, view) : "Available locally · Your response will stay with this request.";
  const newMaterialKey = JSON.stringify([view.exchange.id, view.exchange.revisions]);
  const focusedChoiceChanged = newMaterialKey !== materialKey && $("options").contains(document.activeElement);
  if (newMaterialKey !== materialKey) { materialKey = newMaterialKey; renderRequest(view); }
  renderMessages(view); renderComposer(view);
  if (focusedChoiceChanged && !$("revised").hidden && !$("use-current").disabled) $("use-current").focus();
  notice("cancellation", view.exchange.cancellation ? `Manager cancelled this request: ${view.exchange.cancellation.reason}` : "");
}
function select(id, updateHash = true) {
  if (!id) id = recentViews.find((view) => pendingDeferred(view) || ["waiting", "reconcile"].includes(view.exchange.state))?.exchange.id || recentViews[0]?.exchange.id;
  if (selectedId !== id) { selectedId = id; selectedLoad = undefined; detailKey = ""; materialKey = ""; }
  if (updateHash && id) history.replaceState(null, "", `#exchange=${encodeURIComponent(id)}`);
  rebuildViews();
  if (id && !views.has(id)) selectedLoad = { id, status: "loading" };
  renderList(); renderDetail(true);
  if (id && !recentViews.some((item) => item.exchange.id === id)) refresh();
}
function emptyMessage(title, copy, mark) { $("empty-title").textContent = title; $("empty-copy").textContent = copy; $("empty-mark").textContent = mark; }
function hashId() { try { return new URLSearchParams(location.hash.slice(1)).get("exchange"); } catch { return null; } }
function hasDraft(draft) { return draft.attempt || draft.text.trim() || draft.conditions.trim() || draft.optionId; }
function rebuildViews() {
  // Keep one older page and the open record; discard other browsed history.
  const opened = views.get(selectedId);
  views.clear();
  for (const view of [...olderViews, ...recentViews]) views.set(view.exchange.id, view);
  if (opened && !views.has(selectedId)) views.set(selectedId, opened);
  for (const [id, draft] of drafts) if (!views.has(id) && !hasDraft(draft)) drafts.delete(id);
}
function historyControls() {
  $("older-history").disabled = historyBusy || historyEnded;
  $("older-history").textContent = historyBusy ? "Loading…" : "Older history";
  $("recent-only").disabled = historyBusy || !historyStarted;
}
function resetHistory() {
  historyGeneration++;
  olderViews = []; historyCursor = nextHistoryCursor = undefined;
  historyStarted = historyEnded = historyBusy = historyRequested = false;
  notice("history-note"); historyControls();
}
function historySummary() {
  notice("history-note", olderViews.length ? historyEnded ? "Showing the oldest saved requests." : "Showing one page of older requests." : historyStarted ? "No older requests." : "");
}
$("older-history").addEventListener("click", () => {
  if (!session || historyBusy || historyEnded) return;
  historyBusy = historyRequested = true;
  notice("history-note", "Opening older requests…"); historyControls(); refresh();
});
$("recent-only").addEventListener("click", () => {
  resetHistory(); rebuildViews(); renderList(); renderDetail(); $("older-history").focus();
});
function recorded(draft, deferred = false) {
  Object.assign(draft, { text: "", conditions: "", kind: "answer", optionId: undefined, attempt: undefined, sending: false, error: false, notice: deferred ? "Your input is saved for reconciliation. No decision was applied by this submission." : "Your response is recorded. Its manager status appears in the conversation." });
}
function reconcileAttempt(view) {
  const draft = drafts.get(view.exchange.id);
  if (!draft?.attempt) return;
  if (view.exchange.receipts.some((item) => item.source.eventId === draft.attempt.eventId)) recorded(draft);
  else if ((view.deferredReplies || []).some((item) => item.event.eventId === draft.attempt.eventId)) recorded(draft, true);
}
async function refresh() {
  if (!session || refreshing || document.hidden) return;
  refreshing = true; const owner = session, browseOlder = historyRequested, browsingGeneration = historyGeneration;
  historyRequested = false;
  let checkedSelection = selectedId;
  try {
    const result = await api("/api/exchanges"); if (session !== owner) return;
    recentViews = result;
    if (!selectedId) selectedId = hashId() || result.find((view) => pendingDeferred(view) || ["waiting", "reconcile"].includes(view.exchange.state))?.exchange.id || result[0]?.exchange.id;
    checkedSelection = selectedId;
    if (browseOlder) {
      const cursor = historyStarted ? nextHistoryCursor : (await api("/api/history")).nextCursor;
      if (session !== owner) return;
      if (cursor) {
        const page = await api(`/api/history?cursor=${encodeURIComponent(cursor)}`); if (session !== owner) return;
        if (historyGeneration === browsingGeneration) {
          historyStarted = true; historyCursor = cursor; olderViews = page.items; nextHistoryCursor = page.nextCursor; historyEnded = !page.nextCursor;
        }
      } else if (historyGeneration === browsingGeneration) { historyStarted = true; historyEnded = true; }
      if (historyGeneration === browsingGeneration) historySummary();
    } else if (historyCursor) {
      const page = await api(`/api/history?cursor=${encodeURIComponent(historyCursor)}`); if (session !== owner) return;
      if (historyGeneration === browsingGeneration) { olderViews = page.items; nextHistoryCursor = page.nextCursor; historyEnded = !page.nextCursor; historySummary(); }
    }
    rebuildViews();
    const target = selectedId;
    checkedSelection = target;
    if (target && ![...recentViews, ...olderViews].some((item) => item.exchange.id === target) && !(selectedLoad?.status === "missing" && selectedLoad.id === target)) {
      selectedLoad = { id: target, status: "loading" }; if (!views.has(target)) renderDetail();
      try {
        const view = await api(`/api/exchanges/${encodeURIComponent(target)}`); if (session !== owner) return;
        if (selectedId === target) { views.set(target, view); selectedLoad = undefined; }
      } catch (error) {
        if (session !== owner) return;
        if (error.status === 401) throw error;
        if (selectedId === target) {
          if ([400, 403, 404].includes(error.status)) { views.delete(target); selectedLoad = { id: target, status: "missing" }; }
          else { selectedLoad = { id: target, status: "offline" }; throw error; }
        }
      }
    }
    for (const view of views.values()) reconcileAttempt(view);
    connection("Connected", "online"); $("offline").hidden = true;
    renderList(); renderDetail();
  } catch (error) {
    if (session !== owner) return;
    if (error.status === 401) showLogin("Your session ended. Unlock the inbox to continue; drafts in this tab are kept.");
    else {
      connection("Offline · reconnecting", "offline"); $("offline").hidden = false;
      $("offline").textContent = views.size ? "Connection lost. Showing the last loaded requests while Seeker reconnects. Your drafts stay in this tab." : "Seeker is reconnecting to your inbox. Your drafts stay in this tab.";
      if (selectedLoad?.status === "offline" && selectedLoad.id === selectedId) renderDetail();
      else if (!views.size) emptyMessage("Your inbox is temporarily unavailable.", "Keep this tab open. Seeker will reconnect automatically when the local service is available.", "…");
      if (browseOlder) notice("history-note", "Older history is temporarily unavailable. Try again.", true);
    }
  }
  finally {
    refreshing = false; if (browseOlder) historyBusy = false; historyControls();
    if (session && (session !== owner || historyRequested || selectedId !== checkedSelection)) refresh();
  }
}
for (const id of ["reply", "conditions"]) $(id).addEventListener("input", () => { const view = views.get(selectedId); if (!view) return; const draft = draftFor(view); draft[id === "reply" ? "text" : "conditions"] = $(id).value; draft.notice = ""; renderComposer(view); });
$("reply-kind").addEventListener("change", () => { const view = views.get(selectedId); if (!view) return; const draft = draftFor(view); if ($("reply-kind").value !== "choice") { draft.kind = $("reply-kind").value; draft.optionId = undefined; } draft.notice = ""; renderComposer(view); });
$("use-current").addEventListener("click", () => { const view = views.get(selectedId), draft = draftFor(view); Object.assign(draft, { revision: view.exchange.revision, replyHandle: currentRevision(view).replyHandle, kind: "answer", optionId: undefined, notice: "Draft kept. Choose a response for the current request.", error: false }); renderComposer(view); $("question").scrollIntoView({ block: "center", behavior: "auto" }); });
$("reply-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const view = views.get(selectedId), draft = draftFor(view); if ($("send").disabled) return;
  const attempt = draft.attempt || { eventId: crypto.randomUUID(), replyHandle: draft.replyHandle, kind: draft.kind, text: draft.text, ...(draft.conditions.trim() ? { conditions: draft.conditions } : {}), ...(draft.optionId ? { optionId: draft.optionId } : {}) };
  draft.attempt = attempt; draft.sending = true; draft.notice = ""; renderComposer(view);
  try {
    const result = await api("/api/replies", attempt);
    if (result.status === "deferred") recorded(draft, true);
    else if (result.status === "recorded" || (result.status === "duplicate" && result.receiptId)) recorded(draft);
    else { draft.attempt = undefined; draft.error = true; draft.notice = result.code?.includes("stale") ? "This request changed. Your draft is kept; review the current revision before sending." : "This response was not recorded. Your draft is kept; refresh and review the request."; }
  } catch (error) {
    if (draft.attempt !== attempt) return;
    draft.error = true;
    if (error.status && error.status < 500) { draft.attempt = undefined; draft.notice = error.status === 409 ? "This request changed. Your draft is kept; review the current revision before sending." : error.message; if (error.status === 401) showLogin("Unlock the inbox again to send your retained draft."); }
    else draft.notice = "The result of this send is unconfirmed. Keep this tab open. Retry sends this exact same response safely.";
  } finally { draft.sending = false; if (selectedId === view.exchange.id) renderComposer(views.get(selectedId) || view); await refresh(); }
});
window.addEventListener("hashchange", () => select(hashId(), false));
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
window.addEventListener("online", refresh);
window.addEventListener("beforeunload", (event) => {
  if ([...drafts.values()].some(hasDraft)) { event.preventDefault(); event.returnValue = ""; }
});
setInterval(refresh, 2000);
api("/api/session").then(openSession).catch((error) => showLogin(error.status === 401 ? "" : "Cannot reach Seeker. Check that the local service is running, then try again."));
