import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { analyzeComments, commentState, SCORE_CACHE_VERSION } from "../jev.js";
import { createScoreCache, scoreCacheKey } from "../score-cache.js";

export const labels = ["promotion", "diandianRequest"];
const mainSplits = ["development", "natural", "challenge"];
const pricePerMillion = 0.042;
const arms = [
  { name: "single", limit: 1, cache: false },
  { name: "batch", limit: 5, cache: false },
  { name: "batch-cache", limit: 5, cache: true }
];

export function loadNotes(source, qualityOnly) {
  const notes = new Map();
  const ids = new Set();
  const texts = new Set();
  const samples = JSON.parse(source);
  const splits = qualityOnly ? [...mainSplits, "popular"] : mainSplits;
  if (!Array.isArray(samples) || !samples.length) throw new Error("样本必须是非空 JSON 数组。");
  for (const sample of samples) {
    const { id, note, split, expected } = sample;
    const state = commentState(sample.state);
    if (typeof id !== "string" || !id || ids.has(id) || typeof note !== "string" || !note || !state || !splits.includes(split) ||
        !labels.every(label => typeof expected?.[label] === "boolean")) {
      throw new Error("样本 ID、笔记、分组、正文和两项人工标注必须完整且有效。");
    }
    const group = notes.get(note) ?? { note, split, title: state.noteTitle, samples: [] };
    if (group.split !== split || group.title !== state.noteTitle) {
      throw new Error(`同一笔记必须属于同一分组，且使用相同标题：${note}`);
    }
    const textKey = JSON.stringify([note, state.comment]);
    if (texts.has(textKey)) throw new Error(`笔记 ${note} 内有重复评论。`);
    texts.add(textKey);
    ids.add(id);
    group.samples.push({ id, expected, state: { noteTitle: state.noteTitle, comment: state.comment } });
    notes.set(note, group);
  }
  for (const split of qualityOnly ? [] : mainSplits) {
    if (![...notes.values()].some(note => note.split === split)) throw new Error(`缺少 ${split} 分组。`);
  }
  return [...notes.values()];
}

export function decision(scores, promotionThreshold = 0.75) {
  if (!scores) return { action: "keep" };
  for (const [threshold, action] of [[0.95, "fold"], [0.75, "mark"]]) {
    const reason = labels.find(label =>
      scores[label] >= (action === "mark" && label === "promotion" ? promotionThreshold : threshold));
    if (reason) return { action, reason };
  }
  return { action: "keep" };
}

const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;

export function measure(rows, promotionThreshold = 0.75) {
  const normal = rows.filter(row => labels.every(label => !row.expected[label]));
  const outcome = {
    count: rows.length,
    failures: rows.filter(row => row.error).length,
    timeouts: rows.filter(row => row.error === "timeout").length,
    normal: normal.length,
    falseMarkRate: ratio(normal.filter(row => row.action === "mark").length, normal.length),
    falseFoldRate: ratio(normal.filter(row => row.action === "fold").length, normal.length),
    labels: {}
  };
  for (const label of labels) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const row of rows) {
      const positive = row.scores?.[label] >= (label === "promotion" ? promotionThreshold : 0.75);
      if (row.expected[label]) positive ? tp++ : fn++;
      else positive ? fp++ : tn++;
    }
    outcome.labels[label] = { tp, fp, fn, tn, precision: ratio(tp, tp + fp),
      recall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn) };
  }
  return outcome;
}

function replay(notes) {
  const holdout = notes.filter(note => note.split !== "development");
  const mixed = holdout.filter((_, index) => index % 3 === 0);
  const phases = [
    ["cold", holdout],
    ["revisit", holdout],
    ["mixed", [...mixed, ...notes.filter(note => note.split === "development")]]
  ];
  return phases.flatMap(([phase, groups]) => groups.map(group => ({ phase, ...group })));
}

