(() => {
  const LOG_PREFIX = "[Jev 评论过滤]";
  const { HIDDEN_CLASS } = jevComments;
  const LABELS = {
    promotion: { folded: "推广引流", suspected: "疑似推广" },
    diandianRequest: { folded: "点点互动请求", suspected: "疑似点点互动请求" }
  };
  const ERRORS = {
    "missing-key": "请在扩展设置中填写 TypeSafe API Key。",
    auth: "TypeSafe 拒绝了请求。请检查扩展设置中的 API Key。",
    limited: "TypeSafe 暂时限流，未分析的评论保持原样。",
    timeout: "部分评论分析超时，原文已保留。",
    response: "Jev 返回了无法读取的结果，原文已保留。",
    unavailable: "暂时无法连接 Jev，未分析的评论保持原样。"
  };

  const rendered = new Map();
  const lastSeen = new WeakMap();
  let entries = new Map();
  let requests = new Map();
  let noteKey = null;
  let view = 0;
  let requestId = 0;
  let bodyId = 0;
  let port;
  let enabled = false;
  let configured = false;
  let hideMatchedComments = false;
  let connected = false;
  let hasScanned = false;
  let lastHiddenCount;
  let timer;
  let status;
  let errorCode;

  const observer = new MutationObserver(mutations => {
    if (mutations.some(mutation => mutation.type !== "attributes" ||
        mutation.target.closest("#noteContainer, .note-detail-mask, .comments-container, .comments-el"))) {
      scheduleScan();
    }
  });

  function scheduleScan() {
    if (!enabled || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      scan();
    }, 40);
  }

  function removeTreatment(body, treatment) {
    treatment.hiddenTarget?.classList.remove(HIDDEN_CLASS);
    body.classList.remove("jev-rednote-folded");
    if (treatment.generatedId && body.id === treatment.generatedId) body.removeAttribute("id");
    treatment.control?.remove();
    rendered.delete(body);
  }

  function clearView(key) {
    for (const [body, treatment] of rendered) removeTreatment(body, treatment);
    status?.remove();
    status = undefined;
    errorCode = undefined;
    hasScanned = false;
    if (!enabled) reportHiddenCount();
    lastHiddenCount = undefined;
    noteKey = key;
    entries = new Map();
    requests = new Map();
    view += 1;
    if (connected) port.postMessage({ type: "view", view });
  }

  function decideTreatment(scores) {
    const reasons = [];
    let folded = false;
    for (const [key, labels] of Object.entries(LABELS)) {
      const score = scores[key];
      if (score >= 0.95) {
        folded = true;
        reasons.push(labels.folded);
      } else if (score >= 0.75) {
        reasons.push(labels.suspected);
      }
    }
    return { folded, reason: reasons.join("、"), scores };
  }

  function logTreatment(entry, action) {
    if (entry.action === action) return;
    const event = entry.action ? "显示方式已更新" : "分析完成";
    const { promotion, diandianRequest } = entry.decision.scores;
    console.info(LOG_PREFIX,
      `评论 #${entry.id} ${event} · ${action} · 推广 ${promotion} · 点点 ${diandianRequest}`);
    entry.action = action;
  }

  function reportHiddenCount() {
    const tracking = enabled && hideMatchedComments;
    if (!tracking && lastHiddenCount === undefined) return;

    let count = 0;
    if (tracking) {
      for (const { hiddenTarget } of rendered.values()) {
        if (hiddenTarget?.isConnected && hiddenTarget.classList.contains(HIDDEN_CLASS) &&
            getComputedStyle(hiddenTarget).display === "none") count += 1;
      }
    }
    if (count !== lastHiddenCount) {
      console.info(LOG_PREFIX, `当前笔记整条隐藏 ${count} 条评论。`);
    }
    lastHiddenCount = tracking ? count : undefined;
  }

  function applyTreatment(row, entry) {
    const { body } = row;
    const { decision } = entry;
    const hiddenTarget = decision?.folded && hideMatchedComments ? jevComments.hideTarget(row) : null;
    if (decision) {
      const action = decision.folded ? (hiddenTarget ? "隐藏" : "折叠") : decision.reason ? "标记" : "保留";
      logTreatment(entry, action);
    }
    const previous = rendered.get(body);
    if (previous?.entry === entry) {
      if (hiddenTarget && previous.hiddenTarget === hiddenTarget) {
        hiddenTarget.classList.toggle(HIDDEN_CLASS, true);
        return;
      }
      if (!hiddenTarget && previous.control?.parentElement === body.parentElement) {
        body.classList.toggle("jev-rednote-folded", previous.control.getAttribute("aria-expanded") === "false");
        return;
      }
    }
    if (previous) removeTreatment(body, previous);
    if (!decision?.reason) return;

    if (hiddenTarget) {
      hiddenTarget.classList.add(HIDDEN_CLASS);
      rendered.set(body, { entry, hiddenTarget });
      return;
    }

    const { folded, reason } = decision;
    const control = document.createElement(folded ? "button" : "span");
    control.className = folded ? "jev-rednote-toggle" : "jev-rednote-label";
    const treatment = { entry, control };
    if (folded) {
      control.type = "button";
      if (!body.id) {
        treatment.generatedId = `jev-rednote-body-${++bodyId}`;
        body.id = treatment.generatedId;
      }
      control.setAttribute("aria-controls", body.id);
      const setFolded = collapsed => {
        body.classList.toggle("jev-rednote-folded", collapsed);
        control.setAttribute("aria-expanded", String(!collapsed));
        control.textContent = collapsed ? `已折叠 · ${reason} · 展开` : `收起 · ${reason}`;
      };
      setFolded(true);
      control.addEventListener("click", () => {
        setFolded(control.getAttribute("aria-expanded") === "true");
      });
    } else {
      control.textContent = reason;
    }
    body.before(control);
    rendered.set(body, treatment);
  }

  function showStatus(list) {
    const message = configured ? ERRORS[errorCode] : ERRORS["missing-key"];
    if (!message) return;
    if (!status) {
      status = document.createElement("p");
      status.className = "jev-rednote-status";
      status.setAttribute("role", "status");
    }
    if (status.textContent !== message) status.textContent = message;
    if (status.parentElement !== list) list.prepend(status);
  }

  function scan() {
    if (!enabled) return;
    const note = jevComments.note();
    if (note.key !== noteKey) clearView(note.key);
    if (!note.list) {
      for (const [body, treatment] of rendered) removeTreatment(body, treatment);
      status?.remove();
      lastHiddenCount = undefined;
      return;
    }

    const rows = jevComments.read(note.list).filter(row => {
      const previous = lastSeen.get(row.item);
      // The site can update the URL before removing the previous note's DOM.
      if (previous && previous.note !== note.key && previous.key === row.key &&
          previous.comment === row.comment) return false;
      lastSeen.set(row.item, { note: note.key, key: row.key, comment: row.comment });
      return true;
    });
    const currentBodies = new Set(rows.map(row => row.body));
    // Remove old treatments before a replacement row can reuse their hidden wrapper.
    for (const [body, treatment] of rendered) {
      if (!currentBodies.has(body)) removeTreatment(body, treatment);
    }

    let queued = 0;
    for (const row of rows) {
      let entry = entries.get(row.key);
      if (!entry && connected && configured) {
        entry = { id: ++requestId, comment: row.comment };
        entries.set(row.key, entry);
        requests.set(entry.id, entry);
        port.postMessage({
          type: "analyze",
          view,
          id: entry.id,
          state: { noteTitle: note.title, comment: row.comment, parentComment: row.parentComment ?? "" }
        });
        queued += 1;
      }
      if (entry?.comment === row.comment) {
        applyTreatment(row, entry);
      } else if (rendered.has(row.body)) {
        removeTreatment(row.body, rendered.get(row.body));
      }
    }
    if (!hasScanned || queued > 0) {
      console.info(LOG_PREFIX, `读取到 ${rows.length} 条文字评论，本次提交 ${queued} 条分析。`);
      hasScanned = true;
    }
    showStatus(note.list);
    reportHiddenCount();
  }

  function onSettings(message) {
    const firstMessage = !connected;
    connected = true;
    hideMatchedComments = message.hideMatchedComments === true;
    // A display-only change must not send a view message, which cancels queued requests.
    if (!firstMessage && !message.reset) {
      scheduleScan();
      return;
    }
    enabled = message.enabled;
    configured = message.configured;
    if (!enabled) {
      console.info(LOG_PREFIX, "自动分析已关闭。");
    } else if (!configured) {
      console.warn(LOG_PREFIX, ERRORS["missing-key"]);
    } else {
      console.info(LOG_PREFIX, "自动分析已开启，正在等待笔记评论。");
    }
    if (message.reset || !enabled) clearView(null);
    else port.postMessage({ type: "view", view });

    if (enabled) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["hidden", "aria-hidden", "data-note-id", "style", "class"]
      });
      scheduleScan();
    } else {
      observer.disconnect();
    }
  }

  function connect() {
    try {
      port = chrome.runtime.connect({ name: "jev-comments" });
    } catch {
      return;
    }
    port.onMessage.addListener(message => {
      if (message.type === "settings") {
        onSettings(message);
        return;
      }
      if (message.type !== "result" || message.view !== view) return;
      const entry = requests.get(message.id);
      if (!entry) return;
      requests.delete(message.id);
      if (message.scores) entry.decision = decideTreatment(message.scores);
      if (ERRORS[message.error] && errorCode !== message.error) {
        errorCode = message.error;
        console.warn(LOG_PREFIX, ERRORS[errorCode]);
      }
      scheduleScan();
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      connected = false;
      if (requests.size) {
        console.warn(LOG_PREFIX, `扩展后台连接中断，${requests.size} 条评论分析未完成。`);
        requests.clear();
        errorCode = "unavailable";
        scheduleScan();
      }
      if (chrome.runtime.id) setTimeout(connect, 1000);
    });
  }

  window.addEventListener("popstate", scheduleScan);
  window.navigation?.addEventListener("currententrychange", scheduleScan);
  connect();
})();
