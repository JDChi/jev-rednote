import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const extension = fileURLToPath(new URL("..", import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "jev-rednote-test-"));
const noteA = "/explore/111111111111111111111111";
const noteB = "/explore/222222222222222222222222";
const site = "https://www.xiaohongshu.com";
const recommendation = "多给我推荐这种，狠狠研究自己，只对自己好，对自己最有责任感";
const pendingPromotion = "正在处理的推广评论";
const subscription = "@点点 帮我订阅每日职场干货";
const replyOnly = "点点 帮我把这个回复总结一下";
const commentsAPI = "https://edith.xiaohongshu.com/api/sns/web/v2/comment";

const row = (id, comment, author, reply = false, children = "") => `
  <div id="comment-${id}" class="comment-item${reply ? " comment-item-sub" : ""}">
    <div class="author-wrapper"><span class="name">${author}</span></div>
    <div class="content">${comment}</div>
    <button>回复</button>
    ${children}
  </div>`;

const firstComments = `
  <div class="parent-comment">
    ${row("promo", "加我微信领取资料", "路人")}
    <div class="reply-container">
      ${row("parent", "你在哪里买的？", "阿洛", true)}
      <button class="show-more">展开更多回复</button>
      <div hidden id="more-replies">
        ${row("purchase", '回复 <span class="nickname">阿洛</span>：广州天河那家，199 元。', "小七", true)}
        ${row("summary", '<a>@点点</a> 帮我总结一下', "小白", true)}
        ${row("recommend", `<a>@点点</a> ${recommendation}`, "小李", true)}
      </div>
    </div>
  </div>
  <div class="parent-comment">
    ${row("subscribe", subscription, "访客")}
    <div class="reply-container">
      ${row("subscription-reply", "收到啦，已帮你订阅每日职场干货。", "点点", true)}
    </div>
  </div>
  <div id="standalone-thread" class="parent-comment">${row("standalone", "加我微信领取资料", "路人")}</div>
  <div class="parent-comment">
    ${row("nested-promo", "加我微信领取资料", "路人", false,
      `<div class="reply-container">${row("nested-keep", "我也想知道原文里的路线", "小白", true)}</div>`)}
  </div>
  <div class="parent-comment">${row("suspected", "我朋友就做这个，有需要来找我", "小羊")}</div>
  <div class="parent-comment">
    ${row("normal", "我用了两个月，防滑还可以", "阿东")}
    <div class="reply-container">
      ${row("only-match", subscription, "小陈", true)}
      ${row("only-keep", "我也用了这双鞋", "小周", true)}
    </div>
  </div>
  <div class="parent-comment">${row("mention", "点点的总结里漏了一条", "五月")}</div>`;

const panel = (title, comments) => `
  <main id="noteContainer">
    <h1 id="detail-title">${title}</h1>
    <div class="comments-el">
      <div class="comments-container"><div class="list-container">${comments}</div></div>
    </div>
  </main>`;

