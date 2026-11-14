<p align="center">
  <img src="icons/icon-128.png" width="72" height="72" alt="小红书评论过滤扩展图标">
</p>

<h1 align="center">小红书评论过滤 · Jev</h1>

<p align="center">打开小红书网页版笔记后，自动识别评论里的推广引流和 @点点 请求。疑似评论会加上标签，高分评论可以折叠或整条隐藏。</p>

<p align="center">
  <a href="https://github.com/JDChi/jev-rednote/releases/latest"><strong>下载扩展</strong></a>
  ·
  <a href="#安装与配置">安装与配置</a>
  ·
  <a href="PRIVACY.md">隐私政策</a>
</p>

## 效果展示

<p align="center"><strong>疑似推广 · 保留评论原文</strong></p>

<p align="center">
  <a href="docs/images/comments-suspected-promotion.png"><img src="docs/images/comments-suspected-promotion.png" width="100%" alt="小红书评论区中，一条评论上方显示黄色的疑似推广标签，原文和回复仍可阅读"></a>
</p>

<p align="center"><strong>左图 · 评论与回复展开时</strong>　｜　<strong>右图 · 整串折叠后</strong></p>

<p align="center">
  <a href="docs/images/comments-expanded.png"><img src="docs/images/comments-expanded.png" width="48%" align="top" alt="展开的点点互动请求及下方的点点回复"></a>
  <a href="docs/images/comments-folded.png"><img src="docs/images/comments-folded.png" width="48%" align="top" alt="折叠后只显示主评论信息和展开按钮，回复已收起"></a>
</p>

## 功能

- **标记疑似评论。** 在评论原文上方显示「疑似推广」或「疑似点点互动请求」标签，正文和回复仍可直接阅读。
- **默认折叠。** 高分命中的评论会折叠正文。主评论折叠时会一并收起整串回复，点「展开」即可查看。
- **整条隐藏。** 开启后，高分命中的主评论连同整串回复一起隐藏。

## 安装与配置

1. 打开 [最新发布](https://github.com/JDChi/jev-rednote/releases/latest)，在 **Assets** 下载 `jev-rednote-v*.zip`。也可以 [下载 main 源码 ZIP](https://github.com/JDChi/jev-rednote/archive/refs/heads/main.zip)。
2. 解压 ZIP，在 Chrome 打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择包含 `manifest.json` 的目录。
3. 按 [TypeSafe 快速入门](https://docs.typesafe.ai/introduction/quickstart) 创建 API Key。点击工具栏中的扩展图标，填入 Key，勾选「打开笔记时自动分析评论」并保存。
4. 打开一篇小红书网页版笔记。安装时已经打开的笔记需要刷新一次。向下滚动加载的主评论也会自动分析，楼中楼回复由网页照常显示。

## 工作原理

```mermaid
flowchart TD
    A["小红书加载主评论"] --> B["扩展优先读取评论响应"]
    B -->|"接管成功"| D["Jev 判断是否推广或在请求点点"]
    B -->|"未接管响应"| C["从页面读取主评论"]
    C --> D
    D --> E["浏览器按分数标记、折叠或隐藏"]
```

开启自动分析后，扩展通过 Chrome 的调试权限读取小红书网页自己发出的主评论请求的响应，最多额外等约 2 秒，再把原始响应交给网页。未接管响应时，扩展从页面读取主评论。判定失败或超时时显示原文。

开启自动分析后，扩展将笔记标题和主评论正文发送给 TypeSafe，批量分析时附带批内编号。API Key 保存在本机的扩展设置中，调用时用于身份验证。分析会计入 TypeSafe API 用量。数据处理与保留方式见 [隐私政策](PRIVACY.md)。
