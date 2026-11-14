import { analyzeComments, commentState } from "./jev.js";
import { isRedNotePage, manageCommentResponses } from "./comment-responses.js";
import { createScoreCache, scoreCacheKey } from "./score-cache.js";

const MAX_CONCURRENT = 3;
const clients = new Set();
const active = new Set();
let queue = [];
let settings = {};
let authFailed = false;
let limitedUntil = 0;
let deliveryId = 0;

const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  ({ settings = {} } = await chrome.storage.local.get("settings"));
})();
const scoreCache = ready.then(() => createScoreCache(chrome.storage.local));

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

function send(client, message) {
  if (!clients.has(client)) return;
  try {
    client.port.postMessage(message);
  } catch {
    disconnect(client);
  }
}

function sendSettings(client, reset = false) {
  send(client, {
    type: "settings",
    enabled: settings.enabled === true,
    configured: Boolean(settings.apiKey),
    hideMatchedComments: settings.hideMatchedComments === true,
    reset
  });
}

function cancelJobs(client) {
  client.controller.abort();
  client.controller = new AbortController();
  responses.cancel(client);
  client.work.clear();
  client.delivered.clear();
}

function disconnect(client) {
  clients.delete(client);
  cancelJobs(client);
  responses.configure(client, false);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  void ready.then(() => {
    const updated = changes.settings.newValue ?? {};
    const reset = settings.enabled !== updated.enabled || settings.apiKey !== updated.apiKey;
    const displayChanged = (settings.hideMatchedComments === true) !== (updated.hideMatchedComments === true);
    if (!reset && !displayChanged) return;
    settings = updated;
    if (reset) {
      authFailed = false;
      limitedUntil = 0;
    }
    for (const client of clients) {
      if (reset) {
        cancelJobs(client);
        client.view = null;
      }
      sendSettings(client, reset);
      if (reset) responses.configure(client, useResponses(client));
    }
  });
});

function serviceError() {
  if (!settings.enabled) return "canceled";
  if (!settings.apiKey) return "missing-key";
  if (authFailed) return "auth";
  if (Date.now() < limitedUntil) return "limited";
  return null;
}

function useResponses(client) {
  return clients.has(client) && settings.enabled === true && Boolean(settings.apiKey);
}

function enqueue(analyze, signal, urgent = false) {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve({ error: "canceled" });
      return;
    }
    const job = { analyze, signal, urgent, enqueuedAt: performance.now() };
    const cancel = () => {
      queue = queue.filter(queued => queued !== job);
      resolve({ error: "canceled" });
    };
    signal.addEventListener("abort", cancel, { once: true });
    job.finish = result => {
      signal.removeEventListener("abort", cancel);
      resolve(result);
    };
    if (urgent) {
      const next = queue.findIndex(queued => !queued.urgent);
      queue.splice(next < 0 ? queue.length : next, 0, job);
    } else {
      queue.push(job);
    }
    drain();
  });
}

async function run(job) {
  const startedAt = performance.now();
  try {
    const result = await job.analyze(settings.apiKey);
    if (job.urgent) {
      const queuedMs = Math.round(startedAt - job.enqueuedAt);
      const requestMs = Math.round(performance.now() - startedAt);
      console.info("[Jev 评论过滤]", `Jev 批次 · 排队 ${queuedMs}ms · 请求 ${requestMs}ms · ${result.error ?? "完成"}`);
    }
    if (job.signal.aborted) return;
    if (result.error === "auth") authFailed = true;
    if (result.error === "limited") {
      limitedUntil = Math.max(limitedUntil, Date.now() + result.retryAfterMs);
    }
    const { retryAfterMs, ...reply } = result;
    job.finish(reply);
  } catch {
    job.finish({ error: "unavailable" });
  } finally {
    active.delete(job);
    drain();
  }
}

function drain() {
  while (queue.length && active.size < MAX_CONCURRENT) {
    const job = queue.shift();
    const error = serviceError();
    if (error) {
      job.finish({ error });
      continue;
    }
    active.add(job);
    void run(job);
  }
}

