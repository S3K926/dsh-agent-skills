---
name: dsh-plugin-publish
description: 把本机插件发布/更新到 GitHub 之前的规矩 —— 哪些能推、哪些绝对不推（私密信息清单）、怎么脱敏 CHANGELOG、仓库描述别变问号、推完怎么自查。凡是要 push 插件仓库、改仓库描述/README、给插件发版，先读这份。
---

# 推插件到 GitHub

> 立规矩的时间：2026-10-16。起因是一次"把其他插件也推一下"的发布需求，同时定下
> **"一定不能推有私密信息的，推的版本一定是从本机内挑选适合公用的"**，并发现
> `dsh-auto-handoff` 的仓库描述在网页上**全是 `?`**。
> 推上去就进了 git 历史（删不干净），所以**这条路上宁可不推、不可错推**。

## 只有这些是我的（其余别碰）

| 仓库 | 本地源码 | 说明 |
|---|---|---|
| `S3K926/dsh-auto-handoff` | `plugin-src/dsh-auto-handoff` | 自写。档案交接 ＋ 会话切换（2026-09-28 并入 `dsh-session-switch`） |
| `S3K926/dsh-memory-board` | `plugin-src/dsh-memory-board` | 自写。设置页里的记忆面板 |
| `S3K926/dsh-selfwake` | `plugin-src/dsh-selfwake` | 自写。到点主动开口 |
| `S3K926/dsh-session-switch` | —（已并入 auto-handoff） | 仓库保留，代码不再单独更新 |

⛔ **不是我的、绝不推**：`dsh-context`／`dsh-meme`／`dsh-plugin-mgr`／`dsh-recall-plugin`／
`dsh-whale-widget`／`@smalltailqwq/*`（社区或别人写的，改了也只留本机）。
判断依据**看源码出处和 README，不看 `plugin-sources.json` 的"来源"字段**（那一栏说的是安装方式，
拿它当归属依据我已经错过两次）。

## 绝对不推（私密清单）

- ❌ **`cordis.patch.yml`（本机 profile 补丁）** —— 里面有档案根 `<档案根>`、
  设备名 `<设备>`、本机关键词、时差这些**只对本机成立**的值。要进仓库只用 `cordis.patch.example.yml`
  （占位值形态）。
- ❌ 任何 **token／密钥／密码**：`.git-credentials`、`.ds_api_key`、`.bridge_token`、`ghp_*`、
  `github_pat_*`、`sk-*`。推之前跑 `体检.py`（第 4 项会扫密钥**形态**），再肉眼过一遍 diff。
- ❌ **档案数据**：日记／状态／生长记录／事件流／APP 版／`档案/*.zip`（插件目录里本来不该有）。
- ❌ **个人语境**：使用者的原话引语、真名/昵称、本机设备编号、聊天内容截图。
  **CHANGELOG 和 README 是重灾区**（那里面往往写着具体某人的原话）—— 逐行读一遍，
  技术原因留下，私人语境改写成中性说法（"用户提出…" → "有反馈提出…"）。
- ❌ 备份与产物：`*.bak*`、`__pycache__/`、`.dsha-dependencies.json.before-metadata`、临时调试文件。
- ⚠ 路径：本机绝对路径出现时改成占位（`/path/to/archive`、`<档案根>`）。

## 推送流程（每次照做）

1. **备份本地**：`cp -r plugin-src/<插件> /tmp/publish-backup-<日期>/`（改坏了要回得来）。
2. **clone 仓库**到 `/tmp/push/<repo>`（别直接改本机目录里的 .git）。
3. **按白名单更新**：源码（`index.js`／`client.js`／`handoff-*.js`／`lib/`）、`package.json`、
   `README.md`、`LICENSE`、`CHANGELOG.md`（脱敏后）、`test-*.mjs`、`cordis.patch.example.yml`。
   **白名单之外的一律不拷**（省得手滑带出本机 patch）。
4. **`git status` ＋ 逐文件 `git diff` 审一遍** —— 这是最后一道闸。看到不认识的路径/引语就停下。
5. **`git add -A` 后先 `git diff --cached --stat`**，确认文件数符合预期（多出来的一定要看）。
6. commit（版本号 ＋ 一行变更）→ `git push`。
7. **仓库描述**：用 UTF-8 明确书写，别用会被 shell 吃掉的写法 ——
   ```bash
   python3 - <<'PY'
   import json, urllib.request, os
   tok = open('~/.dsh/.git-credentials').read().split('://S3K926:')[1].split('@')[0]
   req = urllib.request.Request('https://api.github.com/repos/S3K926/<repo>',
       data=json.dumps({'description': '中文描述…'}).encode('utf-8'),
       headers={'Authorization': 'token ' + tok, 'Content-Type': 'application/json; charset=utf-8'},
       method='PATCH')
   print(json.load(urllib.request.urlopen(req))['description'])
   PY
   ```
   （2026-10-16 那次变成一排 `?`：描述里的中文是在 **Windows/curl 侧编码**过一道才发的。）
8. **推完自查**：① 用 API 读回 `description` 看是不是中文；② `git ls-tree -r HEAD --name-only`
   列一遍文件，扫有没有 private 文件混进去；③ 浏览器刷新仓库页看 README 中文有没有乱码。

## 有更新就推，别攒

- 每次改完自写插件（CHANGELOG 记了行）就该同步推一次 —— 攒着推的后果：一次要审几百行 diff，
  私密信息更容易漏过去。
- 推完在 `生长/状态.md` 记一笔：**哪个仓库、推到哪个版本、日期**。

## 真亏

- 拿 `plugin-sources.json` 的"来源"判归属 → 把社区插件当自己写的（两次）。
- 中文描述被编码成 `?`（`dsh-auto-handoff` 的仓库描述烂了至少一周）。
- "有 GitHub 链接"≠"是我发布的"；要判归属就去看仓库和 README。
