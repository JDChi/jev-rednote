# AGENTS.md

## 项目入口

- 本项目是 Chrome Manifest V3 扩展。仓库根目录包含 `manifest.json`，可直接用「加载已解压的扩展程序」安装。
- `comments.js` 从 DOM 提取笔记、主评论及其 ID。`content.js` 管理当前笔记的去重、显示和分页占位。
- `comment-responses.js` 通过 Chrome 调试权限读取笔记的主评论分页响应，并向网页放行原始响应。`background.js` 负责设置、缓存查询和 Jev 请求队列。`jev.js` 定义分类问题和分数校验，`score-cache.js` 管理本地分数缓存。

## 开发约定

- 开启自动分析且已配置 Key 时，折叠和隐藏共用同一套流程。扩展优先读取校验通过的主评论分页响应，无法接管时从 DOM 读取。评论响应最多额外等待约 2 秒。滚动分页、展开回复和发起评论请求由小红书网页负责，分析对象仅限主评论。
- 扩展后台调用 TypeSafe，最多并发 3 个请求，每批最多 5 条。送审的数据为笔记标题、主评论正文和批内编号。API Key 保存在扩展本地设置中，用于请求身份验证。日志仅记录状态、数量、临时编号、分数和耗时。
- 每条主评论按「推广高分 → 点点高分 → 推广疑似 → 点点疑似」取第一个命中，阈值分别是 `0.95` 和 `0.75`。高分默认折叠整串，可在设置中改为隐藏整串。疑似结果只加标签。
- 请求失败或超时时保留原文。切换笔记时丢弃旧页面的在途结果，关闭分析时撤销页面处理。仅切换折叠与隐藏时复用已有分数。修改显示逻辑时，检查笔记弹层、楼中楼、隐藏后的分页和切换笔记。

## 本地缓存

- 缓存位于 `chrome.storage.local` 的 `commentScoreCache`。接口与 DOM 路径共用，`entries` 由 `JSON.stringify([noteId, commentId])` 索引，每条含 `scores.promotion`、`scores.diandianRequest` 和 `expiresAt`。查看缓存可在扩展 Service Worker 的 Console 运行 `await chrome.storage.local.get("commentScoreCache")`。
- 有效期内按 ID 复用两项分数，包括普通评论的低分结果。无稳定 ID 的评论仅在当前笔记会话内去重。缓存写入限于按时通过校验的分数，正文和标题只在当次分析时使用。缓存不可用时走普通分析。
- 分数从写入起保留 7 天，命中不续期。后台启动或写入时清理过期项，超过 5,000 条时优先淘汰最早写入的记录。卸载扩展会清除缓存。

## 验证与打包

- `node --test tests/jev.test.mjs tests/score-cache.test.mjs` 验证 Jev 请求、响应和缓存行为。
- 修改页面读取、显示、缓存或扩展通信时，运行 `node tests/chrome.mjs`。测试使用 Playwright、独立浏览器配置和模拟 Jev 响应。可通过 `PLAYWRIGHT_MODULE` 指定 Playwright 模块路径，用 `JEV_CHROME` 指定本机 Chrome 可执行文件。验证缓存时用实际请求数检查刷新、重开笔记和重启浏览器后的命中。
- 修改模型或分类问题时更新 `jev.js` 的 `SCORE_CACHE_VERSION`，分类场景变化时同步更新 `tests/samples.json`。使用 `node tests/evaluate.mjs` 实测需要 `TYPESAFE_API_KEY`，每条样本会消耗一次 API 调用。
- `python3 scripts/package.py` 将安装 ZIP 写入 `dist/`。新增运行时文件时，同步更新打包脚本的文件清单，并确认解压后的根目录有 `manifest.json`。
- 发布时先推送更新 `manifest.json` 版本的提交，再单独推送对应的 tag。版本为 `0.1.0` 时使用 `v0.1.0`。工作流将安装 ZIP 上传到 Actions 并附到 GitHub Release。用 `gh` 核对运行结果、最新 Release 和安装附件。