let context;
try {
  const installedChrome = process.env.JEV_CHROME;
  context = await chromium.launchPersistentContext(profile, {
    channel: installedChrome ? undefined : "chromium",
    executablePath: installedChrome,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: installedChrome ? ["--enable-unsafe-extension-debugging"] : [
      "--disable-extensions-except=" + extension,
      "--load-extension=" + extension
    ]
  });
  if (installedChrome) {
    const session = await context.browser().newBrowserCDPSession();
    await session.send("Extensions.loadUnpacked", { path: extension });
    await session.detach();
  }
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 8000 });
  await context.route("https://api.typesafe.ai/**", route => route.abort());
  await context.route(`${site}/**`, route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: new URL(route.request().url()).pathname === noteA ? panel("徒步攻略", firstComments) : "<main>发现页</main>"
  }));
  let siteRequests = 0;
  await context.route(`${commentsAPI}/**`, route => {
    siteRequests += 1;
    const url = new URL(route.request().url());
    const slow = url.searchParams.has("slow");
    const reply = url.pathname.endsWith("/sub/page");
    const folded = url.searchParams.has("folded");
    return route.fulfill({
      headers: { "access-control-allow-origin": site },
      json: {
        success: true,
        data: {
          cursor: "keep-cursor",
          has_more: true,
          comments: slow ? [{ id: url.searchParams.get("slow"), content: "响应超时的推广评论" }] : reply ? [
            { id: "xhr-reply", content: replyOnly }
          ] : folded ? [
            { id: "xhr-folded", content: "加我微信领取资料", sub_comments: [{ id: "xhr-folded-child", content: "谢谢" }] }
          ] : [
            { id: "xhr-promo", content: "加我微信领取资料", sub_comments: [{ id: "xhr-child", content: "谢谢" }] },
            { id: "xhr-normal", content: "徒步注意安全" },
            { id: "xhr-suspect", content: "我朋友就做这个，有需要来找我" },
            ...Array.from({ length: 3 }, (_, i) => ({
              id: `xhr-keep-${i}`, content: i === 2 ? "响应超时的推广评论" : `正常评论 ${i}`
            }))
          ]
        }
      }
    });
  });

  // Mock Jev in the real MV3 worker. No site text or credential leaves the test browser.
  await worker.evaluate(({ recommendation, pendingPromotion, subscription, replyOnly }) => {
    globalThis.mock = { calls: [], active: 0, peak: 0 };
    globalThis.fetch = async (url, request) => {
      const payload = JSON.parse(request.body);
      const { state, questions } = payload;
      const comments = state.comments;
      const auth = request.headers.Authorization;
      mock.calls.push({ url, state, questions });
      mock.active += 1;
      mock.peak = Math.max(mock.peak, mock.active);
      try {
        if (comments.some(row => row.comment === pendingPromotion)) {
          await new Promise(resolve => { mock.finishPending = resolve; });
        } else {
          const slow = "响应超时的推广评论";
          const delay = comments.some(row => row.comment === slow) ? 2300 :
            comments.some(row => row.comment === "旧笔记迟到结果") ? 700 : 85;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        if (auth === "Bearer mock-invalid") return new Response(null, { status: 401 });
        if (auth === "Bearer mock-limit") return new Response(null, { status: 429 });
        if (auth === "Bearer mock-malformed") return Response.json({ answers: {} });

        const answers = {};
        for (const { index, comment } of comments) {
          const prefix = `comment_${index}_`;
          const promotion = comment === "我朋友就做这个，有需要来找我" ? 0.75 :
            ["加我微信领取资料", "旧笔记迟到结果", pendingPromotion, "响应超时的推广评论"].includes(comment) ? 0.95 : 0.10;
          const diandianRequest = ["@点点 帮我总结一下", `@点点 ${recommendation}`, subscription, replyOnly]
            .includes(comment) ? 0.97 : 0.10;
          answers[prefix + "promotion"] = { type: "noul", noul: promotion };
          answers[prefix + "diandianRequest"] = { type: "noul", noul: diandianRequest };
        }
        return Response.json({ answers });
      } finally {
        mock.active -= 1;
      }
    };
  }, { recommendation, pendingPromotion, subscription, replyOnly });
  const waitForRequest = (comment, idle = false) => worker.evaluate(async ({ comment, idle }) => {
    const deadline = Date.now() + 5000;
    while (!mock.calls.some(call => call.state.comments.some(row => row.comment === comment)) || (idle && mock.active)) {
      if (Date.now() > deadline) throw new Error("Expected request did not settle: " + comment);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }, { comment, idle });

  const options = await context.newPage();
  const errors = [];
  options.on("pageerror", error => errors.push(error.message));
  await options.setViewportSize({ width: 375, height: 760 });
  await options.goto(new URL("/options.html", worker.url()).href);
  const key = options.getByLabel("TypeSafe API Key");
  const auto = options.getByRole("checkbox", { name: "打开笔记时自动分析评论" });
  const hide = options.getByRole("checkbox", { name: "隐藏整条命中评论" });
  const save = options.getByRole("button", { name: "保存设置" });
  assert.equal(await auto.isChecked(), false);
  assert.equal(await hide.isChecked(), false);
  await auto.check();
  await save.click();
  await options.getByText("请输入 TypeSafe API Key 后再开启。").waitFor();
  assert.equal(await key.getAttribute("aria-invalid"), "true");
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth), 375);
  await options.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  assert.equal(await options.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), "rgb(19, 30, 28)");

  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", error => errors.push(error.message));
  const logs = [];
  page.on("console", message => {
    if (message.text().includes("[Jev 评论过滤]")) logs.push(message.text());
  });
  await page.goto(site + noteA);
  const promo = page.locator("#comment-promo");
  const promoFold = promo.getByRole("button", { name: "已折叠 · 推广引流 · 展开" });
  const promoCollapse = promo.getByRole("button", { name: "收起 · 推广引流" });
  assert.equal(await promo.locator(".content").isVisible(), true);
  assert.equal(await worker.evaluate(() => mock.calls.length), 0);
  await worker.evaluate(() => chrome.storage.local.set({ settings: { apiKey: "mock-valid", enabled: true } }));
  await options.reload();
  await options.locator("#enabled:checked").waitFor();
  assert.equal(await hide.isChecked(), false);
  await promoFold.waitFor();
  await page.getByText("疑似推广", { exact: true }).waitFor();
  assert.equal(await promo.locator(".content").isVisible(), false);
  assert.equal(await page.locator("#comment-parent .content").isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "展开更多回复" }).isVisible(), false);
  assert.equal(await page.locator("#comment-normal .jev-rednote-label").count(), 0);
  assert.equal(await page.locator("#comment-mention .jev-rednote-label").count(), 0);
  assert.equal(await worker.evaluate(() => mock.peak), 2);

  const subscribe = page.locator("#comment-subscribe");
  const subscriptionReply = page.locator("#comment-subscription-reply");
  const subscriptionFold = subscribe.getByRole("button", { name: "已折叠 · 点点互动请求 · 展开" });
  await subscriptionFold.waitFor();
  assert.equal(await subscriptionReply.isVisible(), false);
  await subscriptionFold.click();
  assert.equal(await subscriptionReply.isVisible(), true);
  await subscribe.getByRole("button", { name: "收起 · 点点互动请求" }).click();
  assert.equal(await subscriptionReply.isVisible(), false);

  const newReplyText = "我试过这条路线，下雨后比较滑";
  await page.locator("#comment-promo + .reply-container").evaluate((existing, html) => {
    const updated = existing.cloneNode(true);
    updated.insertAdjacentHTML("beforeend", html);
    existing.replaceWith(updated);
  }, row("late-reply", newReplyText, "小李", true));
  assert.equal(await page.locator("#comment-late-reply").isVisible(), false);
  await promoFold.press("Enter");
  assert.equal(await promo.locator(".content").isVisible(), true);
  assert.equal(await page.locator("#comment-parent .content").isVisible(), true);
  assert.equal(await page.locator("#comment-late-reply").isVisible(), true);
  assert.equal(await page.locator("#more-replies").isVisible(), false);
  // The site can reveal replies independently of the main comment's treatment.
  await page.locator("#more-replies").evaluate(el => { el.hidden = false; });
  for (const id of ["summary", "recommend"]) {
    const comment = page.locator(`#comment-${id}`);
    assert.equal(await comment.locator(".content").isVisible(), true);
    assert.equal(await comment.locator(".jev-rednote-toggle").count(), 0);
  }
  assert.ok(logs.some(line => line.includes("本次提交")));
  for (const action of ["折叠", "标记", "保留"]) {
    assert.ok(logs.some(line => line.includes(`分析完成 · ${action} ·`)));
  }
  assert.ok(logs.every(line => !/mock-valid|加我微信领取资料|徒步攻略/.test(line)));
  const calls = await worker.evaluate(() => mock.calls);
  assert.ok(calls.flatMap(call => call.state.comments).every(row => ![
    newReplyText, "回复 阿洛：广州天河那家，199 元。", "@点点 帮我总结一下", `@点点 ${recommendation}`
  ].includes(row.comment) && !row.parentComment));

  const summary = page.locator("#comment-summary");
  await promoCollapse.click();
  assert.equal(await summary.isVisible(), false);
  await promoFold.click();
  assert.equal(await summary.locator(".content").isVisible(), true);
  assert.equal(await worker.evaluate(() => mock.calls.length), calls.length);
  await page.locator("#comment-suspected").evaluate((el, html) => { el.outerHTML = html; },
    row("suspected", "我朋友就做这个，有需要来找我", "小羊"));
  await page.getByText("疑似推广", { exact: true }).waitFor();
  assert.equal(await worker.evaluate(() => mock.calls.length), calls.length);

  await page.locator(".list-container").evaluate((el, html) => { el.insertAdjacentHTML("beforeend", html); },
    row("pending", pendingPromotion, "访客"));
  await waitForRequest(pendingPromotion);
  const callsBeforeModeChange = await worker.evaluate(() => mock.calls.length);
  await hide.check();
  await save.click();
  await promo.waitFor({ state: "hidden" });
  await page.locator("#standalone-thread").waitFor({ state: "hidden" });
  assert.equal(await promo.locator(".jev-rednote-toggle").count(), 0);
  assert.equal(await page.locator("#comment-parent").isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "展开更多回复" }).isVisible(), false);
  assert.equal(await subscriptionReply.isVisible(), false);
  assert.equal(await page.locator("#comment-purchase").isVisible(), false);
  assert.equal(await page.locator("#comment-nested-promo").isVisible(), false);
  assert.equal(await page.locator("#comment-nested-keep").isVisible(), false);
  assert.equal(await page.locator("#comment-normal").isVisible(), true);
  assert.equal(await page.locator("#comment-only-match").isVisible(), true);
  assert.equal(await page.locator("#comment-only-keep").isVisible(), true);
  assert.equal(await page.getByText("疑似推广", { exact: true }).isVisible(), true);
  assert.ok(logs.some(line => line.includes("当前笔记整条隐藏 4 条评论。")));

  const hiddenReplyText = "我周末也想试试这条路线";
  const hiddenReply = page.locator("#comment-hidden-reply");
  await page.locator("#comment-promo + .reply-container").evaluate((el, html) => {
    el.insertAdjacentHTML("beforeend", html);
  }, row("hidden-reply", hiddenReplyText, "小李", true));
  assert.equal(await hiddenReply.isVisible(), false);
  await page.locator("#standalone-thread").evaluate(el => {
    const observer = new MutationObserver(() => {
      if (!el.classList.contains("jev-rednote-hidden")) el.dataset.revealedDuringRender = "true";
    });
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    const body = el.querySelector(".content");
    body.replaceWith(body.cloneNode(true));
  });
  await worker.evaluate(() => mock.finishPending());
  await page.locator("#comment-pending.jev-rednote-hidden").waitFor({ state: "attached" });
  assert.equal(await page.locator("#standalone-thread").getAttribute("data-revealed-during-render"), null);
  assert.equal(await worker.evaluate(() => mock.calls.length), callsBeforeModeChange);
  assert.ok(logs.some(line => line.includes("分析完成 · 隐藏 ·")));
  assert.ok(logs.some(line => line.includes("当前笔记整条隐藏 5 条评论。")));

  await options.reload();
  await options.locator("#hide-matched-comments:checked").waitFor();
  await hide.uncheck();
  await save.click();
  await promoFold.waitFor();
  assert.equal(await page.locator("#comment-parent").isVisible(), false);
  assert.equal(await page.locator("#standalone-thread").isVisible(), true);
  assert.equal(await page.locator(".jev-rednote-hidden").count(), 0);
  assert.equal(await worker.evaluate(() => mock.calls.length), callsBeforeModeChange);
  assert.match(logs.filter(line => line.includes("当前笔记整条隐藏")).at(-1), /整条隐藏 0 条评论/);
  assert.equal(await hiddenReply.isVisible(), false);
  await promoFold.click();
  assert.equal(await page.locator("#comment-parent").isVisible(), true);
  assert.equal(await hiddenReply.isVisible(), true);
  assert.equal(await worker.evaluate(() => mock.calls.length), callsBeforeModeChange);

  const lateRow = row("late", "旧笔记迟到结果", "访客");
  await page.evaluate(html => {
    window.addEventListener("scroll", () => {
      document.querySelector(".list-container").insertAdjacentHTML("beforeend", html);
    }, { once: true });
    window.dispatchEvent(new Event("scroll"));
  }, lateRow);
  await page.waitForFunction(() => document.querySelector("#comment-late"));
  await waitForRequest("旧笔记迟到结果");
  const callsBeforeSwitch = await worker.evaluate(() => mock.calls.length);
  await page.evaluate(next => history.pushState({}, "", next), noteB);
  await page.waitForFunction(() =>
    !document.querySelector(".jev-rednote-toggle, .jev-rednote-hidden, .jev-rednote-thread-folded"));
  await page.locator("#detail-title").evaluate(el => { el.textContent = "第二篇"; });
  await page.locator(".list-container").evaluate((el, html) => { el.innerHTML = html; }, row("new", "第一次徒步很开心", "访客"));
  await waitForRequest("第一次徒步很开心", true);
  assert.equal(await page.locator(".jev-rednote-toggle, .jev-rednote-label, .jev-rednote-hidden").count(), 0);
  assert.equal(await worker.evaluate(() => mock.calls.length), callsBeforeSwitch + 1);

  // A note overlay can also appear without a note ID in the URL.
  await hide.check();
  await save.click();
  await page.goto(site + "/explore");
  await page.locator("main").evaluate((el, html) => {
    el.insertAdjacentHTML("afterend", `<div class="note-detail-mask">${html}</div>`);
  }, panel("从发现页打开的笔记", row("overlay", "加我微信领取资料", "路人", false,
    row("overlay-reply", "多谢楼主分享路线", "访客"))));
  await page.locator("#comment-overlay.jev-rednote-hidden").waitFor({ state: "attached" });
  assert.equal(await page.locator("#comment-overlay > .content").isVisible(), false);
  assert.equal(await page.locator("#comment-overlay-reply").isVisible(), false);

  await auto.uncheck();
  await save.click();
  await page.locator("#comment-overlay > .content").waitFor();
  assert.equal(await page.locator("#comment-overlay-reply").isVisible(), true);
  assert.equal(await page.locator(".jev-rednote-toggle, .jev-rednote-hidden").count(), 0);

  for (const [apiKey, message] of [
    ["", "请在扩展设置中填写 TypeSafe API Key。"],
    ["mock-invalid", "TypeSafe 拒绝了请求。"],
    ["mock-limit", "TypeSafe 暂时限流"],
    ["mock-malformed", "Jev 返回了无法读取的结果"]
  ]) {
    await worker.evaluate(key => chrome.storage.local.set({
      settings: { apiKey: key, enabled: true, hideMatchedComments: true }
    }), apiKey);
    await page.getByRole("status").filter({ hasText: message }).waitFor();
    assert.equal(await page.getByRole("status").count(), 1);
    assert.equal(await page.locator("#comment-overlay > .content").isVisible(), true);
  }
  assert.ok(logs.some(line => line.includes("TypeSafe 拒绝了请求")));

  await page.goto(site + noteB);
  await page.locator("main").evaluate((el, html) => { el.outerHTML = html; }, panel("测试响应阶段", ""));
  const responseLogs = [];
  worker.on("console", message => {
    if (message.text().includes("评论响应 ·")) responseLogs.push(message.text());
  });
  await worker.evaluate(() => chrome.storage.local.set({
    settings: { apiKey: "mock-valid", enabled: true, hideMatchedComments: true }
  }));
  await page.getByRole("status").waitFor({ state: "detached" });
  await worker.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (!(await chrome.debugger.getTargets()).some(target =>
      target.url.endsWith("/222222222222222222222222") && target.attached)) {
      if (Date.now() > deadline) throw new Error("Comment debugger did not attach");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  });
  const beforeXHR = await worker.evaluate(() => mock.calls.length);
  const renderXHR = url => page.evaluate(url => new Promise((resolve, reject) => {
    const start = performance.now();
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.onerror = () => reject(new Error("Comment fixture XHR failed"));
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText).data;
      const render = (item, reply = false) => `<div class="comment-item${reply ? " comment-item-sub" : ""}" id="comment-${item.id}"><div class="content">${item.content}</div></div>`;
      const reply = url.includes("/sub/page");
      const list = document.querySelector(reply ? "#comment-xhr-normal + .reply-container" : ".list-container");
      list.insertAdjacentHTML("beforeend", data.comments.map(item => reply ? render(item, true) :
        `<div class="parent-comment">${render(item)}<div class="reply-container">${(item.sub_comments ?? []).map(child => render(child, true)).join("")}</div></div>`).join(""));
      requestAnimationFrame(() => resolve({
        cursor: data.cursor,
        hasMore: data.has_more,
        elapsed: performance.now() - start,
        visible: Object.fromEntries(data.comments.map(({ id }) => [id, Boolean(document.getElementById(`comment-${id}`).getClientRects().length)])),
        folded: Boolean(document.querySelector("#comment-xhr-folded .jev-rednote-toggle")),
        foldedBodyVisible: Boolean(document.querySelector("#comment-xhr-folded .content")?.getClientRects().length),
        foldedChildVisible: Boolean(document.querySelector("#comment-xhr-folded-child")?.getClientRects().length),
        childVisible: Boolean(document.querySelector("#comment-xhr-child")?.getClientRects().length),
        suspectLabeled: Boolean(document.querySelector("#comment-xhr-suspect .jev-rednote-label"))
      }));
    };
    xhr.send();
  }), url);
  const query = `note_id=${noteB.split("/").at(-1)}`;
  const first = await renderXHR(`${commentsAPI}/page?${query}`);
  assert.equal(first.visible["xhr-promo"], false, "promotion must be hidden on the first animation frame");
  assert.equal(first.childVisible, false);
  assert.equal(first.visible["xhr-normal"], true);
  assert.equal(first.visible["xhr-keep-2"], true, "the slow batch should show its original comments");
  assert.equal(first.suspectLabeled, true);
  assert.equal(first.cursor, "keep-cursor");
  assert.equal(first.hasMore, true);
  const reply = await renderXHR(`${commentsAPI}/sub/page?${query}&root_comment_id=xhr-normal`);
  assert.equal(reply.visible["xhr-reply"], true);
  assert.ok(reply.elapsed < 500, "expanding replies should bypass Jev");
  const slow = await renderXHR(`${commentsAPI}/page?${query}&slow=slow`);
  assert.equal(slow.visible.slow, true);
  assert.ok(slow.elapsed >= 1700 && slow.elapsed < 2300, `unexpected timeout latency: ${slow.elapsed}ms`);
  await worker.evaluate(async () => {
    while (mock.active) await new Promise(resolve => setTimeout(resolve, 10));
  });
  assert.equal(await page.locator("#comment-slow").isVisible(), true);
  assert.equal(await page.locator("#comment-xhr-keep-2").isVisible(), true);
  assert.equal(await page.locator(".jev-rednote-status").count(), 0);
  const xhrCalls = await worker.evaluate(start => mock.calls.slice(start), beforeXHR);
  assert.equal(xhrCalls.length, 3);
  assert.ok(xhrCalls.every(({ state }) => state.comments?.length <= 5));
  assert.ok(xhrCalls.flatMap(({ state }) => state.comments).every(row =>
    row.comment !== replyOnly && row.comment !== "谢谢" && !row.parentComment));
  assert.equal(siteRequests, 3);
  assert.ok(responseLogs.some(line => line.includes("超时放行")));
  assert.ok(responseLogs.some(line => line.includes("判断完成 5/6 条")));

  await options.reload();
  await hide.uncheck();
  await save.click();
  await page.locator("#comment-xhr-promo").getByRole("button", { name: "已折叠 · 推广引流 · 展开" }).waitFor();
  assert.equal(await page.locator(".jev-rednote-hidden").count(), 0);
  const folded = await renderXHR(`${commentsAPI}/page?${query}&folded=1`);
  assert.equal(folded.visible["xhr-folded"], true);
  assert.equal(folded.folded, true, "promotion must be folded on the first animation frame");
  assert.equal(folded.foldedBodyVisible, false);
  assert.equal(folded.foldedChildVisible, false);
  assert.ok(responseLogs.some(line => line.includes("判断完成 1/1 条")));
  await hide.check();
  await save.click();
  await page.locator("#comment-xhr-promo").waitFor({ state: "hidden" });
  assert.equal(await worker.evaluate(() => mock.calls.length), beforeXHR + 4);

  const rawXHR = url => page.evaluate(url => new Promise((resolve, reject) => {
    const start = performance.now();
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.onerror = reject;
    xhr.onload = () => resolve(performance.now() - start);
    xhr.send();
  }), url);
  await rawXHR(`${commentsAPI}/page_extra?${query}`);
  await rawXHR(`${commentsAPI}/page?note_id=${noteA.split("/").at(-1)}`);
  assert.equal(await worker.evaluate(() => mock.calls.length), beforeXHR + 4);

  const switching = rawXHR(`${commentsAPI}/page?${query}&slow=switched`);
  await worker.evaluate(async count => {
    const deadline = Date.now() + 4000;
    while (mock.calls.length <= count) {
      if (Date.now() > deadline) throw new Error("Switch test never reached Jev");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }, beforeXHR + 4);
  await page.evaluate(next => history.pushState({}, "", next), noteA);
  assert.ok(await switching < 1500, "switching notes should release the response early");
  await page.locator("#comment-xhr-promo").waitFor({ state: "visible" });

  // Comments mounted by the site can arrive without a captured response.
  await Promise.all([
    page.waitForEvent("console", { predicate: message => message.text().includes("自动分析已开启") }),
    page.goto(site + "/explore")
  ]);
  const hiddenPage = ["page-one", "page-tail"].map(id =>
    `<div class="parent-comment">${row(id, "加我微信领取资料", "访客")}</div>`
  ).join("");
  const firstFrameHidden = await page.evaluate(({ html, next }) => new Promise(resolve => {
    document.body.insertAdjacentHTML("beforeend", html);
    const list = document.querySelector("#fixture-scroller .list-container");
    const tail = document.querySelector("#comment-page-tail");
    const pagination = new IntersectionObserver(([entry]) => {
      if (entry.intersectionRatio < 0.5) return;
      pagination.disconnect();
      list.insertAdjacentHTML("beforeend", next);
    }, { threshold: [0.5, 1] });
    pagination.observe(tail);
    requestAnimationFrame(() => resolve(getComputedStyle(tail).visibility === "hidden"));
  }), {
    html: `<style>#fixture-scroller .comment-item { min-height: 140px; }</style>
      <div id="fixture-scroller" style="height:170px;overflow-y:auto">
        ${panel("评论分页", hiddenPage).replace("<h1", '<div style="height:200px"></div><h1')}
      </div>`,
    next: row("next-page", "第二页的正常评论", "访客")
  });
  assert.equal(firstFrameHidden, true);
  await page.locator(".jev-rednote-hidden").nth(1).waitFor({ state: "attached" });
  const firstPageCalls = await worker.evaluate(() => mock.calls.filter(call => call.state.noteTitle === "评论分页"));
  assert.equal(firstPageCalls.length, 1);
  assert.equal(firstPageCalls[0].state.comments.length, 2);
  const paginationReady = await page.locator("#fixture-scroller").evaluate(el =>
    el.scrollHeight > el.clientHeight && el.querySelector("#comment-page-tail").getBoundingClientRect().height === 1);
  assert.equal(paginationReady, true, "a hidden batch must leave a reachable pagination target");
  await page.locator("#fixture-scroller").hover();
  await page.mouse.wheel(0, 500);
  await page.locator("#comment-next-page").waitFor();
  assert.equal(await page.locator(".jev-rednote-pagination-tail").count(), 0);
  assert.equal(await page.locator("#comment-page-tail").isVisible(), false);

  await page.locator("#fixture-scroller .list-container").evaluate((el, html) => {
    el.insertAdjacentHTML("beforeend", html);
  }, row("dom-timeout", "响应超时的推广评论", "访客"));
  const fallback = page.locator("#comment-dom-timeout");
  await fallback.waitFor({ state: "hidden" });
  await fallback.waitFor({ state: "visible" });
  await worker.evaluate(async () => {
    while (mock.active) await new Promise(resolve => setTimeout(resolve, 10));
  });
  assert.equal(await fallback.isVisible(), true);
  assert.equal(await page.locator(".jev-rednote-status").count(), 0);
  assert.ok(logs.some(line => line.includes("部分评论分析超时，原文已保留。")));
  assert.ok(await worker.evaluate(() => mock.peak <= 3));
  assert.deepEqual(errors, []);
  console.log("Chrome MV3 smoke test passed (isolated profile, mocked Jev).");
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
