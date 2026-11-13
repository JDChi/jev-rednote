const jevComments = (() => {
  const NOTE_PANEL = "#noteContainer, .note-detail-mask, .note-detail-container";
  const COMMENT_LIST = ".comments-container, .comments-el";
  const COMMENT = ".comment-item, .comment-item-sub";
  const REPLY_LIST = ".reply-container, .sub-comment-list";
  const BODY = ".content, .note-text, .comment-content";
  const HIDDEN_CLASS = "jev-rednote-hidden";
  const HIDDEN = `.${HIDDEN_CLASS}`;
  const FOLDED_THREAD_CLASS = "jev-rednote-thread-folded";

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
      return { key: routeId || panelId || panel, id: routeId || panelId || null, list, title };
    }
    return { key: routeId ?? null, id: routeId ?? null };
  }

  function commentId(item) {
    return item.getAttribute("data-comment-id") || item.id.match(/^comment-(.+)$/)?.[1];
  }

  function isMainComment(item) {
    return !item.classList.contains("comment-item-sub") &&
      !item.closest(REPLY_LIST) && !item.parentElement?.closest(COMMENT);
  }

  function touchesComments(mutation) {
    const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
    if (target?.closest(REPLY_LIST)) return false;
    const comment = target?.closest(COMMENT);
    if (comment && isMainComment(comment)) return true;
    const candidates = mutation.type === "attributes" ? [target] : mutation.addedNodes;
    for (const node of candidates) {
      if (!(node instanceof Element)) continue;
      if (node.matches(COMMENT) && isMainComment(node)) return true;
      if (Array.from(node.querySelectorAll(COMMENT)).some(isMainComment)) return true;
    }
    return false;
  }

  function scrollContainer(list) {
    for (let node = list.parentElement; node; node = node.parentElement) {
      if (/^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) return node;
    }
    return document.scrollingElement;
  }

  function own(item, selector) {
    return Array.from(item.querySelectorAll(selector)).find(el => el.closest(COMMENT) === item);
  }

  function read(list) {
    const comments = [];
    for (const item of list.querySelectorAll(COMMENT)) {
      if (!isMainComment(item)) continue;
      if (!item.getClientRects().length && (!item.closest(HIDDEN) || item.closest("[hidden]"))) continue;
      const body = own(item, BODY);
      const comment = text(body);
      if (!comment || body.querySelector(COMMENT)) continue;

      const id = commentId(item);
      comments.push({
        item,
        body,
        comment,
        key: id || item,
        thread: item.closest(".parent-comment") ?? item
      });
    }
    return comments;
  }

  return { note, read, touchesComments, scrollContainer, HIDDEN_CLASS, FOLDED_THREAD_CLASS };
})();
