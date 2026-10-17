# 更新记录

## v1.0.0（2026-10-17）

首个版本。6 个技能：

| 技能 | 用途 |
|---|---|
| `agent-diary` | 维护一套「日记／状态／生长记录／APP 版」档案；处理会话交接包 |
| `agent-lookup` | 查资料、找文件、判读截图时的规矩 |
| `agent-machine` | 改本机插件、跑设备命令、动文件系统时的通用规矩 |
| `dsh-plugin-publish` | 把插件发布/更新到 GitHub 之前的私密清单与白名单推法 |
| `dsh-web-healthcheck` | DSH Web GUI 健康检查（页面无反应类问题）＋ 一键全链路自检脚本 |
| `session-log-repair` | 修复 DSH 会话历史日志损坏（seq gap 等） |

每个技能一份 `SKILL.md`（有的带 `scripts/`）。MIT。

---

发布规矩（给自己看）：只推**白名单源码 ＋ 脱敏文档**；本机 patch、绝对路径、密钥、个人语境，一个都不上去。