export async function runArm(arm, visits, key) {
  let snapshot = {};
  const cache = arm.cache && createScoreCache({
    get: async () => snapshot,
    set: async value => { snapshot = value; }
  });
  const requests = [];
  const rows = [];
  let completed = 0;
  for (const { phase, note, split, samples } of visits) {
    const keys = samples.map(sample => scoreCacheKey(note, sample.id));
    const cached = cache ? await cache.read(keys) : [];
    const results = samples.map((sample, index) => ({
      phase, note, split, id: sample.id, expected: sample.expected,
      cacheHit: Boolean(cached[index]), scores: cached[index]
    }));
    const misses = results.flatMap((row, index) => row.cacheHit ? [] : [index]);
    const batches = [];
    for (let start = 0; start < misses.length; start += arm.limit) {
      batches.push(misses.slice(start, start + arm.limit));
    }
    for (let start = 0; start < batches.length; start += 3) {
      const replies = await Promise.all(batches.slice(start, start + 3).map(async batch => {
        const started = performance.now();
        const result = await analyzeComments(key, batch.map(index => samples[index].state),
          new AbortController().signal, undefined, arm.questionSet);
        return { batch, result, elapsedMs: Math.round(performance.now() - started) };
      }));
      let stopped;
      for (const { batch, result, elapsedMs } of replies) {
        requests.push({ phase, note, ids: batch.map(index => samples[index].id),
          model: result.model, inputTokens: result.inputTokens, error: result.error, elapsedMs });
        if (!result.scores) {
          for (const index of batch) results[index].error = result.error;
          if (["auth", "limited", "unavailable"].includes(result.error)) stopped ??= result.error;
          continue;
        }
        batch.forEach((index, offset) => { results[index].scores = result.scores[offset]; });
        if (cache) cache.write(batch.map(index => ({ key: keys[index], scores: results[index].scores })));
      }
      if (stopped) {
        const finished = results.filter(row => row.scores || row.error);
        return { name: arm.name, requests, rows: [...rows, ...finished.map(row => ({ ...row, ...decision(row.scores) }))], stopped };
      }
    }
    rows.push(...results.map(row => ({ ...row, ...decision(row.scores) })));
    completed += 1;
    if (completed % 10 === 0) console.log(`${arm.name} · ${completed}/${visits.length} 次笔记访问`);
  }
  return { name: arm.name, requests, rows };
}

export function summarize(run) {
  const knownTokens = run.requests.reduce((sum, request) => sum + (request.inputTokens ?? 0), 0);
  const unknownUsage = run.requests.filter(request => request.inputTokens === undefined).length;
  const cost = unknownUsage || run.stopped ? null : knownTokens * pricePerMillion / 1_000_000;
  return {
    name: run.name, stopped: run.stopped, requests: run.requests.length, views: run.rows.length,
    cacheHits: run.rows.filter(row => row.cacheHit).length, errors: run.rows.filter(row => row.error).length,
    knownTokens, unknownUsage, cost, costPerThousand: cost === null ? null : ratio(cost * 1000, run.rows.length),
    models: [...new Set(run.requests.flatMap(request => request.model ? [request.model] : []))]
  };
}

export const percent = value => value == null ? "—" : `${(value * 100).toFixed(1)}%`;
const usd = value => value == null ? "—" : `$${value.toFixed(6)}`;
const reduction = (before, after) => before == null || after == null ? null : ratio(before - after, before);

function markdown(report) {
  const lines = ["# Jev 评论识别与成本评测", "",
    `样本 ${report.samples} 条，来自 ${report.notes} 篇笔记。按顺序处理 ${report.visits} 次评论曝光，其中 ${percent(report.repeatShare)} 为复访。模型以 API 返回版本为准。美元金额按每百万输入 token $0.042 估算。`, "",
    "| 对照组 | 状态 | 请求 | 命中 | 评论失败 | 已知输入 token | 缺用量请求 | 估算费用 | 每千次曝光 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const arm of report.arms) {
    lines.push(`| ${arm.name} | ${arm.stopped ?? "完成"} | ${arm.requests} | ${arm.cacheHits} | ${arm.errors} | ${arm.knownTokens} | ${arm.unknownUsage} | ${usd(arm.cost)} | ${usd(arm.costPerThousand)} |`);
  }
  lines.push("", `返回的版本：${report.arms.map(arm => `${arm.name}=${arm.models.join(", ") || "未知"}`).join("；")}。`);
  lines.push("", "| 对照 | 请求降幅 | 估算费用降幅 | 成功判定中的显示结果差异 |",
    "| --- | ---: | ---: | ---: |");
  for (const item of report.comparisons) {
    lines.push(`| ${item.before} → ${item.after} | ${percent(item.requestReduction)} | ${percent(item.costReduction)} | ${item.changedActions}/${item.scoredPairs} |`);
  }
  const { quality } = report;
  if (!quality) return [...lines, "", "生产批量组未跑完，留出集识别指标待测。", ""].join("\n");
  lines.push("", "识别指标使用无缓存生产批量组首次加载的分数，分类以 0.75 为阈值，失败项按页面保留原文计入。显示误判按实际命中顺序计算。", "",
    "| 留出集 | 分类 | 样本 | 正例 | Precision | Recall | F1 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const [split, metrics] of Object.entries(quality)) {
    for (const [label, result] of Object.entries(metrics.labels)) {
      lines.push(`| ${split} | ${label} | ${metrics.count} | ${result.tp + result.fn} | ${percent(result.precision)} | ${percent(result.recall)} | ${percent(result.f1)} |`);
    }
  }
  lines.push("", ...Object.entries(quality).map(([split, metrics]) =>
    `- ${split} 的普通评论 ${metrics.normal} 条，误标记 ${percent(metrics.falseMarkRate)}，误折叠 ${percent(metrics.falseFoldRate)}。分析失败 ${metrics.failures} 条，其中超时 ${metrics.timeouts} 条。`), "");
  return lines.join("\n");
}

