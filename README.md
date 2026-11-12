<p align="center">
  <img src="icons/icon-128.png" width="72" height="72" alt="小红书评论过滤扩展图标">
</p>

<h1 align="center">小红书评论过滤 · Jev</h1>

<p align="center">打开小红书网页版笔记后，自动识别评论里的推广引流和 @点点 请求。高分评论可以折叠，也可以整条隐藏。</p>

<p align="center">
  <a href="https://github.com/JDChi/jev-rednote/actions/workflows/package.yml"><strong>下载扩展</strong></a>
  ·
  <a href="#安装与配置">安装与配置</a>
</p>

## 效果展示

<p align="center"><strong>左图 · 评论与回复展开时</strong>　｜　<strong>右图 · 整串折叠后</strong></p>

<p align="center">
  <a href="docs/images/comments-expanded.png"><img src="docs/images/comments-expanded.png" width="48%" align="top" alt="展开的点点互动请求及下方的点点回复"></a>
  <a href="docs/images/comments-folded.png"><img src="docs/images/comments-folded.png" width="48%" align="top" alt="折叠后只显示主评论信息和展开按钮，回复已收起"></a>
</p>

## 功能

- **默认折叠。** 高分命中的评论会折叠正文。主评论折叠时会一并收起整串回复，点「展开」即可查看。
- **整条隐藏。** 在扩展设置里开启「隐藏整条命中评论」，高分命中的评论会从列表中隐藏，独立的楼中楼回复仍可查看。
- **疑似标签。** 可疑评论保留原文，并标为「疑似推广」或「疑似点点互动请求」。

## 安装与配置

1. 登录 GitHub，在 [自动打包页面](https://github.com/JDChi/jev-rednote/actions/workflows/package.yml) 打开最近一次成功的运行，从 **Artifacts** 下载扩展 ZIP。也可以 [下载 main 源码 ZIP](https://github.com/JDChi/jev-rednote/archive/refs/heads/main.zip)。
2. 解压 ZIP，在 Chrome 打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择包含 `manifest.json` 的目录。
3. 按 [TypeSafe 快速入门](https://docs.typesafe.ai/introduction/quickstart) 创建 API Key。点击工具栏中的扩展图标，填入 Key，勾选「打开笔记时自动分析评论」并保存。
4. 打开一篇小红书网页版笔记。安装时已经打开的笔记需要刷新一次。滚动加载评论或手动展开回复后，新出现的评论也会自动分析。

## 工作原理

```mermaid
flowchart TD
    A["小红书加载评论"] --> B["扩展读取网页里的文字"]
    B --> C["TypeSafe Jev 判断推广和点点请求"]
    C --> D["浏览器标记、折叠或隐藏"]
```

开启自动分析后，扩展会把评论正文、笔记标题和能识别出的直接上级评论正文发送给 TypeSafe。API Key 保存在本机的扩展设置中，分析会计入 TypeSafe API 用量。
