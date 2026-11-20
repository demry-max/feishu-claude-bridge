# feishu-claude-bridge

[![version](https://img.shields.io/badge/version-2.3.0-blue)](CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**中文** | [English](README.en.md)

> 🤖 **把这个仓库链接交给 AI agent（Claude Code、Codex 等）安装时，请让它先读 [`AGENTS.md`](AGENTS.md)。**
> 那里有逐步命令、每步的检查方法，以及哪些步骤必须由人来做。

**把 Claude Code 接进飞书** —— 私聊或群里 @机器人，让 Claude 回答问题、看图片、读文件、听语音，并保持上下文连续。无需公网服务器、域名、回调地址：飞书事件走长连接（WebSocket），跑在一台装有 Claude Code 的电脑上即可。

**Chat with Claude Code from Feishu/Lark** — DM the bot or @mention it in groups. Handles text, images, files, voice messages, and rich posts with persistent per-chat sessions. No public server needed: events arrive over Feishu's persistent WebSocket connection, so it runs on any machine with Claude Code installed.

姊妹项目：[lark-claude-bridge](https://github.com/demry-max/lark-claude-bridge)（Lark 国际版，英文文档）· [dingtalk-claude-bridge](https://github.com/demry-max/dingtalk-claude-bridge)（钉钉版，免公网）· [wecom-claude-bridge](https://github.com/demry-max/wecom-claude-bridge)（企业微信版）

## 特性 Features

### 默认就有

- 🔒 **访客隔离**：非 owner 跑在独立工作区、切断用户级配置与 MCP、显式禁用本机工具——碰不到你的记忆，也借不到你的权限
- 🔌 **零公网依赖**：长连接收事件，家用电脑即可部署
- 📲 **扫码即建应用**：`npm run register` 走飞书官方应用注册接口，扫一次码自动创建应用、写入凭据、登记 owner；没有终端交互时（AI agent 代跑）自动分成「打印链接 → 人扫码 → `--resume` 取回」两段
- 🩺 **安装自检与体检**：`npm run setup` 一条命令检查 Node / 依赖 / claude 登录 / `.env` / 必填项并给出下一步；`npm run doctor` 再查工作区、常驻服务、飞书 scope。两者都有 `--json`（程序解析时用 `npm run -s setup -- --json`，否则 stdout 开头带 npm 横幅）和「全绿 / 只差人工 / 失败」三态退出码；启动日志也会自检 scope
- 🧠 **会话记忆**：每个飞书会话映射一个 Claude session（`--resume` 续聊），跨天跨周有效；`/new` 重开，`/status` 查看
- 🗂️ **Agent 工作区**：workspace 内置 CLAUDE.md 人格 + `memory/` 三层长期记忆（画像 USER.md / 事实文件+索引 / journal 流水；纠正、决定、偏好主动落盘，不用等「记住」）+ `skills/` 技能沉淀（说「存成技能」自动生成 SKILL.md 并在后续会话自动加载）
- ⏰ **定时任务（机器人自己排期）**：对它说「每天八点提醒我…」它就写一份任务定义到 `workspace/schedules/`，桥接到点执行并主动推送结果；支持 cron 表达式与一次性时间。**机器人始终没有 Bash/命令执行权限**——它只能写受限目录里的任务定义，执行由桥接负责
- 🩺 **定时任务自诊断**：任务失败自动分析原因并给出建议动作（audit / strict 工具档下改用无工具档，见下）
- ⏱️ **活动式超时与任务控制**：有输出就不计时（长任务不被误杀）；`/cancel` 随时取消、`/redirect` 中断改道
- 🛑 **优雅退出**：收到 SIGTERM / SIGINT 后不接新消息，等进行中的对话、定时任务、心跳做完再退，最多 `SHUTDOWN_GRACE_SEC` 秒（默认 120；macOS launchd 下最多 50，见「优雅退出」）；`npm run install-service` 生成的 plist 已带匹配的 `ExitTimeOut`
- 🛡️ **出站脱敏**：回复送出前抹掉密钥、令牌、JWT 与内网 IP
- 🧷 **压缩前固化记忆**：上下文接近上限时自动提醒机器人把该留的写进 `memory/`，避免自动压缩后细节流失
- 🔀 **模型随时切换**：`/model fable high` 一句话切换模型与思考档，立即生效无需重启；也可设定时自动切换（如早八点切回便宜档）
- 🚦 **聊天/规划与执行分工两个模型**：`CLAUDE_MODEL` 负责平常对话与规划，`CLAUDE_EXEC_MODEL` 负责执行——说「执行」「去做」或发 `/do <任务>` 时下一轮自动切到执行模型，会话上下文保留；定时任务默认走执行模型。留空即关闭分工
- 📄 **飞书文档 / 多维表格 / 电子表格读写**：内置 MCP 工具，用**机器人应用自己的租户权限**，能碰什么由飞书后台 scope 精确控制，仅 owner 可用
- 🖼️ **回传图片与文件**：机器人写进 `workspace/outbox/` 的文件自动上传发送（图片可直接预览）
- 🎫 **进度卡片原地更新**：长任务的阶段说明更新同一张卡片而非刷屏，完成后自动折叠
- 🛂 **访问控制**：`ALLOW_USERS` / `ALLOW_CHATS` 白名单（留空＝不限制）；群聊自动带上发言人姓名
- 🖼️ **多消息类型**：文本 / 图片（Claude 直接看图）/ 文件 / 语音（飞书转写字段 → ffmpeg + 语音识别 API 兜底）/ 富文本 / 合并转发 / 分享卡片
- 🔊 **语音回复**：`/voice` 开启后回答附带语音消息
- 🔐 **权限分级**：owner 由 `npm run register` 扫码时登记（已有应用则用 `npm run setup -- --set-owner` 或在 `.env` 设 `OWNER_OPEN_ID`）；其他成员跑在隔离工作区、只有联网搜索，碰不到主机文件与记忆
- 💰 **用订阅不用 API Key**：通过 `claude -p` 无头模式调用本机 Claude Code 登录态
- 🖥️ **macOS / Linux / Windows**：macOS 用 `npm run install-service`（launchd）；Linux 有 systemd 用户服务示例 [`examples/feishu-claude-bridge.service`](examples/feishu-claude-bridge.service)；Windows 有登录自启脚本（崩溃后不自动重启）

### 可选功能（默认关闭，在 `.env` 打开）

| 功能 | 默认 | 开关 | 详见 |
|---|---|---|---|
| 💓 桥接心跳与交办台账 | 关 | `HEARTBEAT_ENABLED=true`；运行时 `/heartbeat on\|off\|status` | [桥接心跳](#-桥接心跳默认关闭) |
| 🔘 心跳消息按钮（知道了 / 推迟一天 / 不做了） | 关 | `HEARTBEAT_BUTTONS=true`（后台要用长连接接收 `card.action.trigger`） | [owner 对心跳消息的操作](#owner-对心跳消息的操作全部由桥接处理不调模型) |
| ↩️ 引用回复快捷操作 | 关 | `HEARTBEAT_REPLY_SHORTCUTS=true` | 同上 |
| 👀 表情 / 已读 / 撤回事件、未读暂停 | 事件按订阅接收；暂停关 | 后台订阅三类事件；`HEARTBEAT_UNREAD_PAUSE=N` | 同上 |
| 📡 外部增量（群回复、审批状态） | 关 | `HEARTBEAT_WATCH=chat_reply,approval`（需 lark-cli 以 owner 身份登录） | [外部增量](#外部增量heartbeat_watch) |
| ✅ 验收 | 关 | `HEARTBEAT_VERIFY=rule` 或 `rule+model` | [验收、升级阶梯与每晚日结](#验收升级阶梯与每晚日结全部默认关闭) |
| 📈 升级阶梯 | 关 | `HEARTBEAT_ESCALATE_LADDER=true`、`ESCALATE_MAX` | 同上 |
| 🌙 每晚台账日结 | 关 | `HEARTBEAT_DIGEST_AT=HH:MM` | 同上 |
| 🧰 owner 工具档 | `legacy`（与旧版一致） | `OWNER_TOOL_PROFILE=audit`（只记录）/ `strict`（按策略表拦） | [owner 工具档](#owner-工具档owner_tool_profile默认-legacy) |
| 📊 工具审计每日汇总 | audit / strict 下 `21:30` | `TOOL_AUDIT_SUMMARY_AT`（留空关闭） | 同上 |
| 🚧 写文件落点闸、技能 frontmatter 白名单、`.claude` 外来文件隔离 | 随 audit / strict 开启；legacy 不变 | `OWNER_TOOL_PROFILE` | [strict 补洞](#strict-补洞只在-audit--strict-生效legacy-逐字不变) |
| 🩺 定时任务自诊断无工具档 | 随 audit / strict 开启；legacy 不变 | `OWNER_TOOL_PROFILE` | 同上 |
| 📨 忙时连续发消息（owner 私聊排队、合并、接着办） | 关 | `OWNER_MESSAGE_QUEUE=true` | [忙时连续发消息](#-忙时连续发消息排队合并接着办默认关闭) |
| 📅 每日新会话（owner 私聊每天换一次会话，带上交接内容） | 关 | `DAILY_SESSION=shadow`（只记录）/ `on`；运行时 `/session` | [每日新会话](#-每日新会话默认关闭) |
| 🧩 lark-cli（日历、审批、任务、消息检索…） | 关 | `LARK_CLI=true` | [飞书侧能做什么](#-飞书侧能做什么不能做什么) |
| 🔎 业务系统只读查询（bms / ias） | 关 | `BMS_TOOL_ENABLED=1`（只读 Key 放本机钥匙串，仅 macOS） | [业务系统只读查询](#业务系统只读查询bms_tool_enabled默认关闭) |
| 🔁 备用账号（主用额度用完 / 登录失效时自动切换） | 关 | `CLAUDE_FALLBACK_BIN=<备用 claude 路径>` | [备用账号](#-备用账号默认关闭) |

## 快速开始 Quick Start

> 让 AI agent 代装：把仓库链接给它，并让它先读 [`AGENTS.md`](AGENTS.md)。下面是人自己装的最短路径。

**前置条件**

- **Node ≥ 18**。没有 Node 也没有 Homebrew 时，用官方 tarball 免 sudo 安装：

  ```bash
  V=v24.21.0   # 到 https://nodejs.org/dist/ 看最新 LTS；建议同时校验 SHASUMS256.txt
  curl -fsSL -o node.tar.xz "https://nodejs.org/dist/$V/node-$V-darwin-arm64.tar.xz"   # Intel Mac 换 darwin-x64，Linux 换 linux-x64
  mkdir -p ~/.local && tar -xJf node.tar.xz -C ~/.local && mv ~/.local/node-$V-darwin-arm64 ~/.local/node
  echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
  ```

- **Claude Code CLI**，并已登录：

  ```bash
  npm install -g @anthropic-ai/claude-code   # 或按官方文档安装
  claude                                     # 在里面输入 /login，浏览器完成授权（订阅账号）
  ```

- 可选：ffmpeg（语音兜底转写）。

**安装**

```bash
git clone https://github.com/demry-max/feishu-claude-bridge.git
cd feishu-claude-bridge
npm ci
npm run setup          # 自检：没有 .env 就从 .env.example 生成，并列出还缺什么（可反复跑）
```

**飞书应用**：安装过程自动生成，**不用到开发者后台手工创建**

- **默认**：`npm run register`，用飞书 App 扫码，应用自动创建，凭据与 `OWNER_OPEN_ID` 写入 `.env`（走飞书官方应用注册接口）。
  - 结束时会打印一段 scope JSON。到开发者后台打开这个刚生成的应用，「权限管理 → 批量导入」粘贴，然后「版本管理与发布」发布版本。只做一次。
  - 注册接口建出来的应用没有开通 scope：不做这步，文档 / 多维表格工具用不了，聊天不受影响。
  - 国际版 Lark 先在 `.env` 设 `FEISHU_DOMAIN=lark`。
  - 没有终端时（AI agent 代跑）是两段式：`npm run register -- --no-wait` 打印链接，人扫完后 `npm run register -- --resume`。链接没过期时重复 `--no-wait` 只重新打印同一条链接、不会新建应用；确定作废重来加 `--restart`。
- **和 lark-cli 的关系**：lark-cli 的 `lark-cli config init --new`（安装向导里的「配置应用」）走的是同一个注册接口，**每扫一次码就新建一个应用**。所以别两边各扫一次：先让桥接建好应用，再用 `npm run setup -- --link-lark-cli` 把同一个应用交给 lark-cli（Secret 经 stdin 传，不打印）。反过来不行：lark-cli 的 App Secret 存在系统钥匙串里，没有导出命令，setup 只读得到它的 App ID。详见 [AGENTS.md §3](AGENTS.md#3-飞书应用安装过程自动生成)。
- **例外：沿用已有的应用**：把 App ID / App Secret 填进 `.env`，再到开发者后台检查这个应用（不是新建）：
  1. 已添加「机器人」能力；
  2. 事件订阅用「使用长连接接收事件」，并添加 `im.message.receive_v1`；
  3. 批量导入 scope（JSON 见 [AGENTS.md §3B](AGENTS.md#3b-沿用已有的应用例外不扫码)）；
  4. 已发布版本。

  owner 的登记：先 `npm start > bridge.log 2>&1`（`>` 覆盖旧日志，只看本次启动之后），只有你自己私聊机器人一句；再跑 `npm run setup`，日志里只有一个人时它会给出 `npm run setup -- --set-owner ou_…`。有多人私聊过时它不给命令：请别人先别私聊，重启后重做。`.env` 已有别的 owner 时 `--set-owner` 拒绝覆盖，确认要换再加 `--force`。

**验证与常驻**

```bash
npm run doctor         # 体检：全部通过（或只剩 ⚠️）即可
npm start              # 日志出现 [ws] ws client ready 即连上；在飞书私聊机器人发「你好」
npm run install-service     # macOS 开机自启（launchd）
npm run uninstall-service   # 卸载（-- --dry-run 只看判定；plist 属于别的目录时拒绝，确认后加 -- --force）
```

- macOS：`install-service` 用当前 node、本仓库目录与 `which claude` 的结果生成 plist 并立即启动，不用手改占位符。
  - 日志在 `~/Library/Logs/<label>.log`。
  - `LAUNCHD_LABEL` 可指定 label。
  - [examples/launchd.example.plist](examples/launchd.example.plist) 仅供参考。
- Linux：按 [examples/feishu-claude-bridge.service](examples/feishu-claude-bridge.service) 顶部注释装成 systemd 用户服务。
- Windows：`powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1`。
  - 日志在 `bridge.log`。
  - 崩溃后不会自动重启。
- 升级：`git pull && npm ci && npm run setup`，然后重启服务。
- 回滚、卸载、常见故障：见 [AGENTS.md](AGENTS.md) §10–§11。

## 🔒 权限边界（v2.0.0 起）

owner 与其他人跑在**两个物理隔离的工作区**里，这是本项目最重要的安全设计：

| | owner | 其他同事 / 群成员 |
|---|---|---|
| 工作区 | `workspace/`（含长期记忆） | `workspace-guest/`（干净，无记忆导入） |
| 可用工具 | 本机只读 + 联网 + 记忆/技能/任务写入 + 平台文档读写 | **仅联网检索** |
| 配置来源 | legacy 档：完整（含用户级 settings 与 MCP）；audit / strict 档：仅项目级（见下文「owner 工具档」） | 仅项目级：`--setting-sources project` + `--strict-mcp-config` |
| CLI 自动记忆 | 开 | 关（该存储按 git 仓库根归档，不关就是共用一份） |
| 会话 | 按 chat_id | 按 chat_id + 发言人，互不可见 |

- **owner 在群里也按「其他同事 / 群成员」这一列运行**：群聊的回答发给整个群，所以不带 owner 的私密记忆、画像、本机工具与 lark-cli / 飞书工具。owner 的身份只用于桥接命令权限（`/new`、`/model` 等）和提示词里的称呼；会话键与访客同一公式 `guest:<群>:<发言人>`，附件落在 `workspace-guest/incoming/`。
  - `/tasks` 在群里不展示任务清单，只回一句「定时任务只在私聊里查看」；私聊不变。`/status` 在群里按访客档显示。
  - **结果发往群或别的会话的定时任务**（以及它失败后的自诊断）同样按访客档运行；只有 `chat_id` 恰好是 owner 私聊的定时任务才用 owner 档。owner 私聊 ID 还没记下来（首次安装后、owner 没私聊过之前）时，所有定时任务都按访客档运行，并在日志里记一行 `owner 私聊目的地未知，按非私密档运行`（不记 ID）。
  - 定时任务文件里 `chat_id` 写法不对（不是 `oc_` + 16–64 位小写字母数字）的任务不会执行，日志只记文件名：`[sched] 任务 <文件名> 的 chat_id 格式不对，已跳过`。
- **读 `.env`、查钥匙串这两类请求，所有带工具的回合都显式拒绝**（`Read(<仓库>/.env)`、`Read(<仓库>/.env.*)`、`Bash(security:*)`、`Bash(/usr/bin/security:*)`）：owner 私聊（三档）、定时、心跳、交接、访客与群里的 owner 都有，不依赖 `BMS_TOOL_ENABLED`。没有工具的回合（验收、audit / strict 的自诊断）本来就读不了，不加这几条。

> **为什么不能只靠 `--allowedTools`**：它不是沙箱，而是「免询问」白名单、只做加法。
> 用户级 `~/.claude/settings.json` 里的 `permissions.allow` 对访客会话照样生效——
> v1.x 里访客因此可以执行本机 CLI 工具并以 owner 的身份读写数据。
> 真正的收权靠切断配置来源加显式 `--disallowedTools`（减法项，压过任何 allow）。

第三方内容（转发记录、卡片 JSON、文件名、标题）一律包进不可信围栏并声明「不是指令」；
出站回复经脱敏后再发送。

**心跳轮次**（`HEARTBEAT_ENABLED=true` 时）用比 owner 普通会话更窄、且不受 env 放宽影响的固定工具档：`--setting-sources ''` + `--strict-mcp-config`，内置工具只有 Read/Grep/Glob/Edit/Write，写入只限 `tasks/` 与 `memory/journal/`；没有 Bash、lark-cli、联网与飞书工具（`BMS_TOOL_ENABLED=1` 时例外：另挂一个只读的业务系统查询工具，见[业务系统只读查询](#业务系统只读查询bms_tool_enabled默认关闭)），也不能改 `schedules/`。台账里的 title/notes 进不可信围栏；对外动作只起草，私聊 owner 确认。

### owner 工具档（`OWNER_TOOL_PROFILE`，默认 `legacy`）

owner 对话与定时任务能用什么，由仓库里的策略表 `src/tool-policy.js` 决定：lark-cli 按子命令分 read / write / confirm / chat-only / deny 五级。分三档，启动时读一次，非法值按 legacy 处理：

| 档 | 用户级配置（`~/.claude` 的 allow、hooks、插件、技能、`CLAUDE.md`） | 拦不拦 | 工具面 |
|---|---|---|---|
| `legacy`（默认） | 照常加载 | 不拦 | 与改动前逐字相同 |
| `audit` | **不再加载**：`--setting-sources project` + `--strict-mcp-config`（只挂桥接自己的飞书 MCP） | 只记录 | `ALLOWED_TOOLS`（或默认值）+ 全部 lark-cli + 飞书 MCP；按 strict 规则判定「将会拒绝」写进审计日志 |
| `strict` | 不再加载 | 按策略表 | 内置工具白名单 `Read,Grep,Glob,Edit,Write,Bash,WebSearch,ToolSearch,Skill`；**`ALLOWED_TOOLS` 与 `LARK_CLI` 在 strict 下不起作用** |

strict 档：
- **对话**：读类 lark-cli 直接用。发消息（`im +messages-send` / `+messages-reply`）、导入云文档（`drive +import`）、建日程（`calendar +create`）直接执行，回复末尾附一行「— 本轮以你名义：…」回执（目标 ID 只显示末 4 位；**回执只在和 owner 的私聊里附，群聊不附**）。回邮件、审批操作、撤回消息、建群改群、增删群成员先起草；owner 私聊里以「确认」或 `/confirm` 开头的那一轮才放行，只管这一轮，群聊里不生效。
- **定时任务**：只读，没有例外开关。lark-cli 只放行读类子命令，飞书 MCP 只有 6 个读工具，文件只能写 `memory/`、`outbox/`；任务文件里的任何字段都不参与权限判定。
- **一律拒绝**：WebFetch、Agent / Task 子代理、CLI 内置的账号级工具、`lark-cli api`、`lark-cli auth logout`、codex / nohup / npx、写 `OWNER_STRICT_DENY_WRITE_DIRS` 列出的目录（逗号分隔的绝对路径，默认空；不能是 `/`、家目录、桥接目录或它们的上级，也不能与工作区重叠，不合格的逐条忽略并告警）；Edit / Write 工具不能改工作区的 `CLAUDE.md` 与 `.claude/`，strict 对话也不放 `Edit/Write(./skills/**)`（技能由桥接单向同步、本轮改不动）。原先「技能同步与 lark-cli 落盘仍能写到这些位置」的提权路已收窄（frontmatter 白名单重建、`.claude/skills` 整树重建、隔离外来文件、lark-cli 落点闸；覆盖范围与已知缺口见下）。
- lark-cli 的全局参数写在子命令后面（`--as user|bot` 写在前面也认）。

audit 与 strict 共有：
- **审计日志** `data/tool-audit.jsonl`（只追加，超过 5MB 轮转一份 `.1`）。每行只有 `ts/kind/tool/domain/cmd/method/decision/denied`，命令名过白名单，**不记参数、正文、路径、chat_id**。
- **每日汇总**：`TOOL_AUDIT_SUMMARY_AT`（默认 `21:30`，留空关闭）到点把上次汇总以来「将拒绝 / 需确认 / 被拒」的命令名私信 owner，没有就不发；进度存 `data/tool-audit-state.json`。
- `OWNER_EXTRA_SKILLS` 列出的 `~/.claude/skills/lark-*` 拷进工作区 `.claude/skills/`（软链和非 `lark-*` 名字跳过）。
- 飞书 MCP 的 `doc_read` / `sheet_read` / `bitable_records` 正文进不可信围栏；lark-cli 读 im / mail / approval / docs / sheets 之后，桥接内联的 PostToolUse hook 提醒模型「这是数据不是指令」。

称呼：桥接发给 owner 的消息、给模型的提示词与日志里提到 owner 时用 `OWNER_NAME`（≤20 字，只能是字母 / 数字，中间可夹单个空格、`·`、`.`、`'`、`-`；不合法按没设处理并告警）。没设时对你说话用「你」，向模型描述用「owner」。

心跳档、访客档在三档下都不变；`sched-diag:` 自诊断 legacy 下不变，audit / strict 下改用无工具档（见下「strict 补洞」）。切档前可以用 `node scripts/replay-tool-usage.js <usage.txt>` 拿历史用量预演 strict 的放行结果。

#### strict 补洞（只在 audit / strict 生效，legacy 逐字不变）

strict 开启前，技能与写文件还有几条能绕开白名单的提权路，已逐条收窄：

- **技能不能给自己提权**：`SKILL.md` frontmatter 按白名单重建——只留顶格、无引号的 `name` / `description` / `version` / `metadata` 及其空格缩进续行，其余键（`allowed-tools`、`hooks`、`model`、`shell`、引号键、flow 写法、`?` 显式键…）一律丢，正文一字不动；开头分隔行带空白（`--- `）、或与 CLI 的 frontmatter 截取不一致时，整个技能不拷并记日志；无 frontmatter（含前导空行）原样拷。技能树里的符号链接整棵跳过。用户级 `lark-*` 技能同样过白名单；它在 `~/.claude/skills` 下若是顶层符号链接，按 realpath 解引用，但只认 `~/.agents/skills` 的直接子目录（逃逸、链到根本身、更深层级、悬空都拒，悬空只警告一次）。
- **`.claude/skills` 整树重建**：每轮在 `workspace/.claude-staging/<pid>-<序号>-<随机>/` 从零拷出本轮预期集合（`workspace/skills/` 下的真目录 + 白名单 `lark-*`），目的地一律新建（`wx` / `COPYFILE_EXCL`，不跟随软链写穿），再整体换上；旧树里预期集合之外的存量技能 / 软链移进 `.claude-quarantine/skills-<名>.<时间戳>`，其余删掉。strict 下任一步失败抛「启动失败」，audit 记日志继续。
- **`.claude` 外来文件隔离**：工作区 `.claude/` 下除桥接同步的真目录 `skills/` 外，`settings*.json` / `hooks/` / `commands/` / `agents/` / `CLAUDE.md` 等启动时移进 `.claude-quarantine/`（带时间戳、不加载也不删）；`.claude` 本身是软链或文件时只挪链接本身（不跟随），再建真目录。`.claude-quarantine` / `.claude-staging` 存在却不是真目录算隔离失败。strict 下隔离失败抛「启动失败」（不重试、本轮不跑）；audit 兜底继续并记日志。
- **写文件落点闸**：`lark-cli` 读类命令带 `--output` / `-o` / `>` / `>>` / `| tee` 时，落点只能在 `outbox/` 或系统临时目录；写 `.claude/`、`CLAUDE.md`、`schedules/`、`skills/`、`tasks/`、`.mcp.json` 一律拒（audit 记「将会拒绝」），`../` 与软链逃逸按物理路径判。`drive +download`、`im +messages-resource(s)-download` 不带 `--output` / `-o` 时按「写当前目录」判、`--download-resources` 按写 `./lark-im-resources/` 判：只有会话 cwd 已在 outbox 里，或命令以 `cd outbox/<轮> && …` 这种确定生效的 `&&` 链开头才放行，下载请显式写 `--output ./outbox/<本轮目录>/文件名`。内联 PreToolUse 钩子 `src/hooks/output-guard.js` 在缺 workspace / 坏输入 / 判定异常 / 判定模块加载失败 / 未捕获异常 / 读 stdin 超时时都 `exit 2` 挡下，不输出 allow。
- **`--as=` 前置写法**：`lark-cli --as=user …` 不会命中 strict 生成的 `--as user` / `--as bot` 规则，审计判定（audit 预演 / strict 对账）也一律记 deny。
- **排查诊断（sched-diag）无工具**：`--setting-sources ''` + `--strict-mcp-config` + `--tools ''`，`job.prompt` 与报错进不可信围栏。
- **群聊不附回执**：以 owner 名义的回执只在私聊附，群聊不附（群里的写动作仍记审计）。
- **sched-diag 任务名**：audit / strict 下任务名压成单行、限 80 字，不能借换行伪造新段落。

**未覆盖 / 待验证**（不要当成已封堵）：

- 系统临时目录（`/tmp`、`$TMPDIR`）整体放行，落点闸不细分其中路径；
- 内联 shell（`bash -c`、`eval`、`$(…)` 里的写文件）只做了尽力解析，阻断效果待真机 smoke；
- 钩子超时（CLI 侧 5 秒）时 CLI 的实际放行 / 拒绝行为待真机 smoke；
- 用户级技能软链目标在 `~/.claude/skills` 根下（而非 `~/.agents/skills`）时暂不拷，待确认。

### 业务系统只读查询（`BMS_TOOL_ENABLED`，默认关闭）

打开后 owner 多一个 MCP 工具 `mcp__biz__biz_get`，只读查询两个内部业务系统：

- `bms`：业务管理系统（工单、客户、线索、合同、收款、付款申请、提成、看板）。
- `ias`：财务会计系统（看板、报表、应收应付、往来明细、收支流水）。

主机、路径前缀、钥匙串条目名都写死在 `src/biz-targets.js`，没有任何环境变量能改。

| 有这个工具 | 没有 |
|---|---|
| owner 私聊、结果发往 owner 私聊的定时任务（strict 的只读定时任务也有）、心跳 | 群聊（owner 在群里也没有）、结果发往群或其他会话的定时任务、目的地判断不出的定时任务、访客、sched-diag 自诊断、验收、交接 |

- **定时任务看目的地**：定时任务的 `chat_id` 恰好等于 owner 私聊的会话 ID 时才有这个工具。桥接在 owner 第一次私聊机器人时学到这个 ID，写进 `data/owner-dm.json`（0600，同时记下 owner 的 open_id），重启后直接读回，不用再私聊一次；所以只有**首次安装后**、owner 还没私聊过之前，定时任务都没有这个工具。
  - 读回时 owner 与当前配置（`OWNER_OPEN_ID` 或 `data/owner.json`）不一致、文件损坏或格式不对，都按「未知」处理，等 owner 再私聊一次。
  - 启动日志有一行 `[biz] owner 私聊目的地：已从落盘恢复` 或 `未知（等 owner 私聊一次）`；owner 私聊里 `/status` 多一行「owner 私聊目的地: 已知（来自落盘 / 本次会话）/ 未知」。都不显示 ID 本身。
  - 这个文件与 `BMS_TOOL_ENABLED` 无关，开关关着时也照常记。
- **开关**：`.env` 里 `BMS_TOOL_ENABLED=1`，只认恰好 `1`，改完重启。三个工具档下都生效。关着时，所有轮次都不挂 `mcp__biz__biz_get`、不装 biz-readonly 技能，参数里没有任何与这个工具相关的项；下面「`.env` 拒读」那 4 条拒绝规则不随这个开关，开关关着时也照常在。
- **只能 GET**，不跟随重定向。
  - 路径先归一化再核对前缀。`..`、`//`、`\`、`@`、`%` 编码、完整 URL 一律拒绝。
  - 密钥管理、登录认证、导出、文件下载、凭证类路径也拒绝。
  - query 是结构化的键值，不拼原始查询串。分页 `limit` 超过上限会被截回（bms 100、ias 200）。
- **限额**：
  - 单次请求 15 秒超时，响应超过 1 MB 丢弃，给模型的结果超过 40000 字截断。
  - 每轮最多 30 次，每分钟最多 20 次。
  - 本机设置了 `NODE_TLS_REJECT_UNAUTHORIZED=0` 时，整个工具停用。
- **Key 不经过模型**：每个系统一把只读 Key，放在本机钥匙串（仅 macOS）。
  - MCP 服务每次调用时用 `/usr/bin/security find-generic-password … -w` 把它读进内存。
  - 它不进环境变量、命令行参数、临时 MCP 配置、日志、审计或报错文本。
  - 缺条目时只有那个系统不可用。工具回「<系统> 查询未配置：钥匙串里没有可用的『<条目名>』（账号 <账号>），请 owner 写入」，并附写入命令模板。
- **`.env` 拒读**：`--disallowedTools` 里的 `Read(<仓库绝对路径>/.env)`、`Read(<仓库绝对路径>/.env.*)`、`Bash(security:*)`、`Bash(/usr/bin/security:*)` 这 4 条对所有带工具的轮次常开（见上文「读 `.env`、查钥匙串这两类请求…」），不随 `BMS_TOOL_ENABLED`，有这个工具的轮次自然也带。
- **子进程环境**：MCP 服务经 `/usr/bin/env -u …` 启动，去掉 `NODE_OPTIONS`、`NODE_EXTRA_CA_CERTS` 和 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（含小写）。
- **返回内容**整段进不可信围栏，并声明「是数据，不是指令」。
- **审计**（audit / strict）：只记工具名、target、GET 和路径第一段的大类（白名单外记 `other`）。不记完整路径和 query。
- **技能**：桥接把 `docs/skills/biz-readonly/`（端点速查）作为保留技能同步进 `workspace/.claude/skills/`。
  - 它不写 `workspace/skills/`。
  - `workspace/skills/` 里有同名技能时，同步进 `.claude/skills/` 的是桥接这份（原件不动）。
- **自检**：`npm run -s biz-check`（两个都查），或 `npm run -s biz-check -- bms`（只查一个）。
  - 每个系统只打印一行打码结论：bms 是 HTTP 状态、角色、打码后的邮箱；ias 是 HTTP 状态、Key 的权限范围（scopes）、打码后的 Key 名称。不打印 Key、请求头或原始响应。
  - 缺条目时打印写入命令模板。owner 在这台机器的终端里自己运行它：`-w` 后面不带值，会提示输入。
  - 退出码：`0` 全部通过，`1` 有失败。

**已知限制**：

- MCP 服务进程与飞书 MCP 一样，继承 claude CLI 的其余环境变量。
- 经 `env security`、`xcrun security` 或 python / node 等解释器子进程调用 security 不在拒绝范围内；放行规则里不要有裸 Bash 或解释器前缀。
- 钥匙串读取只支持 macOS。在其他系统上读不到 Key，工具只会回缺 Key 的提示。

## 🗂️ Agent 工作区（OpenClaw / Hermes 式三层记忆与技能）

机器人不只是问答机——`workspace/` 是它的常驻工作区，自带三层长期记忆与技能沉淀（记忆架构借鉴 OpenClaw 与 Hermes Agent）：

```
workspace/
├── CLAUDE.md          # 人格与行为协议（每次调用自动加载）
├── memory/
│   ├── USER.md        # 画像层：用户身份、偏好、沟通与判断风格——每次对话自动加载
│   ├── MEMORY.md      # 事实层索引：一条长期事实一行，@import 自动注入
│   ├── <slug>.md      # 事实层正文：一条记忆 = 一个文件，按需读取
│   └── journal/       # 流水层：当日工作笔记（YYYY-MM-DD.md），Grep 检索、不占上下文
├── skills/            # 沉淀的技能，桥接自动同步到 .claude/skills 生效
└── tasks/             # 交办台账：一事一个 JSON（open/waiting/done/dropped），桥接心跳只看到期项
```

- **主动记忆**：不用等你说「记住」——你纠正它的结论、做出决定、表达偏好、给出数字口径时，它当场落盘；说「**记住**：下周三去马尼拉出差」当然也行
- **supersede 不留矛盾**：事实变了就地改写并标注日期，绝不追加与旧条目矛盾的新条目；讲同一件事的文件会被合并成信息密度更高的版本
- **每周整理（dreaming）**：对它说「建一个每周记忆整理任务」，它会自建定时任务：通读 7 天 journal、提炼入长期层、合并重复、修正过时并汇报
- **压缩前固化**：上下文接近上限时自动提醒它把该留的写进记忆，避免自动压缩后细节流失
- 教它一个流程后说「**存成技能**」→ 自动生成 `skills/<name>/SKILL.md`，之后所有会话自动加载、匹配场景自动遵循；问「**你会哪些技能**」随时盘点
- 安全边界：写权限仅限 `memory/`、`skills/`、`tasks/` 等受限目录（Claude Code 本身禁止 agent 自写 `.claude` 配置目录，技能由桥接代码复制同步），协议明确禁止把密码/密钥写入记忆

## 💓 桥接心跳（默认关闭）

交办给机器人的事（「周五前盯一下报价单」「对方回了告诉我」）记在 `workspace/tasks/<slug>.json`，一事一个文件；
只记 owner 交办给它的事，不接管日历。心跳每 `HEARTBEAT_INTERVAL_MIN` 分钟一拍：

1. 脚本先读台账：坏文件、非法字段、软链、macOS `._` 影子文件跳过并记日志，不崩；`notes` 超过 300 字按前 300 字读入，不再整条失效，并会通知一次；
2. 没有到期项（`status` 为 open/waiting，且 `next_check_at` 已到或 `escalate_after` 已过）、外部增量也没有新东西 → 记一行日志，**不调模型**；
3. 有到期项 → 调一次模型（`HEARTBEAT_MODEL` / `HEARTBEAT_EFFORT`，不续会话、无中间进度），提示词只含到期条目，
   title/notes 进不可信围栏；模型改写台账推进进度；上一拍没跑完时本拍直接跳过；
   **反复到期退避**：同一条台账连续 3 次被成功送进模型、文件内容一直没变（哈希相同），之后每再送一次
   就按 1 → 2 → 4 → 8 拍递增跳过（封顶 8 拍）；文件一变即清零，`escalate_after` 首次越过的那一拍照送不跳。
   退避中的条目不进提示词、不占每日次数（到期项全在退避里就整拍不调模型）；退避状态也在 `data/heartbeat-state.json`，重启不丢；
4. 答复是 `HEARTBEAT_OK` → 完全静默；否则以应用身份私聊 owner。同样的正文 24 小时内只发一次；
   免打扰时段内只记状态不发消息，时段结束后合并成一条发出。待发队列没发完时新消息排到队尾、不插队；
   一拍合计最多发 3 条（补发的包 + 新消息），剩下的下一拍按原顺序接着发。
   待发队列里同一条（包）连续 5 拍发送失败就移出队列、不再重试（journal 记一行，不记正文）；队列满 20 条时丢最旧一条。
   两种丢弃都在下一次成功发出的心跳消息末尾附一行计数说明，不调模型。

| 变量 | 默认 | 说明 |
|---|---|---|
| `HEARTBEAT_ENABLED` | `false` | 精确等于 `true` 才启动 |
| `HEARTBEAT_INTERVAL_MIN` | `30` | 每拍间隔（分钟） |
| `HEARTBEAT_MAX_RUNS_PER_DAY` | `12` | 每日最多调模型次数；按本地日期计，重启不清零；时钟回拨不清零（见下） |
| `HEARTBEAT_MODEL` / `HEARTBEAT_EFFORT` | `claude-sonnet-5-5` / `low` | 心跳用的模型与思考档 |
| `HEARTBEAT_QUIET_HOURS` | `22-08` | 免打扰时段（本地时间，可跨午夜；`none` 关闭） |
| `HEARTBEAT_WATCH` | `none` | 外部增量源：逗号分隔的 `chat_reply,approval` 子集（见下）；`calendar` 未实现，与其他不认识的值一样记日志后忽略 |
| `HEARTBEAT_WATCH_MAX` | `10` | 每拍最多拉几条台账的外部增量（1–50） |
| `HEARTBEAT_BUTTONS` | `false` | 精确 `true` 时，只涉及一条台账的心跳消息带三个按钮 |
| `HEARTBEAT_REPLY_SHORTCUTS` | `false` | 精确 `true` 时，引用回复心跳消息的三个固定短语由桥接直接处理 |
| `HEARTBEAT_UNREAD_PAUSE` | `0` | 最近 N 条心跳消息都超过 24 小时未读就暂停发送；`0` 关闭（0–50） |
| `LARK_CLI_BIN` | `lark-cli` | 外部增量用的 lark-cli 可执行文件（不在 PATH 里时填绝对路径） |
| `HEARTBEAT_VERIFY` | `off` | 验收：`off` / `rule` / `rule+model`（见下）；不认识的值记日志后按 `off` |
| `VERIFY_MODEL` | `claude-haiku-5-5` | `rule+model` 档审核用的模型（零工具的 verifier 档） |
| `VERIFY_MAX_PER_DAY` | `10` | 每日最多调几次验收审核（0–200，按本地日期计，与心跳的次数分开） |
| `HEARTBEAT_ESCALATE_LADDER` | `false` | 精确 `true` 时开升级阶梯（见下） |
| `ESCALATE_MAX` | `2` | 升级阶梯最多几级（1–10），到顶后只进日结「卡住」 |
| `HEARTBEAT_DIGEST_AT` | 空（关） | 每晚台账日结的时间 `HH:MM`（本地时间，例如 `21:30`）；写错或落在免打扰时段里记日志后按关 |
| `SHUTDOWN_GRACE_SEC` | `120` | 优雅退出最多等几秒（0–3600，`0`＝不等，见下） |

桥接自己的计数、去重、待发队列、退避状态、心跳消息索引放 `data/heartbeat-state.json`（原子写，与台账分开，模型改不到）。
本机时钟回拨（本地日期比状态里记的早 1 天以内）时沿用原计数、每拍记一行「时钟回拨」日志，等本地日期真正越过记录日期才翻日；
状态里记的日期比今天晚**超过 1 天**（时钟曾被误调快后又改回）时按今天计、保留原计数（不清零），记一行日志，不用再手工改状态文件。
`/heartbeat status` 查看开关、今日用量、台账分布与退避中的条数，以及外部增量各源（开关、上次拉取、连续失败）、
在盯 / 被锁的 watch 条数、按钮与引用回复开关、未读暂停状态、今日事件计数；`/heartbeat off|on` 只改运行时开关（不写 `.env`，重启后回到配置值），
`HEARTBEAT_ENABLED` 不是 `true` 时 `on` 会拒绝。`/heartbeat` 只在 owner 私聊里生效：群聊里（包括 owner 本人发的）
不回复、不读不改心跳状态。台账协议与心跳轮次的提示词约定见
[`docs/heartbeat-prompt-proposal.md`](docs/heartbeat-prompt-proposal.md)，`watch` 怎么填、外部原文怎么转述见
[`docs/ev-prompt-proposal.md`](docs/ev-prompt-proposal.md)（都是[可选的提示词补充](#-可选的提示词补充)）。

### owner 对心跳消息的操作（全部由桥接处理，不调模型）

- **事件**：表情、已读、撤回三类机器人事件和卡片按钮回调（`card.action.trigger`）按确定规则处理，处理函数遇到坏载荷也不抛错。
  只有 owner 本人对心跳消息的表情 / 已读才记信号（`data/heartbeat-signals.json`，下一拍并进状态里的 `read_at` / `reacted_at`）；
  app 回显、别人的操作、非心跳消息、撤回只计数。
- **按钮**（`HEARTBEAT_BUTTONS=true`）：只涉及一条台账的心跳消息末尾带［知道了］［推迟一天］［不做了］。
  不论开关，回调都要校验：操作人是 owner、消息在心跳消息索引里（最多 200 条、保留 14 天）、按钮里的 nonce 与索引一致、
  台账存在且仍在跟进、同一动作没处理过。全部通过才回「已记下」，否则回「已失效」、不改任何文件。
  回调 3 秒内返回，回写异步排队；心跳这一拍正在跑时，等这一拍结束再写。
  「知道了」只在心跳状态里记一笔（下次提示词里带上）、不改台账；「推迟一天」把 `next_check_at` / `escalate_after` 各推后一天；已经过期的，从现在起推一天；
  「不做了」把 `status` 改成 `dropped`。改台账只动目标字段和 `updated_at`，不认识的字段原样保留，原子写；
  每次都在当天 journal 记一行，写明点了哪个按钮、对应哪个 `tasks/<slug>.json`。
- **引用回复快捷**（`HEARTBEAT_REPLY_SHORTCUTS=true`）：owner 私聊里引用回复心跳消息，正文恰好是「知道了」「推迟一天」「不做了」
  （允许带结尾标点），且那条消息只涉及一条台账 → 桥接按同样的规则回写并回一句确认，不进模型；
  其余引用回复照常进 owner 对话，提示词末尾加一行「（你在回复关于 tasks/<slug>.json 的心跳消息）」。
- **未读暂停**（`HEARTBEAT_UNREAD_PAUSE=N`）：最近 N 条心跳消息发出满 24 小时都没被读，就暂停发送（模型照常看台账，新消息只排队）。
  owner 读了任一条心跳消息或执行 `/heartbeat on` 就恢复，攒下的按顺序补发，恢复后的第一条消息开头会说明暂停过。
- 开放平台后台要手动订阅 `im.message.reaction.created_v1`、`im.message.message_read_v1`、`im.message.recalled_v1`，
  并在回调配置里用长连接接收 `card.action.trigger`。没开时这些功能只是收不到事件，心跳的其余行为不变。

### 外部增量（`HEARTBEAT_WATCH`）

台账里写了 `watch` 的条目，每拍由桥接以 owner 身份（`lark-cli … --as user`）执行**固定的只读命令**拉增量，有新东西才可能调模型：

- `chat_reply`（`"watch": { "type": "chat_reply", "chat_id": "oc_…", "after": "om_… 或时间戳" }`）：拉该会话 `after` 之后的新消息，
  过滤 owner、机器人和系统消息；游标只进不退（台账把 `after` 改小也不会重复触发），同一批消息指纹不变就不调模型；
- `approval`（`"watch": { "type": "approval", "instance_code": "…" }`）：拉审批实例的状态、当前节点和最近评论，没变化就不调模型；
  首次拉到仍在审批中只建基线；同一条审批隔一拍才拉一次；
- `calendar` 未实现，跳过；每拍最多拉 `HEARTBEAT_WATCH_MAX` 条。
- 三条 argv 模板逐字冻结在 `src/watch-sources.js`（只读命令，变量都先校验），子进程不经 shell、15 秒超时、输出上限 1MB，
  环境变量只给 HOME / PATH / LANG；拉取失败或超时这一拍降级为只看台账，不抛错。外部原文进提示词时包在不可信围栏里。
- **watch 锁**：`watch` 决定桥接以 owner 身份去读哪个会话 / 审批，所以只认 owner 对话里改的。心跳轮里改动的 `watch` 不生效：
  沿用原值、记日志，下一条心跳消息末尾说明。
- 需要本机已安装并以 owner 身份登录 `lark-cli`；`HEARTBEAT_WATCH` 不配时一次 lark-cli 都不跑。

### 验收、升级阶梯与每晚日结（全部默认关闭）

- **验收**（`HEARTBEAT_VERIFY=rule|rule+model`）：台账多一个状态 `verify`（等验收）和一个可选字段
  `done_evidence: { "kind": "approval|message|owner|other", "ref": "…", "summary": "≤200 字" }`
  （`approval` 的 ref 是审批实例码，`message` 的 ref 是 `om_…`，`owner` / `other` 不填 ref；`owner` 只由桥接写）。
  依据格式不合规时台账照常有效（不会因此逃出验收）：桥接不取这份依据、记下原因，核对时直接发卡片。
  心跳一拍里被写成 `done` 的台账，桥接在这一拍结束时改成 `verify`——模型说办完了不算数；owner 对话里、桥接自己写的 `done` 照旧。
  之后每拍最多核对 3 条待验收：
  1. **脚本规则**（只读，只用外部增量已有的只读 lark-cli 模板），结果分三种：
     - **通过**（桥接写 `done`）只有两种：`approval` 的 ref 等于台账 `watch.instance_code` 且审批状态是 `APPROVED`（已通过）；
       `message` 那条消息在台账 `watch.chat_id` 的会话里、是对方真人发的（不是 owner 本人、机器人、系统消息或已撤回），
       而且发在交办之后——发送时间（10 位按秒、13 位按毫秒）不早于台账 `created_at` 与数字 `watch.after` 中晚的那个；两样都没有就判不了，算不通过。
     - **不通过**：`approval` / `message` 的其余情况，包括审批被拒绝 / 撤回 / 删除（REJECTED / CANCELED / DELETED，卡片写明状态请 owner 决定）、
       还没通过、ref 对不上、消息是 owner 本人发的或早于交办、lark 查询失败，以及依据格式不合规。直接发验收卡片，**不问模型**（模型推翻不了）。
     - **核对不了**：没写依据、`kind=other`、模型写的 `kind=owner`（owner 的确认只认按钮 / 引用回复）。
  2. **核对不了的**：`rule` 档直接发验收卡片；`rule+model` 档再问一次 `VERIFY_MODEL`，只认一行严格 JSON
     `{"verdict":"pass|fail|unsure","reason":"≤80 字"}`：`pass` → 写 `done`；`fail` / `unsure` / 没按格式 / 调用失败 → 发验收卡片。
     审核用 verifier 档：没有任何工具，不加载 settings 来源与 MCP，cwd 是每次新建的系统临时目录（不是 `workspace/`；用完只删这个 `feishu-verifier-` 目录），不续会话。
     每日最多 `VERIFY_MAX_PER_DAY` 次，用满后直接发卡片。
  3. **验收卡片**「🔍 待你验收」：助理写的标题 / 进展 / 依据在不可信围栏里，桥接的核对结论在围栏外。
     按钮（`HEARTBEAT_BUTTONS=true`）［✅ 验收］［↩ 没办完］［🗑 不做了］，或引用回复「验收」「没办完」「不做了」（`HEARTBEAT_REPLY_SHORTCUTS=true`）。
     「没办完」（以及日结里的［撤销］）改回 `open`、`next_check_at` 推到明天，并按台账记下「判过没办完」：之后这条再被写成 `done`，
     不论依据改没改，一律发卡片请 owner 确认（不核对、不问模型）；owner 点［验收］或［办完了］后清掉。
     同一份依据只发一张卡片；卡片不进待发队列，免打扰 / 未读暂停 / 本拍发满时下一拍再试。
- **升级阶梯**（`HEARTBEAT_ESCALATE_LADDER=true`）：`escalate_after` 第一次越过那拍的心跳消息算第 1 级（同一拍几条一起越过、消息进了待发队列、
  或 24 小时内发过同样的，这几条也都登第 1 级；这时不记消息 ID，下一级按没读等满 48 小时；阶梯按钮只给只涉及一条的消息）；之后按固定模板再提醒（不调模型）：
  上一级读了满 24 小时、或没读满 48 小时才升一级（没读不叠发），owner 点过「知道了」就不再升；最多 `ESCALATE_MAX` 级，之后只进日结「卡住」。
  模板消息带［知道了］［推迟一天］［不做了］［办完了］，引用回复也多认「办完了」；`escalate_after` 改了就从第 1 级重新来。
- **每晚日结**（`HEARTBEAT_DIGEST_AT=HH:MM`）：到点私聊 owner 一份五栏日结——今天办完（注明规则验收 / 模型验收 / 心跳轮写的 / owner 确认 / 会话里改的）、
  今天放弃、待你验收、卡住、明天到期。每栏最多列 5 条，整条消息不超过 15 行；**五栏都空不发**。
  「今天办完」「今天放弃」从上一份日结的时刻（发出、进待发队列、重复不发、五栏全空都算）往后数，第一次从当天 0 点起：
  日结发完之后才关的单、哪天没发日结那天关的单，都进下一份（带撤销）。
  只读台账与桥接自己记的状态变化（`data/heartbeat-state.json` 的 `history`），不读 journal、不调模型。
  自动判定办完的（规则 / 模型 / 心跳轮写的）带圈号，按钮开着时附［撤销①］…（改回 `open`、明天再看；撤销只认按钮）；发出后在当天 journal 记一段。
  一天只发一次（重启不重发）；到点后 30 分钟内没发出去（心跳正忙、进程刚起）就不补发。
- `/heartbeat status` 多三行：验收（档位、待验收条数、今日模型审核次数）、升级阶梯（级数、升级中的条数）、日结时间。
- 状态文件新增顶层键 `verify` / `history`（含 `digest_at`）/ `verify_runs` 与 `tasks.<slug>.esc` / `tasks.<slug>.rejected_at`，缺了按空处理，不升版本号。
- 心跳轮怎么写 `done_evidence` 的提示词约定见 [`docs/vr-prompt-proposal.md`](docs/vr-prompt-proposal.md)（[可选的提示词补充](#-可选的提示词补充)）。

### 优雅退出（SIGTERM / SIGINT）

收到 SIGTERM / SIGINT 后，桥接不再接新消息，停掉心跳与日结定时器，等进行中的对话做完再退出。进行中的对话包括刚收到、排队中和正在回答的对话轮，跑着的定时任务，以及正在跑的心跳一拍。
最多等 `SHUTDOWN_GRACE_SEC` 秒（默认 120）。等待期间新来的消息回「正在重启，请稍后重发」；第二次信号立即退出。
用 launchd 托管时，plist 的 `ExitTimeOut` 要不小于优雅等待再加 10 秒，否则 launchd 会提前强杀：不写时只等 5 秒；用户级服务写多少都最多按 60 秒算（本机 `launchctl print` 核对：写 130 的显示 `exit timeout = 60`）。所以 macOS 下优雅等待实际最多 50 秒：`npm run install-service` 写 `ExitTimeOut = min(SHUTDOWN_GRACE_SEC, 50) + 10`，`SHUTDOWN_GRACE_SEC` 大于 50 时还会在 plist 的环境变量里把它钉成 50（优先于 `.env`），留 10 秒回「请稍后重发」和收尾。改了 `SHUTDOWN_GRACE_SEC` 要重跑一次；手写 plist（参考 `examples/launchd.example.plist`）时要自己加，同样别超过 60。systemd 没有这个上限，示例的 `TimeoutStopSec=130` 对应默认 120 秒再加 10 秒。
开了 `OWNER_MESSAGE_QUEUE`（见下文「忙时连续发消息」）时，owner 私聊里还没轮到的排队消息逐条回「助理正在重启，这条没处理，请稍后重发」，这些回复发完才退出；进行中的那轮做完后不再出队。
以下情况排队消息会直接丢掉，也不会回「请稍后重发」，需要你自己重发：`SHUTDOWN_GRACE_SEC=0`、等待期间又收到一次信号、被 SIGKILL、进程崩溃、launchd 提前强杀（plist 的 `ExitTimeOut` 没设够，见上）。

### 📨 忙时连续发消息：排队、合并、接着办（默认关闭）

`OWNER_MESSAGE_QUEUE=true`（精确等于 `true`）时，**只在 owner 私聊里**：助理正在办一件事时，接着发来的普通消息不再回「⏳ 上一个任务还在跑…」，而是排进内存队列，手头这轮一结束就接着办。
群聊、访客、非 owner、定时任务、心跳完全不受影响；不设或设成别的值时，行为与以前逐项相同。

| 变量 | 默认 | 说明 |
|---|---|---|
| `OWNER_MESSAGE_QUEUE` | `false` | 精确 `true` 时，owner 私聊忙时排队、轮次结束后合并接着办 |

- **什么时候算忙**：从这一轮排进会话开始，到回复发完、表情改完为止（模型答完、回复还没发出去的那几秒也算），不只是 claude 子进程在跑的时候。
- **排队**：每个会话一条队列，最多 10 条；满了回「排队已满（10 条），等手头的办完再发」，这条不入队。入队成功给那条消息加一个表情（`OnIt`，和开始处理一轮时加的是同一个）；
  加表情失败时退回为回一句「收到，办完手头的接着办这条」，每一轮忙碌期只回一次。图片、文件、富文本照平时的接收路径处理好再入队，下载或解析失败照旧当场告诉你。
  `/status`、`/help`、`/model`、`/heartbeat`、`/voice`、`/tasks` 等内置命令忙时照旧立即处理、不排队、不动队列（只有 `/new` 会顺带清队列，见下）。
- **接着办**：当前这轮结束（答完、出错、被取消都算）后，把此刻队列里的消息按到达顺序一次取走：
  - 更早发来、还没接收完的消息（比如附件还在下载）会先等它处理好（最多 30 秒）再一起取，免得后发的先办；30 秒还没好就先办已排好的，它好了进下一轮，不会丢；
  - 只有 1 条：照平时那样办（引用回复快捷、台账提示都和空闲时直接发一样；确认通道例外，见下），回复挂在这条上；
  - 多条：合并成一轮，开头注明这些是你在它忙的时候连续发来的消息、要按顺序一并处理、后面的可能是对前面的补充或更正，每条前标「第 N 条（HH:MM）」，
    回复挂在最后一条上；其中任一条是执行指令（`/do`、「执行」等）就整轮走执行车道。
  - 合并这一轮期间新来的消息继续排队，等它结束再取。
- **排队的「确认」不放行、合并轮不走引用回复快捷**：strict 档下合并的消息里即使有「确认」也不算数，桥接会提示单独再回一次「确认」；
  单独排队的一条「确认」出队时也不放行（排队期间上一轮可能又出了新草稿，你还没看到），原样交给模型，并提示「这条「确认」是在上一轮还没办完时发的，
  排队期间可能已有新结果，这次不算数；看完最新回复后需要放行的话，请单独再回一次「确认」。」。助理空闲时发的「确认」照旧放行。
  引用回复心跳消息的快捷短语只在消息到达时判定一次（命中就当场处理、不排队），合并时不再判定。
- **取消与重置**：`/cancel`（或「取消」）取消当前这轮并清空队列，同一条回复里说明清掉几条；`/redirect X` 取消当前、清空队列（另回一句清掉几条）、只按 X 重来；
  `/new` 照旧重置，队列非空时一并清空并先回一句清掉几条。只有这几个会清队列，`/voice`、`/tasks` 等其它命令不动它。清掉的消息不会再处理，需要的话请重发。
- **查看**：owner 私聊里 `/status` 多一行「排队消息: N 条」（只在开关开着时出现）。
- **重启**：队列只在内存里，不落盘；优雅退出时还没轮到的消息逐条回「助理正在重启，这条没处理，请稍后重发」，不会悄悄丢掉（例外：不等、二次信号、强杀、崩溃，见「优雅退出」）。
- 排队的文字和平时一样按 owner 本人的输入对待，引用 / 转发的第三方内容照旧装在不可信围栏里；合并后的提示词照旧经 stdin 交给 claude，不进命令行。

### 📅 每日新会话（默认关闭）

owner 私聊一直 `--resume` 同一条会话，越聊越长、每条都慢。打开 `DAILY_SESSION` 后，**只在 owner 私聊里**：每天凌晨先做一次「交接」，早上第一条消息起换一个新会话，开头带上昨天的交接内容。
群聊、访客、定时任务、心跳、验收、日结完全不受影响；不设或设成 `off` 时与以前逐字相同（不建 `data/daily-session/`、不记原话、不挂定时器、`/status` 不多一行）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DAILY_SESSION` | `off` | `off`（照旧）/ `shadow`（只记原话、只打「该切 / 推迟」日志，不换会话、不交接）/ `on`（真换）。不认识的值打日志并按 `off` |
| `DAILY_SESSION_AT` | `04:00` | 换新时刻（本地时间）：这个时刻之后的第一条 owner 私聊消息换新会话 |
| `DAILY_SESSION_HANDOFF_AT` | `03:30` | 预交接时刻；留空＝不预交接（只带原话）；必须早于 `DAILY_SESSION_AT`，否则按留空 |
| `DAILY_SESSION_ROUNDS` | `10` | 新会话带上一会话最后几轮原话（0–30） |
| `DAILY_SESSION_KEEP_DAYS` | `14` | 旧会话保留几天可以 `/session back`（1–28） |

- **预交接**：到 `DAILY_SESSION_HANDOFF_AT` 时，如果 owner 已经闲了 ≥60 分钟、上次交接以来有新的对话、没暂停、没在跑，就续旧会话跑一轮交接：
  把没办完的事落进 `tasks/`、新事实写进 `memory/`、过程追加当天 journal，最后输出一段 ≤600 字的「昨天聊到哪」摘要。交接轮的工具面是固定的：
  只能读工作区、只能写 `memory/` 与 `tasks/`，没有 Bash、联网和飞书工具，不受 `OWNER_TOOL_PROFILE` / `ALLOWED_TOOLS` / `LARK_CLI` 影响；回答不发给任何人，硬超时 5 分钟。
  交接排在 owner 会话同一条队列里，和对话不会并发；这期间发来的消息排在它后面，不会收到「上一个任务还在跑」。
- **换新**：`DAILY_SESSION_AT` 之后的第一条消息换新会话，消息前面附「接续材料」：开头说明（旧会话里的草稿全部失效，要执行必须重新出稿、等确认）、交接摘要、最近两份 journal（各取末尾 6000 字）、
  最后 N 轮原话（摘要与 journal、原话都放在不可信围栏里），总长不超过 2 万字。新会话第一条回复末尾附一行「（今天起是新会话；昨夜交接：更新了 N 个记忆 / 台账文件：…；`/session back` 可退回）」，列出交接改了哪几个文件（最多 5 个）。
  换新那一轮结束后如果还没拿到新会话 id（断连、被杀），下一条消息会重新带上接续材料。
- **哪些消息先不换**：「确认」（会让旧草稿在新会话里被执行）、排队后出队的一条、带「确认」的合并轮，这几种永远不在当轮换，留到下一条；
  裸 `/do`、`/redirect` 推迟，连续推迟到第 3 条强制换。第一次打开开关时已有的会话先接管、不换，下一次过 `DAILY_SESSION_AT` 再换。
- **失败回退**：新会话第一轮确定还没动过手就失败（进程没起来，或在任何输出之前就超时 / 取消 / 退出），自动退回原会话，回复里说明「今天换新会话没成功，已退回原会话；重发这条即可」；
  已经有输出（可能已调过工具）或说不清是否动过手的都不退回，也不叫你重发。
- **命令**（只在 owner 私聊；群里不回复）：`/session` 看状态；`/session back` 退回上一个会话并暂停每日切换；`/session auto` 恢复；`/session rotate` 立刻交接，下一条消息换新。
  `/new` 语义不变（不交接、不带接续材料），开关非 `off` 时被清掉的会话也记进可退回列表。
- **数据**：状态、原话（最近 30 轮）、交接摘要都在 `data/daily-session/`，`data/sessions.json` 格式不变。原话落盘前过凭据脱敏；日志里只有字数、条数和文件名，没有正文。
- **上线建议**：先 `shadow` 跑一天，再用 `scripts/daily-session-replay.js` 做新旧对比（盲评），新方式不输再改 `on`；改 `on` 时把 [`docs/ds-prompt-proposal.md`](docs/ds-prompt-proposal.md) 并入 `workspace/CLAUDE.md`。
- 显式配置了 `ALLOWED_TOOLS` 时，代码不并入默认值；启动时如果缺了默认 owner 工具里的 `Edit(./…/**)` 写入项（比如 `Edit(./tasks/**)`），会打一行 `[config] ⚠️` 警告并列出缺的项名（只提醒，不改权限）。

## 🔁 备用账号（默认关闭）

主用 Claude 账号的周额度 / 5 小时额度用完，或登录失效时，桥接自动改用备用账号的 claude，过一段时间再试主用，主用恢复就换回来。

- `CLAUDE_FALLBACK_BIN`：备用账号用的 claude 可执行文件（常见做法是一个包装脚本，导出备用账号的令牌后 `exec claude "$@"`）。不设 = 功能关闭，行为与没有这个功能时完全一样。
- `CLAUDE_FALLBACK_COOLDOWN_MIN`：切到备用后多少分钟再试主用，默认 30，范围 1–720；写错了按 30 处理，启动日志打一行 `[config] ⚠️`。
- 切换范围：冷却期内所有新起的 claude 都用备用，包括私聊、执行车道、群聊、访客、定时任务、心跳、验收和自诊断。
- 当前这一轮：还没调过工具、也没发过进度消息时，立即在备用上重跑这一轮，你只会收到正常回复；已经动过手的不会重放，回复里提示「已切到备用账号，请再发一次，或说“继续”」。`/cancel`、`/new` 和重启打断的轮不触发切换。
- 冷却到期后下一轮先试主用：成功就回到主用（只打日志）；仍不可用就再冷却一段，这一轮自动落到备用。备用自己也不可用（或备用 claude 起不来）时本轮不来回切，照常报错，下一轮先试主用。
- 进入备用时私信你一条「主用账号额度用完（或登录失效），已自动切到备用账号，约 N 分钟后会再试主用账号。」，同一次连续的备用期只发一次；赶上心跳的免打扰时段（`HEARTBEAT_QUIET_HOURS`）就延后到时段结束再发，那之前已回到主用就不发。切换状态只在内存里，重启后从主用起，主用仍不可用会再收到一条通知。`/status` 多一行「当前账号：主用 / 备用（几点再试主用）」。
- 启动时对备用 claude 跑一次 `--version`，失败只告警，本次运行当作没配置备用；`npm run doctor` 也会查这一项。
- **两个 claude 最好共用同一个 CLI 配置目录**（同一个 `~/.claude`，只是令牌不同）：这样换账号后 `--resume` 还是同一个会话。不共用时，换过去（或换回来）那边找不到会话，桥接会自动不带 `--resume` 重试一次，两边都相当于开了新会话，之前的上下文要靠记忆文件补。
- 日志（不含消息内容与原始报错）：`[account] 主用不可用(quota|auth)，切到备用，冷却 N 分钟`、`冷却到期，试主用`、`回到主用`、`备用也不可用(quota|auth)`、`备用启动失败，回到主用路径`；`[account-notice] 免打扰时段，切换通知延后到时段结束`、`切换通知发送失败`。
- 调 claude 子进程的收尾与环境（主用、备用都一样）：`result` 事件到了而进程在 `CLAUDE_RESULT_GRACE_MS` 毫秒（默认 10000，范围 100–120000，写错按默认并在启动日志打一行 `[config]`）内还没退出时，整个进程组被结束、本轮按已收到的结果落定，超时和 `/cancel` 时同样整组结束（桥接自己退出时也会给还在跑的进程组补发终止信号），且交给 claude 的环境变量里不再带桥接自己的配置项和任何 `FEISHU_*`（登录令牌 `CLAUDE_CODE_OAUTH_TOKEN`、代理、`HOME`、`PATH` 等照常传）。

## 🚦 模型分工：聊天/规划 vs 执行

```
CLAUDE_MODEL=fable           # 平常聊天、讨论、规划（默认车道）
CLAUDE_EXEC_MODEL=sonnet     # 执行（别名 sonnet = claude-sonnet-5-5）；留空 = 不分工，所有轮次都用 CLAUDE_MODEL
CLAUDE_EXEC_EFFORT=          # 执行车道的思考档，留空沿用 CLAUDE_EFFORT
```

- 触发执行车道：消息以 `/do`、`/exec`、`/run` 开头（前缀会被剥掉），或句首是「执行」「开始执行」「去做」「动手」「go」「do it」等触发词（`EXEC_TRIGGERS` 可整体覆盖）。裸 `/do` = 「按上面已确认的计划执行」。
- 判定是**确定性的**（前缀/句首词边界），不靠模型猜：「执行力很重要」「google 一下」都不会误切。
- 执行轮通过 `--resume` 复用同一会话：执行模型看得见聊天模型刚谈妥的计划。桥接会在系统提示词里告诉模型本轮车道与分工。
- 定时任务默认走执行车道（任务定义里写 `model` 可覆盖）；失败自诊断仍用 `DIAG_MODEL`。
- `/model` 查看两个模型；`/model exec sonnet` 改执行模型、`/model exec off` 关闭分工；`set-model` 定时动作支持 `exec_model` / `exec_effort` 字段。

## 🧰 飞书侧能做什么、不能做什么

内置 MCP 工具只有这 10 个（`src/mcp-feishu.js`），用**应用自己的租户凭据**，能碰什么由飞书后台 scope 决定：

| 支持 | 工具 | 需要的 scope |
|---|---|---|
| 云文档 | `doc_read` / `doc_append` | `docx:document:readonly` / `docx:document` |
| 知识库链接解析 | `/wiki/` 链接 → 文档 | `wiki:wiki:readonly` |
| 多维表格 | `bitable_tables` / `bitable_fields` / `bitable_records` / `bitable_create_record` / `bitable_update_record` | `bitable:app:readonly` / `bitable:app` |
| 电子表格 | `sheet_read` / `sheet_write` | `sheets:spreadsheet:readonly` / `sheets:spreadsheet` |
| 邮件附件 | `mail_attachment_download`（需 lark-cli 用户登录） | — |

**不支持**（租户身份答不了，或根本没做）：审批、日历、任务、通讯录、云盘文件列表、消息历史检索、视频会议、打卡、OKR。

想要这些，接飞书官方 [lark-cli](https://github.com/larksuite/cli)（22 个业务域 200+ 命令，走**用户 OAuth**，凭据在系统钥匙串）：`npm install -g @larksuite/cli` 装好命令 → `npm run setup -- --link-lark-cli` 让它用桥接同一个应用 → `lark-cli auth login --recommend` 以 owner 身份登录（要人在浏览器同意）→ 在 `.env` 设 `LARK_CLI=true`（步骤见 [AGENTS.md §3C](AGENTS.md#3c-让-lark-cli-用同一个应用可选只在要用-lark-cli-功能时)）。不要再跑 `lark-cli config init --new`，那会多建一个应用。桥接只给 owner 加一条 `Bash(lark-cli:*)`——实测 `lark-cli x && whoami` 这类拼接被挡，`env` / `ps aux` / `curl` 被拒，机器人读不到 `.env` 里的 App Secret；`whoami` / `pwd` 这类 CLI 内置的无害只读命令会放行。访客永远拿不到它。

## 🧩 可选的提示词补充

`workspace/CLAUDE.md` 是 owner 的提示词模板，仓库默认不改它。下面五份是配合可选功能的提示词补充，按需并入 `workspace/CLAUDE.md`。不并入功能照样工作，模型只是不知道相应的约定：

| 文档 | 内容 | 前提 |
|---|---|---|
| [`docs/heartbeat-prompt-proposal.md`](docs/heartbeat-prompt-proposal.md) | 交办台账（`tasks/`）的写法、心跳轮次的约定 | 打开心跳时 |
| [`docs/ev-prompt-proposal.md`](docs/ev-prompt-proposal.md) | `watch` 怎么填、外部原文怎么转述、心跳消息上的操作 | 先并入上一份 |
| [`docs/vr-prompt-proposal.md`](docs/vr-prompt-proposal.md) | `verify` 状态与 `done_evidence` 的写法、升级阶梯、日结 | 先并入上两份 |
| [`docs/owner-tools-prompt-proposal.md`](docs/owner-tools-prompt-proposal.md) | 工具描述修正、audit / strict 工具档下的用法 | 切换工具档时 |
| [`docs/ds-prompt-proposal.md`](docs/ds-prompt-proposal.md) | 每日新会话：接续材料怎么读、草稿失效、交接轮（仓库里的 `workspace/CLAUDE.md` 未改） | 把 `DAILY_SESSION` 改成 `on` 时 |

## 架构 Architecture

```
飞书私聊 / 群聊 @机器人
        │  长连接（WebSocket，im.message.receive_v1）
        ▼
桥接服务（Node.js 常驻：去重、串行队列、owner 鉴权、消息解析）
        │  spawn: claude -p --resume <会话ID> --allowedTools …（提示词走 stdin）
        ▼
Claude Code CLI（无头模式）
        │
        ▼
Markdown 卡片回复（失败自动降级纯文本）+ 表情回执
```

## 安全 Security

- `.env`（App Secret、可选的 `CLAUDE_CODE_OAUTH_TOKEN`）与运行数据 `data/`、工作区内容均被 `.gitignore` 排除。不要提交，不要贴进聊天。`npm run setup` / `doctor` 只报「齐 / 缺」，不输出值。
- 非 owner 无任何本机文件访问权限；附件目录仅只读放行。
- owner 默认只有本机只读工具，外加受限目录（`memory/`、`skills/`、`schedules/`、`tasks/`、`outbox/`）的写入。不要给无人值守机器人开 Bash，不要加 `--dangerously-skip-permissions`。
- 想进一步收紧 owner 的工具面：先用 `OWNER_TOOL_PROFILE=audit` 观察审计日志，再切 `strict`。

## License

[MIT](LICENSE)
