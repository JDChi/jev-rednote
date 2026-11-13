import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeComment, analyzeComments, commentState } from "../jev.js";

const controller = new AbortController();
const state = { noteTitle: "广州徒步", comment: "私我拿路线", parentComment: "有路线图吗？" };

test("Jev API responses", async t => {
  await t.test("sends just the requested context and both Noul questions", async t => {
    t.mock.method(globalThis, "fetch", async (url, request) => {
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(request.credentials, "omit");
      assert.equal(request.redirect, "error");
      assert.equal(request.headers.Authorization, "Bearer sample");
      const body = JSON.parse(request.body);
      assert.deepEqual(body.state, state);
      assert.equal(body.model, "jev-latest");
      assert.deepEqual(Object.entries(body.questions).map(([name, question]) => [name, question.type]), [
        ["promotion", "noul"], ["diandianRequest", "noul"]
      ]);
      return Response.json({
        answers: {
          promotion: { type: "noul", noul: 0.95 },
          diandianRequest: { type: "noul", noul: 0.02 }
        }
      });
    });
    assert.deepEqual(await analyzeComment("sample", state, controller.signal), {
      scores: { promotion: 0.95, diandianRequest: 0.02 }
    });
  });

  for (const [status, expected] of [[401, "auth"], [403, "auth"], [429, "limited"], [503, "unavailable"]]) {
    await t.test(`maps HTTP ${status} to ${expected}`, async t => {
      t.mock.method(globalThis, "fetch", async () =>
        new Response(null, { status, headers: { "Retry-After": "5" } }));
      const result = await analyzeComment("sample", state, controller.signal);
      assert.equal(result.error, expected);
      if (status === 429) assert.equal(result.retryAfterMs, 5000);
    });
  }

  await t.test("rejects malformed JSON, absent answers and out-of-range scores", async t => {
    const responses = [
      new Response("invalid json"),
      Response.json({ answers: {} }),
      Response.json({ answers: { promotion: { type: "noul", noul: 1.1 } } })
    ];
    t.mock.method(globalThis, "fetch", async () => responses.shift());
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(await analyzeComment("sample", state, controller.signal), { error: "response" });
    }
  });

  await t.test("distinguishes timeout and navigation cancellation", async t => {
    t.mock.method(globalThis, "fetch", async (_, { signal }) => {
      signal.throwIfAborted();
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const keepAlive = setTimeout(() => {}, 50);
    try {
      assert.deepEqual(await analyzeComment("sample", state, controller.signal, 5), { error: "timeout" });
      const request = new AbortController();
      const result = analyzeComment("sample", state, request.signal);
      request.abort();
      assert.deepEqual(await result, { error: "canceled" });
    } finally {
      clearTimeout(keepAlive);
    }
  });
});

test("bounds comment data and excludes unrelated fields", () => {
  assert.equal(commentState({ comment: " " }), null);
  assert.deepEqual(commentState({ ...state, userId: "local-only", cookie: "local-only" }), state);
  assert.deepEqual(commentState({ comment: "  路线很好走  " }), { noteTitle: "", comment: "路线很好走" });
  assert.equal(commentState({ comment: "字".repeat(3000) }).comment.length, 2000);
});

test("batches named answers while keeping each comment's parent context", async t => {
  t.mock.method(globalThis, "fetch", async (_, request) => {
    const body = JSON.parse(request.body);
    assert.deepEqual(body.state, {
      noteTitle: state.noteTitle,
      comments: [
        { index: 0, comment: state.comment, parentComment: state.parentComment },
        { index: 1, comment: "@点点 帮我总结" }
      ]
    });
    assert.match(body.questions.comment_1_promotion.instructions, /index 为 1/);
    return Response.json({ answers: {
      comment_1_diandianRequest: { type: "noul", noul: 0.98 },
      comment_0_promotion: { type: "noul", noul: 0.96 },
      comment_1_promotion: { type: "noul", noul: 0.03 },
      comment_0_diandianRequest: { type: "noul", noul: 0.01 }
    } });
  });
  assert.deepEqual(await analyzeComments("sample", [state, {
    noteTitle: state.noteTitle, comment: "@点点 帮我总结"
  }], controller.signal), {
    scores: [{ promotion: 0.96, diandianRequest: 0.01 }, { promotion: 0.03, diandianRequest: 0.98 }]
  });
});
