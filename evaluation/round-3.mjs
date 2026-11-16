import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compare, groupMetrics } from "./round-2.mjs";
import { decision, labels, loadNotes, percent, runArm, summarize } from "./run.mjs";

const names = ["A", "B"];
const mark = 0.75;
const fold = 0.95;
const thresholds = { promotion: [mark], diandianRequest: mark, fold };
const minimum = { promotion: 40, diandianRequest: 22, normal: 100 };
const cumulativeMinimum = { promotion: 50, diandianRequest: 25, normal: 100 };
const descriptions = { promotion: "推广正例", diandianRequest: "点点正例", normal: "普通评论" };
const baseline = "A + 0.75";
const candidate = "B + 0.75";
const digest = text => createHash("sha256").update(text).digest("hex");
const read = (dir, file) => readFile(join(dir, file), "utf8");
const readJson = async (dir, file) => JSON.parse(await read(dir, file));
const save = (dir, file, data) => writeFile(join(dir, file), JSON.stringify(data, null, 2) + "\n", { flag: "wx" });

function counts(samples) {
  return {
    count: samples.length,
    promotion: samples.filter(row => row.expected.promotion).length,
    diandianRequest: samples.filter(row => row.expected.diandianRequest).length,
    normal: samples.filter(row => labels.every(label => !row.expected[label])).length
  };
}

function gaps(actual, required) {
  return Object.entries(required).filter(([key, count]) => actual[key] < count)
    .map(([key, count]) => `${descriptions[key]} ${actual[key]}/${count}`);
}

function verifySources(samples, notes, previousDigests) {
  const byNote = new Map();
  const used = new Set(previousDigests);
  for (const row of samples) {
    const { note, sourceDigest, pageRank, split } = row;
    if (!/^[a-f0-9]{64}$/.test(sourceDigest) || !["natural", "challenge"].includes(split)) {
      throw new Error(`无效的笔记来源或分组：${row.id}`);
    }
    const existing = byNote.get(note);
    if (!existing) {
      if (used.has(sourceDigest)) throw new Error(`笔记来源重复：${note}`);
      used.add(sourceDigest);
      byNote.set(note, { sourceDigest, rank: 0 });
    }
    const entry = byNote.get(note);
    if (entry.sourceDigest !== sourceDigest || pageRank !== ++entry.rank) {
      throw new Error(`笔记来源或评论顺序不一致：${row.id}`);
    }
  }
  if (notes.some(note => note.samples.length !== 10) || new Set(notes.map(note => note.split)).size !== 2) {
    throw new Error("需要日常和定向两组，每篇笔记 10 条主评论。");
  }
}

function requestBatches(notes) {
  return notes.flatMap(({ note, samples }) => {
    const ids = samples.map(row => row.id);
    return [{ note, ids: ids.slice(0, 5) }, { note, ids: ids.slice(5) }];
  });
}

function complete(runs, notes) {
  const batches = requestBatches(notes);
  const samples = notes.flatMap(note => note.samples.map(sample => ({ ...sample, split: note.split })));
  return runs.length === 2 && runs.every((run, index) => run.name === names[index] && !run.stopped &&
    run.requests.length === batches.length && run.requests.every((request, i) =>
      request.note === batches[i].note && JSON.stringify(request.ids) === JSON.stringify(batches[i].ids) && !request.error) &&
    run.rows.length === samples.length && run.rows.every((row, i) => row.id === samples[i].id &&
      row.split === samples[i].split && labels.every(label => row.expected[label] === samples[i].expected[label] &&
        Number.isFinite(row.scores?.[label]) && row.scores[label] >= 0 && row.scores[label] <= 1)));
}

function commonModel(runs) {
  const models = runs.flatMap(run => run.requests.map(request => request.model));
  return typeof models[0] === "string" && models[0] && models.every(model => model === models[0]) ? models[0] : null;
}

export function recommend({ fresh, cumulative, paired, sameModel, comparison }) {
  const reasons = gaps(fresh, minimum);
  reasons.push(...gaps(cumulative ?? fresh, cumulativeMinimum).map(reason => `累计${reason}`));
  if (!paired || comparison?.pairs !== fresh.count) reasons.push("A、B 未完成全部样本的配对评分");
  if (!sameModel) reasons.push("A、B 请求未全部返回同一模型版本");
  if (reasons.length) return { status: "证据不足", choice: baseline, reasons };

  for (const [split, added] of Object.entries(comparison.addedFalse)) {
    if (added.mark || added.fold) reasons.push(`${split} 新增普通误标 ${added.mark} 条、误折叠 ${added.fold} 条`);
  }
  if (labels.some(label => comparison.delta[label] < 0)) reasons.push("至少一类召回下降");
  if (labels.every(label => comparison.delta[label] === 0)) reasons.push("两类召回均持平");
  return reasons.length
    ? { status: "建议保持当前组合", choice: baseline, reasons }
    : { status: "建议采用", choice: candidate, reasons: ["至少一类召回提高，另一类召回未下降，两组均零新增普通误标和误折叠"] };
}