async function analyzeFreshRows(noteId, rows, signal, deadline, urgent) {
  const startedAt = performance.now();
  const keys = rows.map(({ id }) => scoreCacheKey(noteId, id));
  const cache = await scoreCache;
  const cached = await cache.read(keys, deadline);
  const error = signal.aborted ? "canceled" : deadline <= Date.now() ? "timeout" : null;
  if (error) return rows.map(() => ({ error }));

  const results = [];
  const misses = [];
  rows.forEach((row, index) => {
    if (cached[index]) results[index] = { scores: cached[index] };
    else misses.push({ state: row.state, key: keys[index], index });
  });
  console.info("[Jev 评论过滤]",
    `本地缓存 · 命中 ${rows.length - misses.length} · 未命中 ${misses.length} · 查询 ${Math.round(performance.now() - startedAt)}ms`);

  for (let start = 0; start < misses.length; start += 5) {
    const batch = misses.slice(start, start + 5);
    const result = enqueue(apiKey => {
      const timeout = deadline === undefined ? undefined : deadline - Date.now();
      return timeout <= 0 ? { error: "timeout" } : analyzeComments(apiKey, batch.map(row => row.state), signal, timeout);
    }, signal, urgent).then(reply => {
      if (signal.aborted) return { error: "canceled" };
      if (deadline <= Date.now()) return { error: "timeout" };
      if (reply.scores) {
        cache.write(batch.flatMap(({ key }, index) => key ? [{ key, scores: reply.scores[index] }] : []));
      }
      return reply;
    });
    batch.forEach(({ index }, position) => {
      results[index] = result.then(({ scores, error }) => scores ? { scores: scores[position] } : { error });
    });
  }
  return results;
}

function analyzeRows(client, rows, signal, deadline, urgent = false) {
  const missing = new Map();
  for (const row of rows) {
    if (!client.work.has(row.id) && !client.delivered.has(row.id)) missing.set(row.id, row);
  }
  const fresh = [...missing.values()];
  if (fresh.length) {
    const results = analyzeFreshRows(client.noteId, fresh, signal, deadline, urgent);
    fresh.forEach(({ id }, index) => client.work.set(id, results.then(batch => batch[index])));
  }
  return rows.map(({ id }) => client.delivered.get(id) ?? client.work.get(id));
}

function prepareResponse(client, rows, error, signal, deadline) {
  const delivery = ++deliveryId;
  const message = { type: "prepared", view: client.view, noteId: client.noteId, delivery, rows, error, deadline };
  const save = () => {
    for (const { id, ...result } of rows) client.delivered.set(id, result);
  };
  if (!rows.some(row => row.scores)) {
    save();
    send(client, message);
    return false;
  }
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const finish = accepted => {
      signal.removeEventListener("abort", cancel);
      client.acks.delete(delivery);
      const confirmed = accepted && !signal.aborted && Date.now() < deadline;
      if (confirmed) {
        save();
        send(client, {
          type: "confirmed", view: message.view, delivery, ids: rows.map(row => row.id)
        });
      }
      resolve(confirmed);
    };
    const cancel = () => finish(false);
    signal.addEventListener("abort", cancel, { once: true });
    client.acks.set(delivery, finish);
    send(client, message);
  });
}

const responses = manageCommentResponses({
  activeFor: useResponses,
  analyze: (client, rows, signal, deadline) => analyzeRows(client, rows, signal, deadline, true),
  prepare: prepareResponse,
  send
});

function sendDOMResult(client, view, requestId, commentId, result) {
  void Promise.resolve(result).then(reply => {
    if (client.view === view) send(client, {
      type: "result", view, id: requestId, ...(client.delivered.get(commentId) ?? reply)
    });
  });
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "jev-comments" || port.sender?.frameId !== 0 ||
      !isRedNotePage(port.sender?.url) || !Number.isInteger(port.sender.tab?.id)) {
    port.disconnect();
    return;
  }

  const client = {
    port, view: null, noteId: null, title: "", controller: new AbortController(),
    responses: new Set(), work: new Map(), delivered: new Map(), acks: new Map()
  };
  clients.add(client);
  port.onDisconnect.addListener(() => disconnect(client));
  port.onMessage.addListener(message => {
    void ready.then(() => {
      if (!clients.has(client) || !Number.isSafeInteger(message?.view)) return;
      if (message.type === "view") {
        if (message.view !== client.view || message.noteId !== client.noteId) cancelJobs(client);
        client.view = message.view;
        client.noteId = message.noteId;
        client.title = typeof message.title === "string" ? message.title : "";
        return;
      }
      if (message.type === "ack" && message.view === client.view) {
        client.acks.get(message.delivery)?.(true);
        return;
      }
      if (message.view !== client.view || message.type !== "analyze-batch" || !Array.isArray(message.rows)) return;

      const rows = [];
      for (const row of message.rows) {
        if (!Number.isSafeInteger(row?.id)) continue;
        const state = commentState(row.state);
        const id = typeof row.commentId === "string" ? row.commentId : row.id;
        if (state) {
          rows.push({ id, requestId: row.id, state, deadline: row.deadline });
        } else {
          sendDOMResult(client, message.view, row.id, id, { error: "response" });
        }
      }
      const deadline = rows.reduce((earliest, row) => Number.isFinite(row.deadline)
        ? Math.min(earliest ?? Infinity, row.deadline) : earliest, undefined);
      const results = analyzeRows(client, rows, client.controller.signal, deadline);
      rows.forEach(({ id, requestId }, index) => sendDOMResult(client, message.view, requestId, id, results[index]));
    });
  });

  void ready.then(() => {
    sendSettings(client);
    responses.configure(client, useResponses(client));
  });
});
