const jevComments = (() => {
  const NOTE_PANEL = "#noteContainer, .note-detail-mask, .note-detail-container";
  const COMMENT_LIST = ".comments-container, .comments-el";
  const COMMENT = ".comment-item, .comment-item-sub";
  const REPLY_LIST = ".reply-container, .sub-comment-list";
  const BODY = ".content, .note-text, .comment-content";
  const HIDDEN_CLASS = "jev-rednote-hidden";

  function text(element) {
    return element?.textContent.replace(/\s+/g, " ").trim() ?? "";
  }

  function note() {
    const routeId = location.pathname.match(
      /^\/(?:explore|discovery\/item|search_result|user\/profile\/[^/]+)\/([a-f\d]{24})\/?$/i
    )?.[1];
    const lists = Array.from(document.querySelectorAll(COMMENT_LIST)).reverse();
    for (const list of lists) {
      const panel = list.closest(NOTE_PANEL);
      if ((!routeId && !panel) || !list.getClientRects().length ||
          getComputedStyle(list).visibility === "hidden") continue;
      if (list.parentElement.closest(COMMENT_LIST)) continue;

      const scope = panel ?? list.closest(".note-scroller, .note-container") ?? document;
      const panelId = panel?.getAttribute("data-note-id");
      if (routeId && panelId && routeId !== panelId) continue;
      const title = text(scope.querySelector("#detail-title, .note-content > .title"));
      return { key: routeId || panelId || panel, list, title };
    }
    return { key: routeId ?? null };
  }

  function own(item, selector) {
    return Array.from(item.querySelectorAll(selector)).find(el => el.closest(COMMENT) === item);
  }

  function hideTarget({ item, thread, isReply }) {
    if (item.querySelector(`${COMMENT}, ${REPLY_LIST}, .show-more, .reply-more`)) return null;
    if (!isReply && item.parentElement === thread && thread.childElementCount === 1) {
      return thread;
    }
    return item;
  }

  function read(list) {
    const comments = [];
    const byItem = new Map();
    const threads = new Map();
    for (const item of list.querySelectorAll(COMMENT)) {
      if (!item.getClientRects().length) {
        const hiddenByExtension = item.classList.contains(HIDDEN_CLASS) ||
          item.parentElement.matches(`.parent-comment.${HIDDEN_CLASS}`);
        if (!hiddenByExtension || item.closest("[hidden]")) continue;
      }
      const body = own(item, BODY);
      const comment = text(body);
      if (!comment || body.querySelector(COMMENT)) continue;

      const id = item.getAttribute("data-comment-id") || item.id.match(/^comment-(.+)$/)?.[1];
      const thread = item.closest(".parent-comment");
      const row = {
        item,
        body,
        comment,
        key: id || item,
        thread,
        author: text(own(item, ".author-wrapper .name, .author .name, .user-name")),
        isReply: Boolean(item.closest(REPLY_LIST) || item.classList.contains("comment-item-sub"))
      };
      comments.push(row);
      byItem.set(item, row);
      if (thread) {
        if (!threads.has(thread)) threads.set(thread, []);
        threads.get(thread).push(row);
      }
    }

    for (const row of comments) {
      const enclosing = row.item.parentElement.closest(COMMENT);
      if (!row.isReply && !enclosing) continue;
      const thread = threads.get(row.thread) ?? [];
      const target = text(row.body.querySelector(":scope > .nickname, :scope > .reply-to"));
      if (target) {
        const matches = thread.filter(candidate => candidate !== row && candidate.author === target);
        if (matches.length === 1) row.parentComment = matches[0].comment;
      } else {
        row.parentComment = (byItem.get(enclosing) ?? thread.find(candidate => !candidate.isReply))?.comment;
      }
    }
    return comments;
  }

  return { note, read, hideTarget, HIDDEN_CLASS };
})();
