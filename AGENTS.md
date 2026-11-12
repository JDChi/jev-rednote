# AGENTS.md

## 项目入口

- 本项目是 Chrome Manifest V3 扩展。仓库根目录包含 `manifest.json`，可直接用「加载已解压的扩展程序」安装。
- `comments.js` 从页面提取笔记、评论及可识别的上级评论。`content.js` 负责分析触发、去重和页面上的标记或折叠。`background.js` 管理请求队列和设置，`jev.js` 定义发给 Jev 的问题并校验响应。

## 开发约定

- 将小红书数据读取限定在网页已经渲染的 DOM。滚动、展开回复和加载评论由小红书网页本身负责。
- 由扩展后台调用 TypeSafe。请求只包含笔记标题、评论正文和可识别的上级评论正文。API Key 保存在扩展本地设置中。Console 日志只记录状态、数量、临时编号和分数。
- 修改评论处理时，检查笔记弹层、楼中楼、滚动加载和切换笔记的行为。请求失败时保留原文，切换笔记时丢弃旧结果，关闭分析时撤销页面处理。

## 验证与打包

- `node --test tests/jev.test.mjs` 验证 Jev 请求格式和响应处理。修改页面读取、展示或扩展通信时，运行 `node tests/chrome.mjs`，用 Playwright 的 Chromium 和模拟 Jev 响应验证浏览器行为。
- 修改分类问题时，将新场景加入 `tests/samples.json`。使用 `node tests/evaluate.mjs` 实测时需要 `TYPESAFE_API_KEY`，每条样本会消耗一次 API 调用。
- `python3 scripts/package.py` 将安装 ZIP 写入 `dist/`。新增运行时文件时，同步更新打包脚本的文件清单，并确认解压后的根目录有 `manifest.json`。
- 发布时先推送更新 `manifest.json` 版本的提交，再单独推送对应的 tag。版本为 `0.1.0` 时使用 `v0.1.0`。用 `gh` 核对 GitHub Actions 的运行结果和 ZIP 产物。
