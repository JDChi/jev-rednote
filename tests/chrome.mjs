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
  <div id="standalone-thread" class="parent-comment">${row("standalone", "加我微信领取资料", "路人")}</div>
  <div class="parent-comment">
    ${row("nested-promo", "加我微信领取资料", "路人", false,
      `<div class="reply-container">${row("nested-keep", "我也想知道原文里的路线", "小白", true)}</div>`)}
  </div>
  <div class="parent-comment">${row("suspected", "我朋友就做这个，有需要来找我", "小羊")}</div>
  <div class="parent-comment">${row("normal", "我用了两个月，防滑还可以", "阿东")}</div>
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

  // Mock Jev in the real MV3 worker. No site text or credential leaves the test browser.
  await worker.evaluate(({ recommendation, pendingPromotion }) => {
    globalThis.mock = { calls: [], active: 0, peak: 0 };
    globalThis.fetch = async (url, request) => {
      const payload = JSON.parse(request.body);
      const { state, questions } = payload;
      const auth = request.headers.Authorization;
      mock.calls.push({ url, state, questions });
      mock.active += 1;
      mock.peak = Math.max(mock.peak, mock.active);
      try {
        if (state.comment === pendingPromotion) {
          await new Promise(resolve => { mock.finishPending = resolve; });
        } else {
          await new Promise(resolve => setTimeout(resolve, state.comment === "旧笔记迟到结果" ? 700 : 85));
        }
        if (auth === "Bearer mock-invalid") return new Response(null, { status: 401 });
        if (auth === "Bearer mock-limit") return new Response(null, { status: 429 });
        if (auth === "Bearer mock-malformed") return Response.json({ answers: {} });

        const promotion = state.comment === "我朋友就做这个，有需要来找我" ? 0.75 :
          ["加我微信领取资料", "旧笔记迟到结果", pendingPromotion].includes(state.comment) ? 0.95 : 0.10;
        const diandianRequest = ["@点点 帮我总结一下", `@点点 ${recommendation}`].includes(state.comment) ? 0.97 : 0.10;
        return Response.json({
          answers: {
            promotion: { type: "noul", noul: promotion },
            diandianRequest: { type: "noul", noul: diandianRequest }
          }
        });
      } finally {
        mock.active -= 1;
      }
    };
  }, { recommendation, pendingPromotion });
  const waitForRequest = (comment, idle = false) => worker.evaluate(async ({ comment, idle }) => {
    const deadline = Date.now() + 5000;
    while (!mock.calls.some(call => call.state.comment === comment) || (idle && mock.active)) {
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
  assert.equal(await promo.locator(".content").isVisible(), true);
  assert.equal(await worker.evaluate(() => mock.calls.length), 0);
  await worker.evaluate(() => chrome.storage.local.set({ settings: { apiKey: "mock-valid", enabled: true } }));
  await options.reload();
  await options.locator("#enabled:checked").waitFor();
  assert.equal(await hide.isChecked(), false);
  await promoFold.waitFor();
  await page.getByText("疑似推广", { exact: true }).waitFor();
  assert.equal(await promo.locator(".content").isVisible(), false);
  assert.equal(await page.locator("#comment-parent .content").isVisible(), true);
  assert.equal(await page.locator("#comment-normal .jev-rednote-label").count(), 0);
  assert.equal(await page.locator("#comment-mention .jev-rednote-label").count(), 0);
  assert.equal(await worker.evaluate(() => mock.peak), 3);
  await promoFold.press("Enter");
  assert.equal(await promo.locator(".content").isVisible(), true);
  assert.equal(await worker.evaluate(() => mock.calls.some(call => call.state.comment.startsWith("@点点"))), false);

  // The site mounts or reveals more comments in response to its own controls.
  await page.locator("#more-replies").evaluate(el => { el.hidden = false; });
  for (const id of ["summary", "recommend"]) {
    const comment = page.locator(`#comment-${id}`);
    await comment.getByRole("button", { name: "已折叠 · 点点互动请求 · 展开" }).waitFor();
    assert.equal(await comment.locator(".content").isVisible(), false);
  }
  assert.ok(logs.some(line => line.includes("本次提交")));
  for (const action of ["折叠", "标记", "保留"]) {
    assert.ok(logs.some(line => line.includes(`分析完成 · ${action} ·`)));
  }
  assert.ok(logs.every(line => !/mock-valid|加我微信领取资料|徒步攻略/.test(line)));
  const calls = await worker.evaluate(() => mock.calls);
  const purchase = calls.find(call => call.state.comment.includes("199 元"));
  assert.deepEqual(purchase.state, {
    noteTitle: "徒步攻略",
    comment: "回复 阿洛：广州天河那家，199 元。",
    parentComment: "你在哪里买的？"
  });
  assert.equal(calls.find(call => call.state.comment === "@点点 帮我总结一下").state.parentComment, "加我微信领取资料");
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
  assert.equal(await page.locator("#comment-parent .content").isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "展开更多回复" }).isVisible(), true);
  assert.equal(await page.locator("#comment-summary").isVisible(), false);
  assert.equal(await page.locator("#comment-purchase .content").isVisible(), true);
  assert.equal(await page.locator("#comment-nested-keep .content").isVisible(), true);
  await page.locator("#comment-nested-promo").getByRole("button", { name: "已折叠 · 推广引流 · 展开" }).waitFor();
  assert.equal(await page.getByText("疑似推广", { exact: true }).isVisible(), true);
  assert.ok(logs.some(line => line.includes("当前笔记整条隐藏 4 条评论。")));
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
  assert.equal(await page.locator("#standalone-thread").isVisible(), true);
  assert.equal(await page.locator(".jev-rednote-hidden").count(), 0);
  assert.equal(await worker.evaluate(() => mock.calls.length), callsBeforeModeChange);
  assert.match(logs.filter(line => line.includes("当前笔记整条隐藏")).at(-1), /整条隐藏 0 条评论/);

  await hide.check();
  await save.click();
  await promo.waitFor({ state: "hidden" });
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
  await page.waitForFunction(() => !document.querySelector(".jev-rednote-toggle, .jev-rednote-hidden"));
  await page.locator("#detail-title").evaluate(el => { el.textContent = "第二篇"; });
  await page.locator(".list-container").evaluate((el, html) => { el.innerHTML = html; }, row("new", "第一次徒步很开心", "访客"));
  await waitForRequest("第一次徒步很开心", true);
  assert.equal(await page.locator(".jev-rednote-toggle, .jev-rednote-label, .jev-rednote-hidden").count(), 0);
  assert.equal(await worker.evaluate(() => mock.calls.length), callsBeforeSwitch + 1);

  // A note overlay can also appear without a note ID in the URL.
  await page.goto(site + "/explore");
  await page.locator("main").evaluate((el, html) => {
    el.insertAdjacentHTML("afterend", `<div class="note-detail-mask">${html}</div>`);
  }, panel("从发现页打开的笔记", row("overlay", "加我微信领取资料", "路人")));
  await page.locator("#comment-overlay.jev-rednote-hidden").waitFor({ state: "attached" });
  assert.equal(await page.locator("#comment-overlay .content").isVisible(), false);

  await auto.uncheck();
  await save.click();
  await page.locator("#comment-overlay .content").waitFor();
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
    assert.equal(await page.locator("#comment-overlay .content").isVisible(), true);
  }
  assert.ok(logs.some(line => line.includes("TypeSafe 拒绝了请求")));
  assert.deepEqual(errors, []);
  console.log("Chrome MV3 smoke test passed (isolated profile, mocked Jev).");
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