function results(runs, samples) {
  const configurations = runs.map(run => {
    const rows = run.rows.map(row => {
      const { action, reason, ...scores } = row;
      return { ...scores, ...decision(row.scores, mark) };
    });
    return { id: `${run.name} + 0.75`, threshold: mark, rows };
  });
  const byId = new Map(samples.map(row => [row.id, row]));
  const comparison = configurations.length === 2 ? compare(...configurations, byId) : null;
  return {
    counts: counts(samples),
    configurations: configurations.map(({ id, rows }) => ({
      id, groups: groupMetrics(rows, mark)
    })),
    comparison
  };
}

function render(report) {
  const lines = ["# Jev 第三轮评测", "",
    `**${report.recommendation.status}**　${report.recommendation.choice}。`,
    ...report.recommendation.reasons.map(reason => `- ${reason}`), "",
    "两类标记阈值为 0.75，折叠阈值为 0.95。采用建议以新样本的配对变化为准。", "",
    "| 提示词 | 模型 | 请求 | 样本失败 | 样本超时 | 已记录输入 token | 缺用量请求 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.runs.map(run => `| ${run.name} | ${run.models.join(", ") || "未知"} | ${run.requests} | ${run.errors} | ${run.timeouts} | ${run.knownTokens} | ${run.unknownUsage} |`)];
  for (const [title, dataset] of [["新样本", report.fresh], ["第二、三轮累计", report.cumulative]]) {
    if (!dataset) continue;
    const { counts: summary, comparison } = dataset;
    lines.push("", `## ${title}`, "",
      `共 ${summary.count} 条，含 ${summary.promotion} 条推广、${summary.diandianRequest} 条点点请求、${summary.normal} 条普通评论。`, "",
      "| 提示词 | 分组 | 分类 | 命中/正例 | 精确率 | 召回率 | F1 | 普通误标/普通 | 普通误折叠/普通 |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const configuration of dataset.configurations) {
      for (const [split, group] of Object.entries(configuration.groups)) {
        for (const [label, score] of Object.entries(group.labels)) {
          lines.push(`| ${configuration.id} | ${split === "natural" ? "日常" : "定向"} | ${label === "promotion" ? "推广" : "点点"} | ${score.tp}/${score.tp + score.fn} | ${percent(score.precision)} | ${percent(score.recall)} | ${percent(score.f1)} | ${group.falseMarks}/${group.normal} | ${group.falseFolds}/${group.normal} |`);
        }
      }
    }
    if (comparison) {
      const { gains, losses, addedFalse, pairs, changedCount } = comparison;
      lines.push("", `已配对 ${pairs} 条。B 推广命中新增 ${gains.promotion}、丢失 ${losses.promotion}，点点命中新增 ${gains.diandianRequest}、丢失 ${losses.diandianRequest}。`,
        `日常组新增误标 ${addedFalse.natural.mark}、误折叠 ${addedFalse.natural.fold}，定向组新增误标 ${addedFalse.challenge.mark}、误折叠 ${addedFalse.challenge.fold}。显示变化 ${changedCount} 条。`);
    }
  }
  if (!report.cumulative) lines.push("", `累计指标未计算。${report.cumulativeReason}。`);
  lines.push("", "逐条结果和来源见 [changes.json](changes.json)。送审样本见 [samples.json](samples.json)，批内提示词见 [prompts.json](prompts.json)。", "");
  return lines.join("\n");
}

async function main() {
  const { values } = parseArgs({ options: {
    dir: { type: "string", default: "evaluation/local/round-3" },
    previous: { type: "string", default: "evaluation/local/round-2" },
    "dry-run": { type: "boolean" },
    "human-reviewed": { type: "boolean" },
    "prepare-prompts": { type: "boolean" }
  } });
  const { dir, previous } = values;
  const [promptText, priorText, priorExperiment] = await Promise.all([
    read(previous, "prompts.json"), read(previous, "samples.json"), readJson(previous, "experiment.json")
  ]);
  if (!priorExperiment.humanReviewed || digest(promptText) !== priorExperiment.promptsSha256 ||
      digest(priorText) !== priorExperiment.samplesSha256) throw new Error("第二轮提示词或样本指纹与正式运行不符。");
  const prompts = JSON.parse(promptText);
  const variants = names.map(name => ({
    name, limit: 5, cache: false, questionSet: index => prompts[name][index]
  }));
  if (names.some(name => prompts[name]?.length !== 5 ||
      prompts[name].some(questions => !labels.every(label => questions[label]?.type === "noul")))) {
    throw new Error("冻结提示词缺少有效的批内 Noul 问题。");
  }
  if (values["prepare-prompts"]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prompts.json"), promptText, { flag: "wx" });
    return;
  }

  const [source, storedPrompts, sources] = await Promise.all([
    read(dir, "samples.json"), read(dir, "prompts.json"), readJson(dir, "prior-sources.json")
  ]);
  if (digest(storedPrompts) !== digest(promptText)) throw new Error("第三轮提示词与第二轮冻结版不一致。");
  if (!sources.round1?.length || sources.round1.some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("缺少第一轮取样来源摘要。");
  }
  const samples = JSON.parse(source);
  const priorSamples = JSON.parse(priorText);
  const notes = loadNotes(source, true);
  verifySources(samples, notes, [...sources.round1, ...priorSamples.map(row => row.sourceDigest)]);
  const priorIds = new Set(priorSamples.map(row => row.id));
  if (samples.some(row => priorIds.has(row.id))) throw new Error("与第二轮存在重复样本编号。");
  const freshCounts = counts(samples);
  const freshGaps = gaps(freshCounts, minimum);
  const plannedRequests = requestBatches(notes).length * variants.length;
  console.log(JSON.stringify({ ...freshCounts, notes: notes.length, plannedRequests, gaps: freshGaps }));
  if (values["dry-run"]) return;
  if (!values["human-reviewed"]) throw new Error("人工复核后使用 --human-reviewed 运行正式评测。");
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) throw new Error("请配置 TYPESAFE_API_KEY。");

  const [priorReport, ...priorRuns] = await Promise.all([
    readJson(previous, "report.json"), ...names.map(name => readJson(previous, `${name}.json`))
  ]);
  const experiment = { samplesSha256: digest(source), promptsSha256: digest(promptText), humanReviewed: true, plannedRequests, thresholds };
  await save(dir, "experiment.json", experiment);
  const runs = [];
  for (const variant of variants) {
    const run = await runArm(variant, notes.map(note => ({ ...note, phase: "cold" })), key);
    await save(dir, `${variant.name}.json`, run);
    runs.push(run);
    if (run.stopped) break;
  }
  const paired = complete(runs, notes);
  const model = commonModel(runs);
  const previousNotes = loadNotes(priorText, true);
  const compatible = paired && model && model === commonModel(priorRuns) && complete(priorRuns, previousNotes) &&
    priorReport.samplesSha256 === priorExperiment.samplesSha256 &&
    priorReport.thresholds?.promotion?.includes(mark) && priorReport.thresholds.diandianRequest === mark &&
    priorReport.thresholds.fold === fold;
  const fresh = results(runs, samples);
  const cumulative = compatible
    ? results(runs.map((run, index) => ({ ...run, rows: [...priorRuns[index].rows, ...run.rows] })), [...priorSamples, ...samples])
    : null;
  const recommendation = recommend({
    fresh: fresh.counts, cumulative: cumulative?.counts, paired, sameModel: Boolean(model), comparison: fresh.comparison
  });
  const changes = {};
  for (const [name, dataset] of Object.entries({ fresh, cumulative })) {
    if (dataset?.comparison) {
      const { changed, ...summary } = dataset.comparison;
      changes[name] = changed;
      dataset.comparison = { ...summary, changedCount: changed.length };
    }
  }
  const report = {
    ...experiment, model, fresh, cumulative, recommendation,
    cumulativeReason: compatible ? null : "两轮缺少完整的同版本同配置评分",
    runs: runs.map(run => ({ ...summarize(run), timeouts: run.rows.filter(row => row.error === "timeout").length }))
  };
  await save(dir, "changes.json", changes);
  await save(dir, "report.json", report);
  await writeFile(join(dir, "report.md"), render(report), { flag: "wx" });
  console.log(join(dir, "report.md"));
  if (runs.some(run => run.stopped)) process.exitCode = 1;
}

if (import.meta.main) main().catch(error => { console.error(error.message); process.exitCode = 1; });
