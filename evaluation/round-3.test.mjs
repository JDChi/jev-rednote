import assert from "node:assert/strict";
import { test } from "node:test";
import { recommend } from "./round-3.mjs";

const scenario = () => ({
  fresh: { count: 170, promotion: 42, diandianRequest: 23, normal: 105 },
  cumulative: { count: 370, promotion: 52, diandianRequest: 26, normal: 292 },
  paired: true,
  sameModel: true,
  comparison: {
    pairs: 170,
    delta: { promotion: 2, diandianRequest: 0 },
    addedFalse: { natural: { mark: 0, fold: 0 }, challenge: { mark: 0, fold: 0 } }
  }
});

test("recommends B for a recall gain and no new display errors", () => {
  assert.equal(recommend(scenario()).choice, "B + 0.75");
});

test("rejects an improved B if either split acquires a false mark or fold", () => {
  for (const split of ["natural", "challenge"]) {
    for (const action of ["mark", "fold"]) {
      const data = scenario();
      data.comparison.addedFalse[split][action] = 1;
      const result = recommend(data);
      assert.equal(result.choice, "A + 0.75");
      assert.match(result.reasons[0], new RegExp(split));
    }
  }
});

test("keeps A when both recalls tie or one drops", () => {
  const data = scenario();
  data.comparison.delta.promotion = 0;
  assert.deepEqual(recommend(data).reasons, ["两类召回均持平"]);
  data.comparison.delta = { promotion: 2, diandianRequest: -1 };
  assert.deepEqual(recommend(data).reasons, ["至少一类召回下降"]);
});

test("missing scoring pairs and mixed models preclude a conclusion", () => {
  const data = scenario();
  data.comparison.pairs = 169;
  assert.equal(recommend(data).status, "证据不足");
  data.comparison.pairs = 170;
  data.sameModel = false;
  assert.equal(recommend(data).status, "证据不足");
});

test("requires both fresh and compatible cumulative quotas", () => {
  const data = scenario();
  data.cumulative = null;
  assert.equal(recommend(data).status, "证据不足");
  data.cumulative = scenario().cumulative;
  data.fresh.diandianRequest = 21;
  assert.deepEqual(recommend(data).reasons, ["点点正例 21/22"]);
});
