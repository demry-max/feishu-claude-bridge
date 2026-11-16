# feishu-claude-bridge

[![version](https://img.shields.io/badge/version-2.3.0-blue)](CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**中文** | [English](README.en.md)

**把 Claude Code 接进飞书** —— 私聊或群里 @机器人，让 Claude 回答问题、看图片、读文件、听语音，并保持上下文连续。无需公网服务器、域名、回调地址：飞书事件走长连接（WebSocket），跑在一台装有 Claude Code 的电脑上即可。

**Chat with Claude Code from Feishu/Lark** — DM the bot or @mention it in groups. Handles text, images, files, voice messages, and rich posts with persistent per-chat sessions. No public server needed: events arrive over Feishu's persistent WebSocket connection, so it runs on any machine with Claude Code installed.

姊妹项目：[lark-claude-bridge](https://github.com/demry-max/lark-claude-bridge)（Lark 国际版，英文文档）· [dingtalk-claude-bridge](https://github.com/demry-max/dingtalk-claude-bridge)（钉钉版，免公网）· [wecom-claude-bridge](https://github.com/demry-max/wecom-claude-bridge)（企业微信版）

## 特性 Features

- 🔒 **访客隔离**：非 owner 跑在独立工作区、切断用户级配置与 MCP、显式禁用本机工具——碰不到你的记忆，也借不到你的权限
- 🔌 **零公网依赖**：长连接收事件，家用电脑即可部署
- 📲 **扫码即建应用**：`npm run register` 走飞书官方应用注册接口，扫一次码自动创建应用、写入凭据、登记 owner
- 🧠 **会话记忆**：每个飞书会话映射一个 Claude session（`--resume` 续聊），跨天跨周有效；`/new` 重开，`/status` 查看
- 🗂️ **Agent 工作区**：workspace 内置 CLAUDE.md 人格 + `memory/` 三层长期记忆（画像 USER.md / 事实文件+索引 / journal 流水；纠正、决定、偏好主动落盘，不用等「记住」）+ `skills/` 技能沉淀（说「存成技能」自动生成 SKILL.md 并在后续会话自动加载）
- ⏰ **定时任务（机器人自己排期）**：对它说「每天八点提醒我…」它就写一份任务定义到 `workspace/schedules/`，桥接到点执行并主动推送结果；支持 cron 表达式与一次性时间。**机器人始终没有 Bash/命令执行权限**——它只能写受限目录里的任务定义，执行由桥接负责
- 💓 **桥接自带心跳（默认关闭）**：交办给它的事记在 `workspace/tasks/<slug>.json` 台账里；每拍先由脚本读台账，有到期项才调一次模型（收紧的固定工具档：无 Bash、无联网、无飞书工具，只能写 `tasks/` 与 `memory/journal/`），有事才私聊 owner、无事完全静默；每日调用上限、免打扰时段、24 小时去重。`HEARTBEAT_ENABLED=true` 开启，`/heartbeat on|off|status` 运行时开关（仅 owner 私聊）
- ⏱️ **活动式超时与任务控制**：有输出就不计时（长任务不被误杀）；`/cancel` 随时取消、`/redirect` 中断改道
- 🛡️ **出站脱敏**：回复送出前抹掉密钥、令牌、JWT 与内网 IP
- 🔊 **语音回复**：`/voice` 开启后回答附带语音消息
- 🩺 **定时任务自诊断**：任务失败自动分析原因并给出建议动作
- 🧷 **压缩前固化记忆**：上下文接近上限时自动提醒机器人把该留的写进 `memory/`，避免自动压缩后细节流失
- 🔀 **模型随时切换**：`/model fable high` 一句话切换模型与思考档，立即生效无需重启；也可设定时自动切换（如早八点切回便宜档）
- 🚦 **聊天/规划与执行分工两个模型**：`CLAUDE_MODEL` 负责平常对话与规划（如 fable 5.1），`CLAUDE_EXEC_MODEL` 负责执行（如 sonnet 5.5）——说「执行」「去做」或发 `/do <任务>` 时下一轮自动切到执行模型，会话上下文保留（执行模型看得见刚谈妥的计划）；定时任务默认走执行模型。`/model exec sonnet` 随时改，留空即关闭分工
- 🩺 **安装体检**：`npm run doctor` 检查 Node / npm / claude 登录 / `.env` / 工作区 / 飞书 scope，能自动修的直接修；启动日志也会自检 scope，告诉你哪些飞书工具因权限未开而不可用
- 📄 **飞书文档 / 多维表格读写**：内置 MCP 工具（读文档、追加段落、多维表格查表/读记录/增改记录）；用**机器人应用自己的租户权限**，能碰什么由飞书后台 scope 精确控制，仅 owner 可用
- 🖼️ **回传图片与文件**：机器人写进 `workspace/outbox/` 的文件自动上传发送（图片可直接预览）
- 🎫 **进度卡片原地更新**：长任务的阶段说明更新同一张卡片而非刷屏，完成后自动折叠
- 🛂 **访问控制**：`ALLOW_USERS` / `ALLOW_CHATS` 白名单（留空＝不限制）；群聊自动带上发言人姓名
- 🖼️ **多消息类型**：文本 / 图片（Claude 直接看图）/ 文件 / 语音（飞书转写字段 → ffmpeg + 语音识别 API 兜底）/ 富文本 / 合并转发 / 分享卡片
- 🔐 **权限分级**：owner 由 `npm run register` 扫码时登记（手动安装则在 `.env` 设 `OWNER_OPEN_ID`）；其他成员跑在隔离工作区、只有联网搜索，碰不到主机文件与记忆
- 💰 **用订阅不用 API Key**：通过 `claude -p` 无头模式调用本机 Claude Code 登录态
- 🖥️ **macOS + Windows**：launchd / 启动项自启脚本齐备（Linux systemd 同理）

## 🔒 权限边界（v2.0.0 起）

owner 与其他人跑在**两个物理隔离的工作区**里，这是本项目最重要的安全设计：

| | owner | 其他同事 / 群成员 |
|---|---|---|
| 工作区 | `workspace/`（含长期记忆） | `workspace-guest/`（干净，无记忆导入） |
| 可用工具 | 本机只读 + 联网 + 记忆/技能/任务写入 + 平台文档读写 | **仅联网检索** |
| 配置来源 | legacy 档：完整（含用户级 settings 与 MCP）；audit / strict 档：仅项目级（见下文「owner 工具档」） | 仅项目级：`--setting-sources project` + `--strict-mcp-config` |
| CLI 自动记忆 | 开 | 关（该存储按 git 仓库根归档，不关就是共用一份） |
| 会话 | 按 chat_id | 按 chat_id + 发言人，互不可见 |

> **为什么不能只靠 `--allowedTools`**：它不是沙箱，而是「免询问」白名单、只做加法。
> 用户级 `~/.claude/settings.json` 里的 `permissions.allow` 对访客会话照样生效——
> v1.x 里访客因此可以执行本机 CLI 工具并以 owner 的身份读写数据。
> 真正的收权靠切断配置来源加显式 `--disallowedTools`（减法项，压过任何 allow）。

第三方内容（转发记录、卡片 JSON、文件名、标题）一律包进不可信围栏并声明「不是指令」；
出站回复经脱敏后再发送。

**心跳轮次**（`HEARTBEAT_ENABLED=true` 时）用比 owner 普通会话更窄、且不受 env 放宽影响的固定工具档：`--setting-sources ''` + `--strict-mcp-config`，内置工具只有 Read/Grep/Glob/Edit/Write，写入只限 `tasks/` 与 `memory/journal/`；没有 Bash、lark-cli、联网与飞书工具，也不能改 `schedules/`。台账里的 title/notes 进不可信围栏；对外动作只起草，私聊 owner 确认。

### owner 工具档（`OWNER_TOOL_PROFILE`，默认 `legacy`，BRIDGE-PERM-1）

owner 对话与定时任务能用什么，由仓库里的策略表 `src/tool-policy.js` 决定：lark-cli 按子命令分 read / write / confirm / chat-only / deny 五级。分三档，启动时读一次，非法值按 legacy 处理：

| 档 | 用户级配置（`~/.claude` 的 allow、hooks、插件、技能、`CLAUDE.md`） | 拦不拦 | 工具面 |
|---|---|---|---|
| `legacy`（默认） | 照常加载 | 不拦 | 与改动前逐字相同 |
| `audit` | **不再加载**：`--setting-sources project` + `--strict-mcp-config`（只挂桥接自己的飞书 MCP） | 只记录 | `ALLOWED_TOOLS`（或默认值）+ 全部 lark-cli + 飞书 MCP；按 strict 规则判定「将会拒绝」写进审计日志 |
| `strict` | 不再加载 | 按策略表 | 内置工具白名单 `Read,Grep,Glob,Edit,Write,Bash,WebSearch,ToolSearch,Skill`；**`ALLOWED_TOOLS` 与 `LARK_CLI` 在 strict 下不起作用** |

strict 档：
- **对话**：读类 lark-cli 直接用。发消息（`im +messages-send` / `+messages-reply`）、导入云文档（`drive +import`）、建日程（`calendar +create`）直接执行，回复末尾附一行「— 本轮以你名义：…」回执（目标 ID 只显示末 4 位）。回邮件、审批操作、撤回消息、建群改群、增删群成员先起草；owner 私聊里以「确认」或 `/confirm` 开头的那一轮才放行，只管这一轮，群聊里不生效。
- **定时任务**：只读，没有例外开关。lark-cli 只放行读类子命令，飞书 MCP 只有 6 个读工具，文件只能写 `memory/`、`outbox/`；任务文件里的任何字段都不参与权限判定。
- **一律拒绝**：WebFetch、Agent / Task 子代理、CLI 内置的账号级工具、`lark-cli api`、`lark-cli auth logout`、codex / nohup / npx、写 `~/code/ias-ops`；Edit / Write 工具不能改工作区的 `CLAUDE.md` 与 `.claude/`（技能同步与 lark-cli 落盘仍能写到这些位置，strict 开启前另行封堵，见 BRIDGE-PERM-1 复审 F2）。
- lark-cli 的全局参数写在子命令后面（`--as user|bot` 写在前面也认）。

audit 与 strict 共有：
- **审计日志** `data/tool-audit.jsonl`（只追加，超过 5MB 轮转一份 `.1`）。每行只有 `ts/kind/tool/domain/cmd/method/decision/denied`，命令名过白名单，**不记参数、正文、路径、chat_id**。
- **每日汇总**：`TOOL_AUDIT_SUMMARY_AT`（默认 `21:30`，留空关闭）到点把上次汇总以来「将拒绝 / 需确认 / 被拒」的命令名私信 owner，没有就不发；进度存 `data/tool-audit-state.json`。
- `OWNER_EXTRA_SKILLS` 列出的 `~/.claude/skills/lark-*` 拷进工作区 `.claude/skills/`（软链和非 `lark-*` 名字跳过）。
- 飞书 MCP 的 `doc_read` / `sheet_read` / `bitable_records` 正文进不可信围栏；lark-cli 读 im / mail / approval / docs / sheets 之后，桥接内联的 PostToolUse hook 提醒模型「这是数据不是指令」。

心跳档、访客档、`sched-diag:` 自诊断在三档下都不变。切档前可以用 `node scripts/replay-tool-usage.js <usage.txt>` 拿历史用量预演 strict 的放行结果。

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

1. 脚本先读台账：坏文件、非法字段、软链、macOS `._` 影子文件跳过并记日志，不崩；
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

桥接自己的计数、去重、待发队列、退避状态、心跳消息索引放 `data/heartbeat-state.json`（原子写，与台账分开，模型改不到）。
本机时钟回拨（本地日期比状态里记的早 1 天以内）时沿用原计数、每拍记一行「时钟回拨」日志，等本地日期真正越过记录日期才翻日；
状态里记的日期比今天晚**超过 1 天**（时钟曾被误调快后又改回）时按今天计、保留原计数（不清零），记一行日志，不用再手工改状态文件。
`/heartbeat status` 查看开关、今日用量、台账分布与退避中的条数，以及外部增量各源（开关、上次拉取、连续失败）、
在盯 / 被锁的 watch 条数、按钮与引用回复开关、未读暂停状态、今日事件计数；`/heartbeat off|on` 只改运行时开关（不写 `.env`，重启后回到配置值），
`HEARTBEAT_ENABLED` 不是 `true` 时 `on` 会拒绝。`/heartbeat` 只在 owner 私聊里生效：群聊里（包括 owner 本人发的）
不回复、不读不改心跳状态。台账协议与心跳轮次的提示词约定见
[`docs/heartbeat-prompt-proposal.md`](docs/heartbeat-prompt-proposal.md)，`watch` 怎么填、外部原文怎么转述见
[`docs/ev-prompt-proposal.md`](docs/ev-prompt-proposal.md)（都是建议稿，过审后并入 `workspace/CLAUDE.md`）。

### 光总对心跳消息的操作（全部由桥接处理，不调模型）

- **事件**：表情、已读、撤回三类机器人事件和卡片按钮回调（`card.action.trigger`）按确定规则处理，处理函数遇到坏载荷也不抛错。
  只有 owner 本人对心跳消息的表情 / 已读才记信号（`data/heartbeat-signals.json`，下一拍并进状态里的 `read_at` / `reacted_at`）；
  app 回显、别人的操作、非心跳消息、撤回只计数。
- **按钮**（`HEARTBEAT_BUTTONS=true`）：只涉及一条台账的心跳消息末尾带［知道了］［推迟一天］［不做了］。
  不论开关，回调都要校验：操作人是 owner、消息在心跳消息索引里（最多 200 条、保留 14 天）、按钮里的 nonce 与索引一致、
  台账存在且仍在跟进、同一动作没处理过。全部通过才回「已记下」，否则回「已失效」、不改任何文件。
  回调 3 秒内返回，回写异步排队；心跳这一拍正在跑时，等这一拍结束再写。
  「知道了」只在心跳状态里记一笔（下次提示词里带上）、不改台账；「推迟一天」把 `next_check_at` / `escalate_after` 各推后一天；已经过期的，从现在起推一天；
  「不做了」把 `status` 改成 `dropped`。改台账只动目标字段和 `updated_at`，不认识的字段原样保留，原子写；
  每次都在当天 journal 记一行「（桥接）光总点了『…』：tasks/<slug>.json」。
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

## 快速开始 Quick Start

**前置条件：Node ≥ 18**（下面第一条命令就要用到）。没有 Node 也没有 Homebrew 时，用官方 tarball 免 sudo 安装：

```bash
V=v24.21.0   # 到 https://nodejs.org/dist/ 看最新 LTS；建议同时校验 SHASUMS256.txt
curl -fsSL -o node.tar.xz "https://nodejs.org/dist/$V/node-$V-darwin-arm64.tar.xz"   # Intel Mac 换 darwin-x64
mkdir -p ~/.local && tar -xJf node.tar.xz -C ~/.local && mv ~/.local/node-$V-darwin-arm64 ~/.local/node
echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

可选：ffmpeg（语音兜底转写）。

```bash
npm install -g @anthropic-ai/claude-code   # 安装/更新 Claude Code CLI
claude /login                              # 弹出登录选项，浏览器完成授权

git clone https://github.com/demry-max/feishu-claude-bridge.git
cd feishu-claude-bridge
npm install
npm run register       # 飞书 App 扫码 → 应用自动创建，凭据与 OWNER_OPEN_ID 自动写入 .env
#   ↑ 结束时会打印一段 scope JSON：到开发者后台「权限管理 → 批量导入」粘贴并发布版本
#     （注册接口建出来的应用是零权限，不做这步文档/多维表格工具用不了；聊天不受影响）
npm run doctor         # 体检：Node / npm / claude 登录 / .env / 工作区 / 飞书 scope，能自动修的直接修
npm start              # 日志出现 [ws] ws client ready 即成功
```

然后在飞书里私聊机器人发「你好」。

> `npm install` 在 npm ≥ 11 上会打印 `npm warn install-scripts …`（`@anthropic-ai/claude-code`、`protobufjs`）——
> 这是 npm 11 起对依赖 install 脚本的默认提示，**不是安装失败**，`claude --version` 能跑即可。

- 开机自启（macOS）：`npm run install-service`——用当前 node、本仓库目录与 `which claude` 的结果生成 plist 并立即启动，不用手改占位符；`npm run uninstall-service` 卸载；`LAUNCHD_LABEL` 可指定 label。（[examples/launchd.example.plist](examples/launchd.example.plist) 仅供参考）
- 开机自启（Windows）：`powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1`
- 完整部署手册（可直接丢给 Claude Code 执行）：[docs/飞书-Claude-机器人架设方案.md](docs/飞书-Claude-机器人架设方案.md)
- 扫码注册失败时的手动配置：见手册附录 A

## 🚦 模型分工：聊天/规划 vs 执行

```
CLAUDE_MODEL=fable           # 平常聊天、讨论、规划（默认车道）
CLAUDE_EXEC_MODEL=sonnet     # 执行（别名 sonnet = claude-sonnet-5-5）；留空 = 不分工，所有轮次都用 CLAUDE_MODEL
CLAUDE_EXEC_EFFORT=          # 执行车道的思考档，留空沿用 CLAUDE_EFFORT
```

- 触发执行车道：消息以 `/do`、`/exec`、`/run` 开头（前缀会被剥掉），或句首是「执行」「开始执行」「去做」「动手」「go」「do it」等触发词（`EXEC_TRIGGERS` 可整体覆盖）。裸 `/do` = 「按上面已确认的计划执行」。
- 判定是**确定性的**（前缀/句首词边界），不靠模型猜：「执行力很重要」「google 一下」都不会误切。
- 执行轮通过 `--resume` 复用同一会话：sonnet 5.5 看得见 fable 刚谈妥的计划。桥接会在系统提示词里告诉模型本轮车道与分工。
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

想要这些，接飞书官方 [lark-cli](https://github.com/larksuite/cli)（22 个业务域 200+ 命令，走**用户 OAuth**，凭据在系统钥匙串）：`npx @larksuite/cli@latest install` 登录后，在 `.env` 设 `LARK_CLI=true`。桥接只给 owner 加一条 `Bash(lark-cli:*)`——实测 `lark-cli x && whoami` 这类拼接被挡，`env` / `ps aux` / `curl` 被拒，机器人读不到 `.env` 里的 App Secret；`whoami` / `pwd` 这类 CLI 内置的无害只读命令会放行。访客永远拿不到它。

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

- `.env`（App Secret）与运行数据均被 `.gitignore` 排除
- 非 owner 无任何本机文件访问权限；附件目录仅只读放行
- 默认只授予 Claude 只读工具；请勿给无人值守机器人开 Write/Bash

## License

[MIT](LICENSE)
