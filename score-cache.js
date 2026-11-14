import { SCORE_CACHE_VERSION } from "./jev.js";

const STORAGE_KEY = "commentScoreCache";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const LOAD_BUDGET_MS = 75;

export function scoreCacheKey(noteId, commentId) {
  if (typeof noteId === "string" && noteId && typeof commentId === "string" && commentId) {
    return JSON.stringify([noteId, commentId]);
  }
  return null;
}

function validScore(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function createScoreCache(storage) {
  const entries = new Map();
  let loaded = false;
  let dirty = false;
  let writing = false;

  function prune(now) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) {
        entries.delete(key);
        dirty = true;
      }
    }
    // Insertion order follows the payload order on load and write order afterward.
    while (entries.size > MAX_ENTRIES) {
      entries.delete(entries.keys().next().value);
      dirty = true;
    }
  }

  function persist() {
    if (writing || !dirty) return;
    writing = true;
    setTimeout(async () => {
      try {
        while (dirty) {
          dirty = false;
          await storage.set({
            [STORAGE_KEY]: { version: SCORE_CACHE_VERSION, entries: Object.fromEntries(entries) }
          });
        }
      } catch {
        // Keep memory hits available and retry the snapshot on a later write.
        dirty = true;
      } finally {
        writing = false;
      }
    }, 0);
  }

  const ready = (async () => {
    try {
      const { [STORAGE_KEY]: saved } = await storage.get(STORAGE_KEY);
      if (saved?.version === SCORE_CACHE_VERSION) {
        for (const [key, entry] of Object.entries(saved.entries ?? {})) {
          if (Number.isFinite(entry?.expiresAt) && validScore(entry.scores?.promotion) &&
              validScore(entry.scores?.diandianRequest)) {
            entries.set(key, entry);
          } else {
            dirty = true;
          }
        }
      } else if (saved !== undefined) {
        dirty = true;
      }
      loaded = true;
      prune(Date.now());
      persist();
    } catch {
      // A failed read leaves the persistent cache unavailable for this worker.
    }
  })();

  async function read(keys, deadline = Infinity) {
    if (keys.some(Boolean) && !loaded) {
      const budget = Math.min(LOAD_BUDGET_MS, deadline - Date.now());
      if (budget > 0) {
        let timer;
        await Promise.race([ready, new Promise(resolve => { timer = setTimeout(resolve, budget); })]);
        clearTimeout(timer);
      }
    }
    const now = Date.now();
    return keys.map(key => {
      const entry = entries.get(key);
      return now < deadline && entry?.expiresAt > now ? entry.scores : undefined;
    });
  }

  function write(results) {
    if (!results.length) return;
    void ready.then(() => {
      if (!loaded) return;
      const now = Date.now();
      prune(now);
      for (const { key, scores } of results) {
        if (entries.has(key)) continue;
        entries.set(key, { scores, expiresAt: now + TTL_MS });
        dirty = true;
      }
      prune(now);
      persist();
    });
  }

  return { read, write };
}
