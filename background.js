import { analyzeComment, commentState } from "./jev.js";

const MAX_CONCURRENT = 3;
const clients = new Set();
const active = new Set();
let queue = [];
let settings = {};
let authFailed = false;
let limitedUntil = 0;

const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  ({ settings = {} } = await chrome.storage.local.get("settings"));
})();

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
    reset
  });
}

function cancelJobs(client) {
  queue = queue.filter(job => job.client !== client);
  for (const job of active) {
    if (job.client === client) job.controller.abort();
  }
}

function disconnect(client) {
  clients.delete(client);
  cancelJobs(client);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  void ready.then(() => {
    const updated = changes.settings.newValue ?? {};
    if (settings.enabled === updated.enabled && settings.apiKey === updated.apiKey) return;
    settings = updated;
    authFailed = false;
    limitedUntil = 0;
    for (const client of clients) {
      cancelJobs(client);
      client.view = null;
      sendSettings(client, true);
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

function sendResult(job, result) {
  if (job.client.view !== job.view) return;
  send(job.client, { type: "result", view: job.view, id: job.id, ...result });
}

async function run(job) {
  try {
    const result = await analyzeComment(settings.apiKey, job.state, job.controller.signal);
    if (job.controller.signal.aborted) return;

    if (result.error === "auth") authFailed = true;
    if (result.error === "limited") {
      limitedUntil = Math.max(limitedUntil, Date.now() + result.retryAfterMs);
    }
    const { retryAfterMs, ...reply } = result;
    sendResult(job, reply);
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
      sendResult(job, { error });
      continue;
    }
    active.add(job);
    void run(job);
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "jev-comments" || port.sender?.frameId !== 0 ||
      !port.sender?.url?.startsWith("https://www.xiaohongshu.com/")) {
    port.disconnect();
    return;
  }

  const client = { port, view: null };
  clients.add(client);
  port.onDisconnect.addListener(() => disconnect(client));
  port.onMessage.addListener(message => {
    void ready.then(() => {
      if (!clients.has(client) || !Number.isSafeInteger(message?.view)) return;
      if (message.type === "view") {
        cancelJobs(client);
        client.view = message.view;
        return;
      }
      if (message.type !== "analyze" || message.view !== client.view ||
          !Number.isSafeInteger(message.id)) return;

      const job = { client, view: message.view, id: message.id };
      const error = serviceError();
      const state = commentState(message.state);
      if (error || !state) {
        sendResult(job, { error: error ?? "response" });
        return;
      }
      queue.push({ ...job, state, controller: new AbortController() });
      drain();
    });
  });

  void ready.then(() => sendSettings(client));
});
