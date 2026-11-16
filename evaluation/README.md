# Jev 评论过滤评测

评测覆盖两类主评论分类和三种请求策略。扩展的页面行为由独立的 Chrome 回归测试验证。

## 本地证据

- `local/samples.json` 是冻结的 300 条脱敏主评论。每条包含样本编号、笔记分组、页面顺序、标题、正文和两项参考标签。边界样本的说明在 `reviewNote`。
- `local/run/` 保存首次正式对照。每组 JSON 含逐请求的输入 token、模型、耗时、错误，以及逐评论分数、缓存命中和显示动作。`report.md` 是汇总，`report.json` 含分母、混淆矩阵和样本 SHA-256。
- 高赞补充样本保存为 `local/popular.json`，用量和分数见 `local/popular-run/`。文件里的点赞和评论数是采集时页面显示值。
- `local/findings.md` 汇总三组对照、高赞补测和简历文案。
- `local/` 由 Git 忽略。样本已去除用户链接、作者字段和可识别联系方式，保留评论语义，方便本地复核。请在此目录回看样本和请求结果。

## 抽样和标注

| 分组 | 样本数 | 用途 |
| --- | ---: | --- |
| development | 60 | 开发检查，作为复访阶段的新评论 |
| natural | 160 | 取推荐页和旅行搜索中选定笔记的已加载主评论，按页面顺序保留 |
| challenge | 80 | 从点点讨论、求房源、留学中介、资料分享和兼职等话题选取边界样本 |

2026-11-16 从公开笔记的已渲染 DOM 读取主评论。评测集按笔记切分。不同分组使用不同笔记，按笔记去除重复文本。自然组来自一次推荐页浏览和一篇旅行搜索笔记，反映这次采样的评论构成。难例组定向覆盖主动揽客、品牌软广、引用点点请求、只艾特点点以及直接向点点交代任务。点赞量抽样作为额外场景单独统计。

参考标签由 Codex 在调用 Jev 之前逐条初标。人工复核状态记录在本地结论中。推广按评论主要目的判定，包括推销、直接揽客或引导私聊。普通购物建议和交流经历按非推广标注。点点互动需要评论直接向点点提出问题或任务，引用、评价和仅艾特为非命中。

## 复跑

先在当前进程环境配置 `TYPESAFE_API_KEY`。密钥通过环境变量读取。

```sh
node evaluation/run.mjs --dry-run
node evaluation/run.mjs --out evaluation/local/rerun
node evaluation/run.mjs --samples evaluation/local/popular.json --quality-only --out evaluation/local/popular-rerun
node --test tests/jev.test.mjs tests/score-cache.test.mjs
node tests/chrome.mjs
```

固定序列包含首次加载、完整复访和带新评论的复访阶段。三组分别使用每次 1 条、每次最多 5 条、每次最多 5 条并启用现有缓存。各组使用生产批量接口的同一套 Noul 判定指令，最多三个请求并发。标签阈值为 0.75，折叠阈值为 0.95。分组内缺少用量字段时，按未完整计量处理。

费用使用实际 API 返回的输入 token，按 TypeSafe 公开价每百万输入 token 0.042 美元换算。结果是同一浏览序列的估算 API 成本，取决于样本和复访比例。页面测试使用模拟 Jev 验证首帧、换页、超时和重启，不计入成本数据。 [TypeSafe 定价](https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost)

## 第二轮提示词与阈值评测

- `local/round-2/round-1-review.md` 汇集首轮问题样本。`review.md` 和 `samples.json` 含新采集的评论和待复核的标签，标签以 `samples.json` 为准。
- A 使用生产问题。B 用 `criteria.true` 和 `criteria.false` 写明边界。`prompts.json` 保存两个版本在每个批内位置的完整问题。
- 人工确认或更正 `samples.json` 后运行下面的命令。评分前记录样本和提示词指纹，已有运行记录会保留。复跑时使用新的结果目录，复制已复核的 `samples.json` 并通过 `--dir` 指定该目录。

```sh
node evaluation/round-2.mjs --dry-run
node evaluation/round-2.mjs --human-reviewed
```

两版对同一批样本各评分一遍。20 篇笔记每篇分两批，共 80 次请求。评分后在本地应用 0.75 和 0.70 两个推广标记阈值。每组新增误标和误折叠按评论逐条比较，避免把新误判和修复的旧误判抵消。报告包含四组指标、成对变化和采用建议。推广正例少于 25 条或普通评论少于 100 条时，报告记为证据不足。

## 第三轮扩大样本验证

- `local/round-3/` 保存脱敏样本、复核表、首轮来源摘要和第二轮冻结的提示词。按笔记 ID 摘要排除前两轮来源，日常组和定向组每篇保留 10 条主评论。
- 新样本至少包含 40 条推广正例、22 条点点请求和 100 条普通评论。累计分别至少 50 条推广、25 条点点请求。两类标记阈值均为 0.75，折叠阈值为 0.95。A、B 按同一笔记和评论顺序评分，每批最多 5 条。
- 运行前先检查候选样本数和预计请求数。人工复核完成后，配置 `TYPESAFE_API_KEY` 再评分。仅合并通过同版本和同配置验证的第二轮分数。采用建议以新样本的配对结果为准。

```sh
node evaluation/round-3.mjs --prepare-prompts
node evaluation/round-3.mjs --dry-run
node evaluation/round-3.mjs --human-reviewed
node --test evaluation/round-3.test.mjs
```

`--prepare-prompts` 在首次创建结果目录时复制并验证冻结提示词。报告和每版分数独立存档。复跑使用 `--dir` 指向新的结果目录，并复制已复核的样本、冻结提示词和 `prior-sources.json`。