function compare(before, after) {
  const left = summarize(before);
  const right = summarize(after);
  let scoredPairs = 0;
  let changedActions = 0;
  const byVisit = new Map(before.rows.map(row => [JSON.stringify([row.phase, row.id]), row]));
  for (const row of after.rows) {
    const baseline = byVisit.get(JSON.stringify([row.phase, row.id]));
    if (!baseline?.scores || !row.scores) continue;
    scoredPairs++;
    if (baseline.action !== row.action || baseline.reason !== row.reason) changedActions++;
  }
  return { before: left.name, after: right.name,
    requestReduction: left.stopped || right.stopped ? null : reduction(left.requests, right.requests),
    costReduction: reduction(left.cost, right.cost), scoredPairs, changedActions };
}

async function main() {
  const { values } = parseArgs({ options: {
    samples: { type: "string", default: "evaluation/local/samples.json" },
    out: { type: "string" },
    "dry-run": { type: "boolean" },
    "quality-only": { type: "boolean" }
  } });
  const source = await readFile(values.samples, "utf8");
  const qualityOnly = values["quality-only"];
  const notes = loadNotes(source, qualityOnly);
  const visits = qualityOnly ? notes.map(note => ({ phase: "cold", ...note })) : replay(notes);
  const evaluatedArms = qualityOnly ? arms.filter(arm => arm.name === "batch") : arms;
  const exposureCount = visits.reduce((sum, visit) => sum + visit.samples.length, 0);
  const sampleCount = notes.reduce((sum, note) => sum + note.samples.length, 0);
  const splits = [...new Set(notes.map(note => note.split))];
  const cohort = Object.fromEntries(splits.map(split => [split, notes.filter(note => note.split === split)
    .reduce((sum, note) => sum + note.samples.length, 0)]));
  const plannedMaximumCalls = evaluatedArms.reduce((total, arm) => total + visits.reduce((sum, visit) =>
    sum + Math.ceil(visit.samples.length / arm.limit), 0), 0);
  if (values["dry-run"]) {
    console.log(JSON.stringify({ notes: notes.length, samples: sampleCount, cohort, visits: exposureCount, plannedMaximumCalls }, null, 2));
    return;
  }
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) throw new Error("请在评测进程环境中配置 TYPESAFE_API_KEY。");
  const out = values.out ?? join("evaluation/local", new Date().toISOString().replaceAll(":", "-"));
  await mkdir(out);
  const runs = [];
  for (const arm of evaluatedArms) {
    console.log(`实测 ${arm.name}，最多 ${plannedMaximumCalls} 次请求覆盖整场对照。`);
    const run = await runArm(arm, visits, key);
    runs.push(run);
    await writeFile(join(out, `${arm.name}.json`), JSON.stringify(run, null, 2) + "\n");
    if (run.stopped) break;
  }
  const production = runs.find(run => run.name === "batch" && !run.stopped);
  const report = {
    date: new Date().toISOString(), samples: sampleCount, notes: notes.length, cohort,
    samplesSha256: createHash("sha256").update(source).digest("hex"),
    scoreVersion: SCORE_CACHE_VERSION, pricePerMillion, visits: exposureCount,
    repeatShare: ratio(exposureCount - sampleCount, exposureCount),
    arms: runs.map(summarize), comparisons: runs.slice(1).map((arm, index) => compare(runs[index], arm)),
    quality: production && Object.fromEntries(splits.filter(split => split !== "development").map(split => [split,
      measure(production.rows.filter(row => row.phase === "cold" && row.split === split))]))
  };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "report.md"), markdown(report));
  console.log(join(out, "report.md"));
  if (runs.some(run => run.stopped)) process.exitCode = 1;
}

if (import.meta.main) main().catch(error => { console.error(error.message); process.exitCode = 1; });
