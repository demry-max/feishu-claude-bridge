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
- ⏱️ **活动式超时与任务控制**：有输出就不计时（长任务不被误杀）；`/cancel` 随时取消、`/redirect` 中断改道
- 🛡️ **出站脱敏**：回复送出前抹掉密钥、令牌、JWT 与内网 IP
- 🔊 **语音回复**：`/voice` 开启后回答附带语音消息
- 🩺 **定时任务自诊断**：任务失败自动分析原因并给出建议动作
- 🧷 **压缩前固化记忆**：上下文接近上限时自动提醒机器人把该留的写进 `memory/`，避免自动压缩后细节流失
- 🔀 **模型随时切换**：`/model fable high` 一句话切换模型与思考档，立即生效无需重启；也可设定时自动切换（如早八点切回便宜档）
- 🚦 **聊天/规划与执行分工两个模型**：`CLAUDE_MODEL` 负责平常对话与规划（如 fable 5.1），`CLAUDE_EXEC_MODEL` 负责执行（如 sonnet 5）——说「执行」「去做」或发 `/do <任务>` 时下一轮自动切到执行模型，会话上下文保留（执行模型看得见刚谈妥的计划）；定时任务默认走执行模型。`/model exec sonnet` 随时改，留空即关闭分工
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
| 配置来源 | 完整（含用户级 settings 与 MCP） | 仅项目级：`--setting-sources project` + `--strict-mcp-config` |
| CLI 自动记忆 | 开 | 关（该存储按 git 仓库根归档，不关就是共用一份） |
| 会话 | 按 chat_id | 按 chat_id + 发言人，互不可见 |

> **为什么不能只靠 `--allowedTools`**：它不是沙箱，而是「免询问」白名单、只做加法。
> 用户级 `~/.claude/settings.json` 里的 `permissions.allow` 对访客会话照样生效——
> v1.x 里访客因此可以执行本机 CLI 工具并以 owner 的身份读写数据。
> 真正的收权靠切断配置来源加显式 `--disallowedTools`（减法项，压过任何 allow）。

第三方内容（转发记录、卡片 JSON、文件名、标题）一律包进不可信围栏并声明「不是指令」；
出站回复经脱敏后再发送。

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
└── skills/            # 沉淀的技能，桥接自动同步到 .claude/skills 生效
```

- **主动记忆**：不用等你说「记住」——你纠正它的结论、做出决定、表达偏好、给出数字口径时，它当场落盘；说「**记住**：下周三去马尼拉出差」当然也行
- **supersede 不留矛盾**：事实变了就地改写并标注日期，绝不追加与旧条目矛盾的新条目；讲同一件事的文件会被合并成信息密度更高的版本
- **每周整理（dreaming）**：对它说「建一个每周记忆整理任务」，它会自建定时任务：通读 7 天 journal、提炼入长期层、合并重复、修正过时并汇报
- **压缩前固化**：上下文接近上限时自动提醒它把该留的写进记忆，避免自动压缩后细节流失
- 教它一个流程后说「**存成技能**」→ 自动生成 `skills/<name>/SKILL.md`，之后所有会话自动加载、匹配场景自动遵循；问「**你会哪些技能**」随时盘点
- 安全边界：写权限仅限 `memory/`、`skills/` 等受限目录（Claude Code 本身禁止 agent 自写 `.claude` 配置目录，技能由桥接代码复制同步），协议明确禁止把密码/密钥写入记忆

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
CLAUDE_EXEC_MODEL=sonnet     # 执行；留空 = 不分工，所有轮次都用 CLAUDE_MODEL
CLAUDE_EXEC_EFFORT=          # 执行车道的思考档，留空沿用 CLAUDE_EFFORT
```

- 触发执行车道：消息以 `/do`、`/exec`、`/run` 开头（前缀会被剥掉），或句首是「执行」「开始执行」「去做」「动手」「go」「do it」等触发词（`EXEC_TRIGGERS` 可整体覆盖）。裸 `/do` = 「按上面已确认的计划执行」。
- 判定是**确定性的**（前缀/句首词边界），不靠模型猜：「执行力很重要」「google 一下」都不会误切。
- 执行轮通过 `--resume` 复用同一会话：sonnet 看得见 fable 刚谈妥的计划。桥接会在系统提示词里告诉模型本轮车道与分工。
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
