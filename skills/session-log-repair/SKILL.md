---
name: session-log-repair
description: |-
  修复 DSH 会话历史日志损坏。出现 "corrupt session log: seq gap in committed region"、"history unavailable for session"、会话记录/历史打不开、记忆受损等报错或反馈时使用。包含检测、备份、分析、删除过期写入者重叠事件、重建、验证的完整流程和现成脚本。
whenToUse: |-
  系统或用户报告旧会话打不开、历史加载失败、seq 空洞、会话日志损坏时自动执行本流程。
---

# 会话日志修复（session-log-repair）

## 触发特征
- 报错：`corrupt session log: seq gap in committed region at line N (expected X, got Y)`
- 报错：`history unavailable for session "..."`
- 用户说旧会话/记忆打不开、历史丢失、会话记录损坏

## 背景（DSH 会话存储格式）
- 日志位置：`%USERPROFILE%\.dsh\sessions\<规范化cwd目录>\<session-id>\`（Linux/macOS 为 `~/.dsh/sessions/...`）
- **文件名带格式代次**：旧版 `session.jsonl.zstd`，v4 起 `session.v4.jsonl.zstd`（header 里 `version:4`）；同一目录只会有当前代次一个文件，但**全库扫描必须匹配所有代次**，否则新版日志会被整体漏掉（`scan-all.mjs` 已按 `session*.jsonl.zstd` 匹配）
- 物理格式：多个带校验和的 zstd 帧直接拼接；**首帧 = 恰好一行 header**（`{"type":"session","id":...,"cwd":...}`）；其余帧 = 事件行（普通事件行带 `seq`，或打包行 `{"type":"text-chunks|reasoning-chunks|tool-call-chunks","seq0":N,"data":{"texts"/"args":[...]}}`，成员数即事件数，seq 为 seq0..seq0+n-1）
- 后端 load 校验：帧完整+校验和通过；header id 必须等于所在目录名；解码后 seq 必须 0..N-1 连续，有空洞即整体拒绝
- 损坏成因：同一会话被多个写入者并发打开，持有旧游标的过期写入者把与已提交事件 **seq 重叠** 的批次追加到文件尾（物理上帧都完整、尾部自洽，但整体 seq 不连续）

## 修复流程（按顺序执行）
1. **全量扫描定位**：`node scripts\scan-all.mjs "%USERPROFILE%\.dsh\sessions"` → 列出所有损坏日志（覆盖 `session.jsonl.zstd` 与 `session.v4.jsonl.zstd` 等全部代次）及空洞位置
2. **细看空洞上下文**：`node scripts\analyze-gaps.mjs <日志文件>` → 打印每个空洞 ±10 行的 seq/类型
3. **判定要删除的"过期写入者"事件块**：
   - **单空洞重叠型**（典型）：空洞点 `got < expected`。空洞点之前 A 时间线的最后 `expected-got` 个事件是过期尾巴（通常以 `turn/end` + `session/end-seed` 收尾）；空洞点之后 B 从 `got` 继续且更长/更新。→ 删除 A 的那 `expected-got` 个事件，保留 B 完整尾部（删除后 seq 天然连续，无需重编号）
   - **多写入者交错型**：文件里两条时间线交错出现。按内容判定哪条是用户真实续聊（含后续 `user/message` 的才是真实线，往往是最后追加的），删除其余时间线的**全部**行
   - **两段都是真实对话时**（例如两个 app 实例各聊了一段，都写进同一文件）：先按内容/运行时缓存
     （`%USERPROFILE%\.dsh\storages\session_projcache\sessions\<id>.json` 里的 `title` 与 `seq`）判断哪段是
     该会话当前身份，**再问用户**（会丢掉另一段在 UI 里的入口，不可逆）；让位的那段先按第 4 步抢救，不要直接删
   - 判定不确定时**先问用户**，不要猜
4. **抢救另一段时间线（可选，两段都是真实对话时先做这步）**：
   `node scripts\salvage-lines.mjs <源日志> "<保留行范围>" [新会话id]`
   （行号 1-based 含端点、≥2，header 行自动保留；脚本另存为一个全新会话目录：**只改 header 里的 id、
   事件行原样保留、绝不重编号 seq**，并在写出前断言这段本身就是 0..N-1 连续，否则说明行范围选错了）
5. **备份+修复**：`node scripts\repair-generic.mjs <日志文件> "<删除行范围>" <期望最后seq>`（行号为 1-based 含端点，多段用逗号，如 `"88-164,168,176-365"`；脚本自动备份原文件到本技能目录 `backup\`，删除后自动重扫断言 seq 连续）
6. **校验**：`node scripts\final-verify.mjs <日志文件>`（可一次传多个）；再跑一次 `scan-all.mjs` 确认全库无残留
7. **让用户回 Web UI 重开该会话确认**。想自己先验，可用 RPC 证明后端真的读得动：
   `HEAD /api/session.export?sessionId=<id>&includeDescendants=true` 返回 200（导出必须完整读日志）；
   新版 GUI 需带 Cookie，见 `dsh-web-healthcheck` 技能。

## 安全规则（必须遵守）
- 先备份后修改（`repair-generic.mjs` 自动备份到本技能目录 `backup\`；重大修复另存一份到工作目录）
- **绝不重编号 seq、绝不伪造缺失事件**：只删重叠/过期时间线；抢救另一段时间线用 `salvage-lines.mjs`
  （只改 header id，事件原样搬走）
- 修复前确认文件 mtime 已停止变化（该会话不在活跃写入）；正在活跃写入的日志不要动
- 校验必须全绿才算完成；修复失败时从 `backup\` 恢复并重新分析
- Node ≥ 22（内置 zstd）；脚本为 ESM（.mjs），直接用 `node` 运行
- 本技能目录：`%USERPROFILE%\.agents\skills\session-log-repair\`

## 已修复案例
- 2026-08-17：某个会话删 18 个重叠事件（过期尾巴 80261..80278）；另一个会话删 3 个
  （267130..267132）；再一个删 4 个（264786..264789）；还有一个三写入者交错，
  删 268 行过期时间线（782 个事件），保留用户真实续聊（251 个事件）
- 2026-10-01：某个损坏的会话（旧版 `session.jsonl.zstd`）单空洞 `@L715 expected 9997, got 3`，
  但空洞两侧不是"过期尾巴 + 新延续"，而是**两段不同的真实对话**（A 段 0..9996；
  B 段 3..47349，且 app 的 projcache `seq=47349` 认定 B 是当前身份）。
  处理：先 `salvage-lines.mjs 源 "2-714"` 把 A 整段另存为一个新会话（9997 事件，只改 header id），
  再 `repair-generic.mjs 源 "5-714" 47349` 把原会话修成 0..47349 连续（47350 事件）。
  校验：两个文件 `final-verify` 通过、全库 `scan-all`（73 个日志：68 旧版 + 5 v4）零损坏，
  且 `session/list` 能列出新会话、`HEAD /api/session.export` 对两者都返回 200（后端确实读得动）。
  经验：**seq 空洞不等于"过期尾巴"**，先看两侧内容是不是同一段对话，再决定删/抢救。
