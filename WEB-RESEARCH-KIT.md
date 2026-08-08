# Web Research Kit — 每次调研照这个来

> 一页纸。要长版规则看 `research-discipline-v2.md`。
> 这份是「下次要做什么」，那份是「为什么」。

---

## 1. 复制这段（最短可用版）

```text
/agent-reach

附件：research-discipline-v2.md（按 §4.0 / §4.0.1 / §10 执行）

来源：
- <URL 1>
- <URL 2>

问题：<一句话说清真正想知道什么>

开工前先答：A) 用什么命令取原文？ B) 这些 URL 链出去、承载结论的文件有哪些？
收尾必须给：读取清单表格（URL / 命令 / 原文还是摘要 / 字节数 / 有没有用进结论）。
```

**最后两行是真正起作用的。** 它们把要求放在「选工具」和「读多深」发生的那一刻，
而不是 500 行文档的某处。

竞品选型再加一句：

```text
另：先跑 gh repo view 取 star / pushedAt / 默认分支最后 commit / archived / latest release；
每个 benchmark 数字写清谁测的、什么数据集、怎么算；厂商自测一律标 (self-reported)。
```

---

## 2. 已经装好的机械防线

**`PreToolUse` hook 已生效** —— `~/.claude/hooks/research_raw_fetch_guard.py`，
在 `~/.claude/settings.json` 注册在 `WebFetch` 上。

| URL | 行为 |
|---|---|
| `raw.githubusercontent.com/...` | **拒绝**，并给出 `curl` 命令 |
| 任何 `.md` `.txt` `.json` `.yaml` `.toml` `.csv` `.rst` | **拒绝** |
| `github.com/<o>/<r>/blob/...` | **拒绝**，并给出 raw URL 转换写法 |
| `gist.githubusercontent.com` / `jsdelivr` / `githack` | **拒绝** |
| 普通渲染网页（如 `learn.chatgpt.com/docs/...`） | 放行 |
| 非 WebFetch 的任何工具 | 放行 |

**范围是故意开窄的。** 只拦「原文一条 `curl` 就能拿到」的情况；
JS 重的页面仍然放行，否则只会逼人把 hook 关掉。

出问题要临时关掉：

```powershell
Copy-Item "$env:USERPROFILE\.claude\settings.json.bak-before-research-hook" "$env:USERPROFILE\.claude\settings.json"
```

---

## 3. 四层防线各自能挡什么

| 层 | 挡住 | 挡不住 |
|---|---|---|
| `research-discipline-v2.md` | 提供判断标准 | 什么都强制不了 —— **已实测被违反** |
| 提问模板最后两行 | 把决定放在发问那一刻 | 仍可能被忽略 |
| **PreToolUse hook** | **工具选择，确定性** | **有没有点进链出文件** |
| **读取清单** | 让跳步要么暴露、要么变成明确假话 | 需要你扫一眼 |

**没有任何一层是 100%，四层加起来也不是。**
但它们挡的是不同失效：hook 管工具，模板管注意力，清单管事后核对，文档管判断标准。

---

## 4. 你要盯的两个数字

收到报告后只需要看读取清单：

1. **命令栏** —— 应该是 `curl` / `gh api`。出现 `WebFetch` 就问为什么。
2. **字节数** —— 摘要几百字，原文常常上万。
   `COMPARISON.md` 是 **9,351 bytes**；如果清单写它「读了」却只有几百字节，那就是没读。

**字节数是最难造假的一栏。**

---

## 5. 常用取原文命令

```bash
# GitHub 原文
curl -s "https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>"

# blob URL 转 raw
# https://github.com/o/r/blob/main/docs/x.md
# -> https://raw.githubusercontent.com/o/r/main/docs/x.md

# 列出仓库里值得读的文件（不要猜文件名）
gh api repos/<owner>/<repo>/git/trees/<branch>?recursive=1 --jq '.tree[].path' \
  | grep -Ei 'readme|benchmark|eval|doc|comparison'

# 仓库健康度
gh repo view <owner>/<repo> --json nameWithOwner,stargazerCount,pushedAt,createdAt,isArchived,isFork,primaryLanguage,licenseInfo,latestRelease

# 渲染页全文（JS 重的页面）
curl -s "https://r.jina.ai/<url>"

# 平台后端体检
agent-reach doctor --json
```

---

## 6. 这套东西是被什么逼出来的

2026-08-07，调研 `rohitg00/agentmemory`：

- 用 `WebFetch` 读了一个**本来就是纯文本**的 raw markdown URL；
- 摘要删掉了表格里**每一个 `(self-reported)`**、整段 ⚠️ 免责声明、arXiv 链接和全部超链接；
- 我据此批评对方「没标注数据集来源」—— **原文标得清清楚楚**；
- 同一次还把 obsidian-mind 的 `embeddinggemma-300M` 错安到 agentmemory 头上
  （实际是 `all-MiniLM-L6-v2`）；
- 从头到尾**没点进任何一个链出文件**。

关键在于：`SKILL.md` 当时就在上下文里，明写着 `curl -s "https://r.jina.ai/URL"`。
`research-discipline-v2.md` 的 §5 和 §7 也早就覆盖了这两点。

**规则在，读过了，没照做。** 所以才需要 hook —— 它是唯一不依赖判断力的一层。
