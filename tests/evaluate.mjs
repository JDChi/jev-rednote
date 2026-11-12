import { readFile } from "node:fs/promises";
import { analyzeComment } from "../jev.js";

const key = process.env.TYPESAFE_API_KEY?.trim();
if (!key) {
  console.error("请在终端设置 TYPESAFE_API_KEY 后再运行。");
  process.exit(1);
}

const samples = JSON.parse(await readFile(new URL("./samples.json", import.meta.url), "utf8"));
const results = [];
for (const sample of samples) {
  const result = await analyzeComment(key, sample.state, new AbortController().signal);
  if (result.error) {
    console.error(`Jev 请求失败（${result.error}）`);
    process.exit(1);
  }
  for (const [question, expected] of Object.entries(sample.expected)) {
    const score = result.scores[question];
    const action = score >= 0.95 ? "折叠" : score >= 0.75 ? "标记" : "保留";
    results.push({
      sample: sample.id,
      question,
      expected,
      score,
      action,
      review: expected && action === "保留" ? "漏判" : !expected && action !== "保留" ? "误判" : ""
    });
  }
}
console.table(results);
