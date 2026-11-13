(() => {
  const LOG_PREFIX = "[Jev 评论过滤]";
  const { HIDDEN_CLASS, FOLDED_THREAD_CLASS } = jevComments;
  const WAITING_CLASS = "jev-rednote-waiting";
  const PAGINATION_TAIL = "jev-rednote-pagination-tail";
  const PAGINATION_TARGET = "jev-rednote-pagination-target";
  const PAGINATION_SPACE = "jev-rednote-pagination-space";
  const DOM_WAIT_MS = 2000;
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
  const prepared = new Map();
  const waiting = new Map();
  let pagination;
  let hasMore;
  let noteKey = null;
  let reportedNote;
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
  let loggedTimeout = false;

  const observer = new MutationObserver(mutations => {
    if (hideMatchedComments && mutations.some(jevComments.touchesComments)) {
      scan(true, true);
      return;
    }
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
    treatment.thread?.classList.remove(FOLDED_THREAD_CLASS);
    body.classList.remove("jev-rednote-folded");
    if (treatment.generatedId && body.id === treatment.generatedId) body.removeAttribute("id");
    treatment.control?.remove();
    rendered.delete(body);
  }

  function clearView(key) {
    for (const entry of waiting.keys()) stopWaiting(entry);
    for (const [body, treatment] of rendered) removeTreatment(body, treatment);
    clearPagination();
    hasMore = undefined;
    status?.remove();
    status = undefined;
    errorCode = undefined;
    loggedTimeout = false;
    hasScanned = false;
    if (!enabled) reportHiddenCount();
    lastHiddenCount = undefined;
    noteKey = key;
    entries = new Map();
    requests = new Map();
    prepared.clear();
    reportedNote = undefined;
    view += 1;
  }

  function stopWaiting(entry) {
    const hold = waiting.get(entry);
    if (!hold) return;
    clearTimeout(hold.timer);
    hold.target.classList.remove(WAITING_CLASS);
    waiting.delete(entry);
  }

  function waitForDecision(row, entry) {
    const target = row.thread;
    const existing = waiting.get(entry);
    if (existing) {
      if (existing.target !== target) {
        existing.target.classList.remove(WAITING_CLASS);
        existing.target = target;
      }
    } else {
      const deadline = Date.now() + DOM_WAIT_MS;
      const timer = setTimeout(() => {
        requests.delete(entry.id);
        stopWaiting(entry);
        reportError("timeout");
        scheduleScan();
      }, DOM_WAIT_MS);
      waiting.set(entry, { target, timer, deadline });
    }
    target.classList.toggle(WAITING_CLASS, true);
  }

  function clearPagination() {
    if (!pagination) return;
    pagination.tail?.classList.remove(PAGINATION_TAIL);
    pagination.target?.classList.remove(PAGINATION_TARGET);
    pagination.list.classList.remove(PAGINATION_SPACE);
    pagination.list.style.removeProperty("--jev-rednote-pagination-space");
    pagination = undefined;
  }

  function updatePagination(list, rows) {
    if (!hideMatchedComments || hasMore === false) {
      clearPagination();
      return;
    }
    if (pagination?.list !== list) {
      clearPagination();
      pagination = { list, space: 0, wasScrollable: false };
    }
    const scroller = jevComments.scrollContainer(list);
    if (!scroller) return;
    const last = rows.at(-1);
    const tail = rendered.get(last?.body)?.hiddenTarget;
    const target = tail ? last.item : null;
    if (tail !== pagination.tail) {
      pagination.tail?.classList.remove(PAGINATION_TAIL);
      tail?.classList.add(PAGINATION_TAIL);
      pagination.tail = tail;
    }
    if (target !== pagination.target) {
      pagination.target?.classList.remove(PAGINATION_TARGET);
      target?.classList.add(PAGINATION_TARGET);
      pagination.target = target;
    }
    const canScroll = scroller.scrollHeight > scroller.clientHeight + pagination.space + 1;
    pagination.wasScrollable ||= canScroll;
    const hidden = list.querySelector(`.${HIDDEN_CLASS}`);
    let space = 0;
    if (hidden && !canScroll && (hasMore === true || pagination.wasScrollable)) {
      const root = scroller === document.scrollingElement;
      const top = root ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop;
      const bottom = list.getBoundingClientRect().bottom - pagination.space + scroller.scrollTop - top;
      space = Math.max(32, Math.ceil(scroller.clientHeight - bottom) + 32);
    }
    if (space !== pagination.space) {
      pagination.space = space;
      list.style.setProperty("--jev-rednote-pagination-space", space + "px");
      list.classList.toggle(PAGINATION_SPACE, space > 0);
    }
  }

  function syncView(note) {
    if (note.key !== noteKey) clearView(note.key);
    const title = note.title ?? "";
    if (connected && (reportedNote?.id !== note.id || reportedNote?.title !== title)) {
      reportedNote = { id: note.id, title };
      port.postMessage({ type: "view", view, noteId: note.id, title });
    }
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
            !hiddenTarget.parentElement.closest(`.${HIDDEN_CLASS}`) &&
            (hiddenTarget.classList.contains(PAGINATION_TAIL) || getComputedStyle(hiddenTarget).display === "none")) count += 1;
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
    const hiddenTarget = decision?.folded && hideMatchedComments ? row.thread : null;
    const foldedThread = decision?.folded && !hideMatchedComments ? row.thread : null;
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
        previous.setFolded?.(previous.control.getAttribute("aria-expanded") === "false", foldedThread);
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
      treatment.setFolded = (collapsed, thread = treatment.thread) => {
        body.classList.toggle("jev-rednote-folded", collapsed);
        if (treatment.thread !== thread) treatment.thread?.classList.remove(FOLDED_THREAD_CLASS);
        thread?.classList.toggle(FOLDED_THREAD_CLASS, collapsed);
        treatment.thread = thread;
        const expanded = String(!collapsed);
        if (control.getAttribute("aria-expanded") !== expanded) {
          control.setAttribute("aria-expanded", expanded);
          control.textContent = collapsed ? `已折叠 · ${reason} · 展开` : `收起 · ${reason}`;
        }
      };
      treatment.setFolded(true, foldedThread);
      control.addEventListener("click", () => {
        treatment.setFolded(control.getAttribute("aria-expanded") === "true");
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

  function scan(queueNew = true, beforePaint = false) {
    if (!enabled) return;
    const note = jevComments.note();
    syncView(note);
    if (!note.list) {
      clearPagination();
      for (const entry of waiting.keys()) stopWaiting(entry);
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

    const outgoing = [];
    for (const row of rows) {
      let entry = entries.get(row.key);
      const result = prepared.get(row.key);
      const decision = result && Date.now() < result.deadline ? result.decision : null;
      if (result && (!entry || entry.prepared !== result || entry.decision !== decision)) {
        if (entry) {
          requests.delete(entry.id);
          stopWaiting(entry);
        }
        entry = { id: entry?.id ?? ++requestId, comment: row.comment, decision, prepared: result };
        entries.set(row.key, entry);
      }
      if (queueNew && !entry && connected && configured) {
        entry = { id: ++requestId, comment: row.comment };
        entries.set(row.key, entry);
        requests.set(entry.id, entry);
        if (beforePaint) waitForDecision(row, entry);
        outgoing.push({
          id: entry.id,
          deadline: waiting.get(entry)?.deadline,
          commentId: typeof row.key === "string" ? row.key : null,
          state: { noteTitle: note.title, comment: row.comment }
        });
      }
      if (entry?.comment === row.comment) {
        if (waiting.has(entry)) waitForDecision(row, entry);
        applyTreatment(row, entry);
      } else if (rendered.has(row.body)) {
        removeTreatment(row.body, rendered.get(row.body));
      }
    }
    if (outgoing.length && hideMatchedComments) {
      port.postMessage({ type: "analyze-batch", view, rows: outgoing });
    } else {
      for (const row of outgoing) port.postMessage({ type: "analyze", view, ...row });
    }
    if (!hasScanned || outgoing.length > 0) {
      console.info(LOG_PREFIX, `读取到 ${rows.length} 条主评论，本次提交 ${outgoing.length} 条分析。`);
      hasScanned = true;
    }
    showStatus(note.list);
    updatePagination(note.list, rows);
    reportHiddenCount();
  }

  function onSettings(message) {
    const firstMessage = !connected;
    connected = true;
    hideMatchedComments = message.hideMatchedComments === true;
    // A display-only change must not send a view message, which cancels queued requests.
    if (!firstMessage && !message.reset) {
      if (!hideMatchedComments) {
        for (const entry of waiting.keys()) stopWaiting(entry);
        clearPagination();
      }
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
    if (firstMessage) reportedNote = undefined;

    if (enabled) {
      syncView(jevComments.note());
      observer.observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["hidden", "aria-hidden", "data-note-id", "data-comment-id", "id", "style", "class"]
      });
      scheduleScan();
    } else {
      observer.disconnect();
    }
  }

  function reportError(code) {
    if (code === "timeout") {
      if (!loggedTimeout) console.warn(LOG_PREFIX, ERRORS.timeout);
      loggedTimeout = true;
      return;
    }
    if (ERRORS[code] && errorCode !== code) {
      errorCode = code;
      console.warn(LOG_PREFIX, ERRORS[code]);
    }
  }

  function onPrepared(message) {
    if (!enabled || !hideMatchedComments) return;
    const note = jevComments.note();
    syncView(note);
    if (message.view !== view || message.noteId !== note.id) return;
    for (const { id, scores } of message.rows) {
      prepared.set(id, {
        decision: scores ? decideTreatment(scores) : null,
        deadline: message.deadline ?? Infinity,
        delivery: message.delivery
      });
    }
    reportError(message.error);
    const judged = message.rows.filter(row => row.scores).length;
    console.info(LOG_PREFIX, `评论响应 · ${judged} 条已判断 · ${message.rows.length - judged} 条原文放行。`);
    port.postMessage({ type: "ack", view, delivery: message.delivery });
    scheduleScan();
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
      if (message.type === "prepared") {
        onPrepared(message);
        return;
      }
      if (message.type === "pagination" && message.view === view && message.noteId === reportedNote?.id) {
        hasMore = message.hasMore;
        scheduleScan();
        return;
      }
      if (message.type === "response-status") {
        console.info(LOG_PREFIX, message.active ? "评论响应监听已连接。" : "评论响应监听不可用，使用页面内判定。");
        return;
      }
      if (message.type === "confirmed" && message.view === view) {
        for (const id of message.ids) {
          const result = prepared.get(id);
          if (result?.delivery === message.delivery) result.deadline = Infinity;
        }
        return;
      }
      if (message.type !== "result" || message.view !== view) return;
      const entry = requests.get(message.id);
      if (!entry) return;
      requests.delete(message.id);
      const hold = waiting.get(entry);
      if (hold && Date.now() >= hold.deadline) {
        stopWaiting(entry);
        reportError("timeout");
        scheduleScan();
        return;
      }
      if (message.scores) entry.decision = decideTreatment(message.scores);
      reportError(message.error);
      if (waiting.has(entry)) {
        scan(false);
        stopWaiting(entry);
      }
      scheduleScan();
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      connected = false;
      if (requests.size) {
        console.warn(LOG_PREFIX, `扩展后台连接中断，${requests.size} 条评论分析未完成。`);
        requests.clear();
        for (const entry of waiting.keys()) stopWaiting(entry);
        errorCode = "unavailable";
        scheduleScan();
      }
      if (chrome.runtime.id) setTimeout(connect, 1000);
    });
  }

  const onNavigation = () => {
    if (enabled) syncView(jevComments.note());
    scheduleScan();
  };
  window.addEventListener("popstate", onNavigation);
  window.navigation?.addEventListener("currententrychange", onNavigation);
  connect();
})();
