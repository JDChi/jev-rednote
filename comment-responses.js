import { commentState } from "./jev.js";

const SITE = "https://www.xiaohongshu.com";
const API = "https://edith.xiaohongshu.com";
const COMMENT_PATH = "/api/sns/web/v2/comment/page";
const WAIT_MS = 2000;
const ACK_BUDGET_MS = 150;

export function isRedNotePage(url) {
  return typeof url === "string" && url.startsWith(SITE + "/");
}

function getComments(payload, client) {
  if (payload?.success !== true || !Array.isArray(payload.data?.comments)) return [];
  const rows = new Map();
  for (const item of payload.data.comments) {
    if (typeof item?.id !== "string" || (item.note_id && item.note_id !== client.noteId)) continue;
    const state = commentState({ noteTitle: client.title, comment: item.content });
    if (state) rows.set(item.id, { id: item.id, state });
  }
  return [...rows.values()];
}

async function collectResults(jobs, signal, waitMs) {
  const results = Array(jobs.length);
  let timer;
  let stop;
  const cutoff = new Promise(resolve => {
    stop = resolve;
    timer = setTimeout(resolve, waitMs);
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    await Promise.race([cutoff, Promise.all(jobs.map(async (job, index) => { results[index] = await job; }))]);
    return results.slice();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

export function manageCommentResponses({ activeFor, analyze, prepare, send }) {
  const tabs = new Map();

  function cancel(client) {
    for (const response of client.responses) response.abort();
  }

  async function sync(tab) {
    if (tab.attached && !tab.client) {
      tab.attached = false;
      await chrome.debugger.detach(tab.target).catch(() => {});
    }
    if (!tab.attached && tab.client) {
      try {
        const target = (await chrome.debugger.getTargets()).find(({ tabId }) => tabId === tab.target.tabId);
        if (!tab.client || !isRedNotePage(target?.url)) return;
        await chrome.debugger.attach(tab.target, "1.3");
        tab.attached = true;
        await chrome.debugger.sendCommand(tab.target, "Fetch.enable", {
          patterns: [{
            urlPattern: API + COMMENT_PATH + "?*", resourceType: "XHR", requestStage: "Response"
          }]
        });
        if (tab.client) send(tab.client, { type: "response-status", active: true });
      } catch {
        if (tab.attached) await chrome.debugger.detach(tab.target).catch(() => {});
        tab.attached = false;
        if (tab.client) send(tab.client, { type: "response-status", active: false });
      }
      if (!tab.client && tab.attached) await sync(tab);
    }
  }

  function configure(client, enabled) {
    const id = client.port.sender.tab.id;
    let tab = tabs.get(id);
    if (!tab) {
      if (!enabled) return;
      tab = { target: { tabId: id }, pending: Promise.resolve() };
      tabs.set(id, tab);
    }
    if (!enabled && tab.client !== client) return;
    if (tab.client && tab.client !== client) cancel(tab.client);
    if (!enabled) cancel(client);
    tab.client = enabled ? client : null;
    tab.pending = tab.pending.then(() => sync(tab)).finally(() => {
      if (!tab.client && !tab.attached && tabs.get(id) === tab) tabs.delete(id);
    });
  }

  chrome.tabs.onUpdated.addListener((tabId, change) => {
    const client = tabs.get(tabId)?.client;
    if (client && change.url && !isRedNotePage(change.url)) configure(client, false);
  });

  chrome.debugger.onDetach.addListener(({ tabId }) => {
    const tab = tabs.get(tabId);
    if (tab?.attached) {
      tab.attached = false;
      if (tab.client) {
        cancel(tab.client);
        send(tab.client, { type: "response-status", active: false });
      }
    }
  });

  async function handle(target, event) {
    const { requestId, request, resourceType, responseStatusCode, frameId } = event;
    const release = () => chrome.debugger.sendCommand(target, "Fetch.continueResponse", { requestId })
      .catch(() => chrome.debugger.sendCommand(target, "Fetch.continueRequest", { requestId }))
      .catch(() => {});
    const client = tabs.get(target.tabId)?.client;
    const url = new URL(request.url);
    if (!client || !activeFor(client) || resourceType !== "XHR" || request.method !== "GET" ||
        url.origin !== API || url.pathname !== COMMENT_PATH ||
        !responseStatusCode || responseStatusCode < 200 || responseStatusCode >= 300 ||
        !client.noteId || url.searchParams.get("note_id") !== client.noteId) {
      await release();
      return;
    }

    const controller = new AbortController();
    const analysis = new AbortController();
    const { signal } = controller;
    client.responses.add(controller);
    const view = client.view;
    let timer;
    let started;
    let outcome = "放行";
    try {
      const { frameTree } = await chrome.debugger.sendCommand(target, "Page.getFrameTree");
      if (frameTree.frame.id !== frameId || !isRedNotePage(frameTree.frame.url) || signal.aborted) return;
      const { body, base64Encoded } = await chrome.debugger.sendCommand(target, "Fetch.getResponseBody", { requestId });
      started = performance.now();
      const deadline = Date.now() + WAIT_MS;
      timer = setTimeout(() => controller.abort("timeout"), WAIT_MS);
      if (signal.aborted || view !== client.view) return;
      const decoded = base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(body), char => char.charCodeAt(0))) : body;
      const payload = JSON.parse(decoded);
      if (payload?.success === true && typeof payload.data?.has_more === "boolean") {
        send(client, { type: "pagination", view, noteId: client.noteId, hasMore: payload.data.has_more });
      }
      const rows = getComments(payload, client).filter(({ id }) => !client.delivered.has(id));
      if (!rows.length) return;

      const cutoff = deadline - ACK_BUDGET_MS;
      const results = await collectResults(analyze(client, rows, analysis.signal, cutoff), signal, cutoff - Date.now());
      analysis.abort();
      if (view !== client.view || !activeFor(client) || signal.aborted && signal.reason !== "timeout") return;
      const deliveries = rows.map(({ id }, index) => {
        const result = results[index];
        if (result?.scores && !signal.aborted) return { id, scores: result.scores };
        return { id, error: result?.error ?? "timeout" };
      });
      const failure = deliveries.find(row => row.error)?.error;
      const judged = deliveries.filter(row => row.scores).length;
      if (!judged) {
        prepare(client, deliveries, failure, signal);
        outcome = failure === "timeout" ? "超时放行" : "失败放行";
        return;
      }
      const acknowledged = await prepare(client, deliveries, failure, signal, deadline);
      if (acknowledged && !signal.aborted) {
        outcome = `判断完成 ${judged}/${rows.length} 条`;
      } else if (view === client.view && activeFor(client) &&
                 (signal.reason === "timeout" || Date.now() >= deadline)) {
        prepare(client, deliveries.map(({ id }) => ({ id, error: "timeout" })), "timeout", signal);
        outcome = "超时放行";
      }
    } catch {
      outcome = "原样放行";
    } finally {
      clearTimeout(timer);
      analysis.abort();
      client.responses.delete(controller);
      await release();
      if (started !== undefined) console.info("[Jev 评论过滤]", `评论响应 · ${outcome} · ${Math.round(performance.now() - started)}ms`);
    }
  }

  chrome.debugger.onEvent.addListener((target, method, event) => {
    if (method === "Fetch.requestPaused") void handle(target, event);
  });
  return { configure, cancel };
}
