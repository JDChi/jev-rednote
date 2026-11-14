import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SCORE_CACHE_VERSION } from "../jev.js";
import { createScoreCache, scoreCacheKey } from "../score-cache.js";

const scores = { promotion: 0.1, diandianRequest: 0.2 };
const keyFor = id => scoreCacheKey("note", String(id));

function storageWith(saved) {
  const { promise, resolve } = Promise.withResolvers();
  return {
    persisted: promise,
    get: async () => ({ commentScoreCache: saved }),
    set: async value => resolve(value.commentScoreCache)
  };
}

test("prunes expired records and evicts the oldest write at capacity", async () => {
  const expiresAt = Date.now() + 60_000;
  const entries = Object.fromEntries(Array.from({ length: 5000 }, (_, index) =>
    [keyFor(index), { scores, expiresAt }]));
  const expiredKey = keyFor("expired");
  entries[expiredKey] = { scores, expiresAt: Date.now() - 1 };
  const storage = storageWith({ version: SCORE_CACHE_VERSION, entries });
  const cache = createScoreCache(storage);
  const newKey = keyFor("new");

  assert.deepEqual(await cache.read([expiredKey, keyFor(0)]), [undefined, scores]);
  cache.write([{ key: keyFor(1), scores }, { key: newKey, scores }]);
  const saved = await storage.persisted;
  assert.equal(Object.keys(saved.entries).length, 5000);
  assert.equal(saved.entries[expiredKey], undefined);
  assert.equal(saved.entries[keyFor(0)], undefined);
  assert.equal(saved.entries[keyFor(1)].expiresAt, expiresAt);
  assert.ok(saved.entries[newKey].expiresAt >= Date.now() + 7 * 86_400_000 - 1000);
});

test("ignores older classification versions and skips missing IDs", async () => {
  const storage = storageWith({
    version: SCORE_CACHE_VERSION - 1,
    entries: { [keyFor(0)]: { scores, expiresAt: Date.now() + 60_000 } }
  });
  const cache = createScoreCache(storage);
  assert.equal(scoreCacheKey("note", 1), null);
  assert.equal(scoreCacheKey(null, "comment"), null);
  assert.deepEqual(await cache.read([keyFor(0), null]), [undefined, undefined]);
  assert.deepEqual(await storage.persisted, { version: SCORE_CACHE_VERSION, entries: {} });
});

test("storage errors and exhausted lookup budgets return misses", async () => {
  let writes = 0;
  const unavailable = createScoreCache({
    get: async () => { throw new Error("Storage unavailable"); },
    set: async () => { writes += 1; }
  });
  const key = keyFor(0);
  assert.deepEqual(await unavailable.read([key]), [undefined]);
  unavailable.write([{ key, scores }]);
  await delay(0);
  assert.equal(writes, 0);

  const { promise, resolve } = Promise.withResolvers();
  const cold = createScoreCache({ get: () => promise });
  assert.deepEqual(await cold.read([key]), [undefined]);
  resolve({ commentScoreCache: {
    version: SCORE_CACHE_VERSION,
    entries: { [key]: { scores, expiresAt: Date.now() + 60_000 } }
  } });
  assert.deepEqual(await cold.read([key]), [scores]);
  assert.deepEqual(await cold.read([key], Date.now() - 1), [undefined]);
});
