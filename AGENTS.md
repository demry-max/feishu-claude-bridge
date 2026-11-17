# AGENTS.md — 给 AI agent 的安装手册 / Install guide for AI agents

> 你（AI agent）拿到这个仓库链接、要帮人把飞书机器人装起来时，**从这里开始，按顺序做**。
> You are an AI agent asked to install this bot. Start here and follow the steps in order.
>
> 每一步都有：**命令** / **成功的样子（可检查）** / **失败怎么办**。
> 标 **`[需要人]`** 的步骤你做不了（扫码、浏览器登录、开发者后台点按钮），把给出的话术原样转告人，
> 人说做完后，跑「验证」那条命令确认，**不要凭人一句话就往下走**。

## 0. 铁律（先读，全程遵守）

1. **不打印、不复述、不提交任何密钥。**
   - 说的是 `.env` 的内容、`FEISHU_APP_SECRET`、`CLAUDE_CODE_OAUTH_TOKEN`、`data/` 下的文件。
   - 不要 `cat .env`。要看哪几项已填，用 `npm run setup`：它只报「齐 / 缺」，不输出值。
   - 人把 App Secret 发给你时，按 [§3A](#3a-已有飞书应用不扫码) 写进 `.env`，回复里不重复它。
   - 不要 `git add .env` / `git add -A`。
2. **不加 `--dangerously-skip-permissions`。**
   - 不给 `ALLOWED_TOOLS` / `NON_OWNER_TOOLS` 加 `Bash`。
   - 不把 `OWNER_TOOL_PROFILE` 从默认的 `legacy` 改掉，除非人明确要求（三档见 [§8](#8-可选功能默认全关)）。
3. **`workspace/` 是模板。**
   - 仓库只跟踪 `workspace/CLAUDE.md`。机器人的记忆、技能、台账会长在 `workspace/` 里，并被 `.gitignore` 忽略。
   - 不要往里放人的资料，不要删里面已有的内容。升级时它不会被覆盖。
4. **只在人给的那台机器上、这个仓库目录里操作。** 不改人的 shell 配置文件，除非人同意（装 Node 那一步除外，见下）。
5. 拿不准就跑 `npm run setup`。它可重复执行（幂等），每项都告诉你下一步做什么。

## 1. 先认识两个命令

| 命令 | 作用 | 退出码 |
|---|---|---|
| `npm run setup` | 安装自检。Node、依赖、claude CLI 与登录、`.env`（不存在则从 `.env.example` 生成）、必填项，最后跑一遍 doctor 并合并结果 | `0` 全绿；`2` 只差 🙋 人工步骤；`1` 有 ❌ 失败项 |
| `npm run doctor` | 运行体检。在 setup 的基础上，还查可选命令、工作区、常驻服务、飞书 scope（联网，可 `--no-network`） | 文本模式：`0` 通过 / `1` 有问题；`--json`：同 setup 的三态 |

两者都支持 `--json`，输出：

```json
{ "exit": 2, "counts": { "ok": 9, "warn": 2, "fail": 0, "needs_human": 1 },
  "items": [ { "id": "owner", "status": "needs_human", "title": "…", "message": "…", "fix": "…" } ],
  "next": "…" }
```

**怎么读**：

- 图标：✅ `ok` 通过；⚠️ `warn` 提醒，不影响运行；❌ `fail` 你应该能修，照 `fix` 做；🙋 `needs_human` 要人做，转告 `fix`。
- 按 `id` 找对应的步骤：

| id | 对应步骤 |
|---|---|
| `node` / `npm` / `deps` | §2 |
| `claude_cli` / `claude_model` / `claude_auth` | §2 |
| `env_file` / `feishu_credentials` | §3 |
| `feishu_scopes` | §4 |
| `owner` / `set_owner` | §5 |
| `service*` | §7 |
| `lark_cli` / `ffmpeg` | §8，可选 |
| `env_shadowed` | §10 |
| `env_*_format` / `env_domain` / `env_tool_profile` / `env_owner_claim` | `.env` 写法提醒 |

- 文本模式下每行是 `图标 标题：说明 → 怎么修`。

## 2. 准备环境

### 2.1 Node ≥ 18

- **命令**：`node --version`
- **成功**：`v18` 及以上，推荐当前 LTS。
- **失败**（没有 node 或版本低）：
  - 有 Homebrew 用 `brew install node`。
  - 没有就用官方 tarball 免 sudo 装（macOS arm64 示例，Intel 换 `darwin-x64`，Linux 换 `linux-x64`）：

    ```bash
    V=v24.21.0   # 到 https://nodejs.org/dist/ 看当前 LTS
    curl -fsSL -o node.tar.xz "https://nodejs.org/dist/$V/node-$V-darwin-arm64.tar.xz"
    mkdir -p ~/.local && tar -xJf node.tar.xz -C ~/.local && mv ~/.local/node-$V-darwin-arm64 ~/.local/node
    export PATH="$HOME/.local/node/bin:$PATH"   # 要永久生效，经人同意后写进 ~/.zshrc
    ```

  - Windows 用 `winget install OpenJS.NodeJS.LTS`。

### 2.2 Claude Code CLI

- **命令**：`claude --version`
- **成功**：打印版本号。
- **失败**：
  - 没装：`npm install -g @anthropic-ai/claude-code`，或按 Claude Code 官方文档的原生安装方式装。
  - `--version` 报错：重装。
  - `claude_model` 项报 CLI 版本太低：升级 CLI，或在 `.env` 换 `CLAUDE_MODEL`。

### 2.3 `[需要人]` 登录 Claude Code

机器人用这台机器上 Claude Code 的登录态（订阅账号），不用 API Key。

- **转告人**：
  > 请在这台电脑的终端里运行 `claude`，在里面输入 `/login`，按提示在浏览器里用你的 Claude 账号完成登录，完成后告诉我。
  >
  > Please run `claude` in a terminal on this machine, type `/login`, finish signing in with your Claude account in the browser, then let me know.
- **验证**：`npm run setup -- --json --no-network`，看 `claude_auth` 是 `ok`。
  - `needs_human`：还没登录。
  - `warn`：这个 CLI 版本没有 `auth status` 子命令，确认不了。请人在终端跑一次 `claude -p hi` 看能否回答。
- 常驻服务不继承终端环境时，可用长期令牌：
  - 人运行 `claude setup-token`，自己把输出填进 `.env` 的 `CLAUDE_CODE_OAUTH_TOKEN=`。
  - 你不要经手这个令牌。

### 2.4 取代码、装依赖

```bash
git clone https://github.com/demry-max/feishu-claude-bridge.git
cd feishu-claude-bridge
npm ci
```

- **成功**：`npm ci` 退出码 0，出现 `node_modules/`。
- **失败**：
  - 网络 / 代理问题见 §10。
  - 只有 `npm warn …` 不是失败。
  - 没有 `package-lock.json` 时（不应发生）用 `npm install`。
- 之后每一步前都可以跑 `npm run setup`；到这里 `node` / `deps` / `claude_cli` 应是 ✅。

### 2.5 生成 `.env`

- **命令**：`npm run setup`
- **成功**：`env_file` ✅，提示「已从 .env.example 生成（权限 600）」或「已存在」。
- 这时 `feishu_credentials` 是 🙋，接下来二选一：
  - **人已经有飞书应用**的 App ID / App Secret → §3A。
  - **新建应用** → §3B（扫码，最省事）。

## 3. 飞书应用凭据（二选一）

### 3A. 已有飞书应用（不扫码）

1. **`[需要人]` 填凭据**
   - **转告人**：
     > 请打开项目目录里的 `.env` 文件，把飞书开发者后台「凭证与基础信息」里的 App ID 和 App Secret 分别填到 `FEISHU_APP_ID=` 和 `FEISHU_APP_SECRET=` 后面，保存后告诉我。不用把 Secret 发给我。
     >
     > Please open the `.env` file in the project folder and fill in `FEISHU_APP_ID=` and `FEISHU_APP_SECRET=` with the App ID and App Secret from "Credentials & Basic Info" in the Feishu developer console. Save it and tell me. You don't need to send me the secret.
   - 人坚持把值发给你时，用不回显的方式写入，例如：

     ```bash
     node -e "import('./src/env-file.js').then(m=>m.patchEnvFile('.env',{FEISHU_APP_ID:process.argv[1],FEISHU_APP_SECRET:process.argv[2]}))" 'cli_xxx' '<secret>'
     ```

     命令行参数会进 shell 历史，所以能让人自己填就让人自己填。之后不在对话里重复这个值。
   - 国际版 Lark 另加一行 `FEISHU_DOMAIN=lark`。
   - **验证**：`npm run setup`，`feishu_credentials` ✅。
2. **`[需要人]` 开发者后台配置**（老应用可能已做过，逐项确认）
   - **转告人**：
     > 请在飞书开发者后台打开这个应用，确认四件事：
     > ①「应用能力」里已添加「机器人」；
     > ②「事件与回调 → 事件配置」的订阅方式是「使用长连接接收事件」，并已添加事件 `im.message.receive_v1`；
     > ③「权限管理 → 批量导入」粘贴我给你的那段 JSON；
     > ④「版本管理与发布」创建一个新版本并发布（可用范围要包含你自己）。
     > 做完告诉我。
     >
     > In the Feishu developer console, open this app and make sure:
     > (1) the Bot capability is added;
     > (2) Events & Callbacks uses "Receive events through persistent connection" and the event `im.message.receive_v1` is added;
     > (3) Permissions → Batch import has the JSON I give you pasted in;
     > (4) a new version is created and published, with you inside the availability scope.
     > Tell me when done.
   - 给人的 scope JSON。聊天所需的 `im:*` 加上文档 / 表格工具所需的部分：

     ```json
     {"scopes":{"tenant":["im:message","im:message.p2p_msg:readonly","im:message.group_at_msg:readonly","im:resource","im:message.reactions:write","speech_to_text:speech","contact:user.base:readonly","docx:document","docx:document:readonly","bitable:app","bitable:app:readonly","wiki:wiki:readonly","sheets:spreadsheet","sheets:spreadsheet:readonly"],"user":[]}}
     ```

   - **验证**：`npm run doctor -- --json`，`feishu_scopes` 应为 `ok`。
     - `needs_human`：message 里列出还缺的 scope，提醒人补完后**重新发布版本**。
     - `fail`：凭据错，或网络不通（§10）。
   - 长连接与事件订阅脚本查不到，要在 §6 前台验证时确认。

### 3B. 新建应用（扫码，两段式）

1. **命令**：`npm run register -- --no-wait`
   - **成功**：退出码 `2`，输出一行 `[需要人]` 和一个 `https://…` 链接。设备码存在 `data/register-pending.json`，约 10 分钟内有效。
   - **失败**：
     - 退出码 `1` 且提示「.env 里已有 FEISHU_APP_ID / FEISHU_APP_SECRET」：已经有应用了，走 3A 的验证，**不要加 `--force`**。`--force` 会在飞书里再建一个应用并覆盖凭据。
     - 网络错误见 §10。
2. **`[需要人]` 扫码**
   - **转告人**（附上链接）：
     > 请用手机飞书扫这个链接生成的二维码，或直接在手机上打开链接，按提示创建应用并同意授权，完成后告诉我：<链接>
     >
     > Please open this link on your phone in the Feishu/Lark app (or scan it as a QR code), create the app and approve, then tell me: <link>
3. **命令**：`npm run register -- --resume`。最多等 120 秒，可加 `--timeout 300`。
   - **成功**：退出码 `0`。App ID、App Secret（不打印）、扫码人的 `OWNER_OPEN_ID` 写进 `.env`，并写 `data/owner.json`。
   - 退出码 `2`：人还没点完，过一会儿再跑同一条。
   - 提示链接过期：回到第 1 步。
4. **`[需要人]` 开通权限并发布**
   - 注册接口建出来的应用**零权限**。聊天可用，但文档 / 多维表格 / 电子表格工具用不了。
   - 第 3 步的输出末尾有一段 scope JSON 和后台地址。
   - **转告人**：
     > 请打开飞书开发者后台里刚创建的应用，「权限管理 → 批量导入」粘贴我给你的 JSON，然后「版本管理与发布」创建版本并发布，完成后告诉我。
     >
     > Open the new app in the Feishu developer console, paste the JSON I give you into Permissions → Batch import, then create and publish a version. Tell me when done.
   - **验证**：`npm run doctor -- --json`，`feishu_scopes` 为 `ok`。
- 有 TTY 的人自己在终端跑 `npm run register`（不带参数）时，是老的交互式二维码，原地等待。

## 4. 验证 scope（两条路径共用）

- **命令**：`npm run doctor`
- **成功**：
  - `飞书 scope：N 个工具可用` ✅。
  - 启动日志里也会有一行 `[scope] ✅ …`。
- 有缺失时，doctor 会列出缺哪些 scope、影响哪些工具，并给出可直接导入的 JSON。转告人补上并发布版本。

## 5. owner 登记

owner 是唯一能用本机工具和记忆的人，其他人只能联网检索。

- **3B 扫码路径**：已自动登记。setup 的 `owner` 项应是 ✅。
- **3A 路径**：`owner` 是 🙋。你需要人的 open_id，做法如下：
  1. 前台启动并把日志写进文件：`npm start >> bridge.log 2>&1`。
     - 这是长驻进程。用你的工具在后台跑，并记下 PID；或请人在另一个终端跑。
  2. **`[需要人]` 私聊机器人**
     - **转告人**：
       > 请在飞书里搜索刚才那个机器人，私聊它随便发一句话（它会回复「owner 记录缺失」之类的提示，这是正常的），然后告诉我。
       >
       > In Feishu, find the bot and send it any direct message (it will reply that the owner record is missing — that's expected), then tell me.
  3. **命令**：`npm run setup`。
     - `owner` 一项会列出日志里发过消息的 open_id，最近的在前，并给出 `npm run setup -- --set-owner ou_…`。
     - 只有一个人发过时就是他。有多个时请人确认。
  4. **命令**：`npm run setup -- --set-owner ou_…`，`set_owner` ✅。
  5. 停掉第 1 步的进程（`kill <你记下的 PID>`），回到 §6 重新启动。
  - 已知 open_id 的人可以直接写 `.env` 的 `OWNER_OPEN_ID=`。
  - **不要**为此开 `ALLOW_OWNER_CLAIM=true`（「首个私聊者自动认领」）。真要开，登记完立刻删掉；doctor 会对它报 ⚠️。

## 6. 前台验证：真的能用

1. **命令**：`npm run setup`，应退出码 `0`。⚠️ 可以有，例如 `service` 还没装、ffmpeg 没装。
2. **命令**：`npm start >> bridge.log 2>&1`（后台运行，记 PID）。
3. **检查**：`grep -n "ws client ready" bridge.log`
   - 有，说明长连接已连上。
   - 30 秒内没有：看 `bridge.log` 末尾。
     - App ID / Secret 错，通常是 token 报错。
     - 网络 / 代理问题见 §10。
4. **`[需要人]` 发一句话**
   - **转告人**：
     > 请在飞书里私聊机器人发「你好」，告诉我有没有收到回复。
     >
     > Please DM the bot "hello" in Feishu and tell me whether it replied.
5. **验证**：`grep -n "\[msg\]" bridge.log | tail -3`，应有一行 `[msg] … @ p2p [text]: …`。
   - 人说收到回复 → 成功。
   - **日志里没有 `[msg]`**：飞书没把消息推过来。
     - 「使用长连接接收事件」没开，或没加 `im.message.receive_v1`。
     - 应用没发布，或人不在可用范围。
     - 这些在开发者后台改完都要**重新发布版本**。
   - **有 `[msg]` 但没回复**：看后面的报错。
     - claude 没登录见 §2.3。
     - 缺 `im:message` 权限时回复发不出去。
6. 验证完 `kill <PID>` 停掉前台进程，再装常驻服务。两个同时跑会重复回复。

## 7. 常驻服务

### macOS（launchd，推荐）

- **命令**：`npm run install-service`
  - 想先看一眼：`npm run install-service -- --dry-run`。
  - 它用当前 node、本仓库目录、`which claude` 的结果生成 `~/Library/LaunchAgents/<label>.plist`，并立即启动。
  - label 默认是 `com.<用户名>.feishu-claude-bridge`，可用 `LAUNCHD_LABEL` 改。
  - plist 带 `ExitTimeOut`（= `SHUTDOWN_GRACE_SEC` + 10），重启时不会被提前强杀。
- **验证**：
  - `launchctl print gui/$(id -u)/<label> | grep -E "state|pid"`，应有 `state = running`。
  - `grep "ws client ready" ~/Library/Logs/<label>.log`。
  - `npm run doctor`，`service` ✅。
- **日志**：`~/Library/Logs/<label>.log`。
- **重启**：`launchctl kickstart -k gui/$(id -u)/<label>`。
- **卸载**：`npm run uninstall-service`。

### Linux（systemd 用户服务）

- 仓库不自动安装。按 [`examples/feishu-claude-bridge.service`](examples/feishu-claude-bridge.service) 顶部注释操作，填好路径和 PATH。
  - PATH 要包含 `claude` 所在目录。
- **验证**：`systemctl --user status feishu-claude-bridge`。
- **日志**：`journalctl --user -u feishu-claude-bridge -f`。
- 不登录桌面也要运行时：`loginctl enable-linger "$USER"`（可能要人授权）。

### Windows（登录自启）

- **安装**：`powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1`，日志在仓库根目录 `bridge.log`。
- **卸载**：`scripts\windows\uninstall-startup.ps1`。
- **注意**：启动项**不会在崩溃后自动重启**。长连接彻底断开时，桥接会主动退出等人重启。要 7×24 请人另配任务计划程序的「失败时重启」。

## 8. 可选功能（默认全关）

装好后什么都不开也能正常聊天。下表只在人要求时才改，在 `.env` 里设置，改完重启服务。

| 功能 | 默认 | 开关 | 前置条件 |
|---|---|---|---|
| 桥接心跳与交办台账 | 关 | `HEARTBEAT_ENABLED=true` | 无；运行时 `/heartbeat on\|off\|status`（owner 私聊） |
| 心跳消息按钮 | 关 | `HEARTBEAT_BUTTONS=true` | 后台「回调配置」用长连接接收 `card.action.trigger` |
| 引用回复快捷操作 | 关 | `HEARTBEAT_REPLY_SHORTCUTS=true` | 心跳已开 |
| 表情 / 已读 / 撤回事件 | 收不到也不影响 | — | 后台订阅 `im.message.reaction.created_v1`、`im.message.message_read_v1`、`im.message.recalled_v1` |
| 未读暂停 | 关 | `HEARTBEAT_UNREAD_PAUSE=N` | 已读事件已订阅 |
| 外部增量（群回复、审批） | 关 | `HEARTBEAT_WATCH=chat_reply,approval` | 本机装好 lark-cli 并以 owner 身份登录（`[需要人]` 浏览器授权） |
| 验收 | 关 | `HEARTBEAT_VERIFY=rule` 或 `rule+model` | 心跳已开；`rule+model` 另用 `VERIFY_MODEL`，每日上限 `VERIFY_MAX_PER_DAY` |
| 升级阶梯 | 关 | `HEARTBEAT_ESCALATE_LADDER=true` | 心跳已开；级数 `ESCALATE_MAX` |
| 每晚台账日结 | 关 | `HEARTBEAT_DIGEST_AT=21:30` | 心跳已开；时间不能落在免打扰时段 |
| owner 工具档 | `legacy` | `OWNER_TOOL_PROFILE=audit` 或 `strict` | 先用 `audit` 跑一段，看审计；`strict` 下 `ALLOWED_TOOLS` / `LARK_CLI` 不起作用 |
| 工具审计每日汇总 | audit / strict 下 `21:30` | `TOOL_AUDIT_SUMMARY_AT=`（留空关闭） | owner 工具档为 audit / strict |
| lark-cli（日历、审批、任务等） | 关 | `LARK_CLI=true` | 同「外部增量」 |
| 语音兜底转写 | 自动 | — | `ffmpeg` 在 PATH 里（常驻服务的 PATH 也要有） |
| 优雅退出等待 | `120` 秒 | `SHUTDOWN_GRACE_SEC` | macOS 改了之后要重跑 `npm run install-service` 更新 `ExitTimeOut` |

细节见 [README.md](README.md)。`docs/*-prompt-proposal.md` 是这些功能可选的提示词补充，人想用时再并入 `workspace/CLAUDE.md`。

## 9. 验收清单（全部满足才算装好）

- [ ] `npm run setup` 退出码 `0`。
- [ ] `npm run doctor` 输出「全部通过」，或只剩 ⚠️，且每个 ⚠️ 你都向人说明过。
- [ ] `feishu_scopes` ✅，或人明确表示不需要文档 / 表格工具。
- [ ] 常驻服务在运行（§7 的验证命令），日志里有 `ws client ready`。
- [ ] 人私聊机器人能收到回复；人发 `/status` 能看到会话信息。
- [ ] `git status` 里没有 `.env`、`data/`。你没有在对话里输出过任何密钥。

## 10. 常见故障

| 现象 | 原因 / 处理 |
|---|---|
| 日志没有 `ws client ready` | 凭据错（`npm run doctor` 的 scope 探测会报 token 错误）；网络不通；代理 |
| 有 `ws client ready`，私聊没有 `[msg]` | 没开「使用长连接接收事件」/ 没加 `im.message.receive_v1` / 没发布版本 / 人不在可用范围。改完都要重新发布 |
| 有 `[msg]`，没回复 | claude 未登录或登录过期（§2.3）；缺 `im:message`；看日志里的报错 |
| 文档 / 表格工具说没权限 | 缺 scope 或改完没发布：`npm run doctor` 的 `feishu_scopes` |
| 需要代理才能上网 | 桥接没有专门的代理配置项：机器要能访问 `open.feishu.cn` / `open.larksuite.com`（含长连接地址）和 Claude 的服务。必须走代理时，可试在启动环境里设 `HTTPS_PROXY`（Node ≥ 22.21 / 24.5 再加 `NODE_USE_ENV_PROXY=1`，让内置 fetch 走代理），**未经验证**，长连接是否走代理取决于飞书 SDK。常驻服务要把这些变量写进 plist / unit 的环境里 |
| 长连接静默断开 | 桥接在 SDK 放弃重连或巡检到 `failed` 时，约 15 秒后主动退出，交给 launchd / systemd 拉起，连环失败会退避到 15 分钟。Windows 启动项不会自动拉起（§7） |
| `.env` 改了不生效 | shell 里 export 过同名变量（dotenv 不覆盖已有变量）：doctor 的 `env_shadowed` 会列出来。前台启动前 `unset`；常驻服务不受影响 |
| 回复了两遍 | 前台进程和常驻服务同时在跑：停掉一个 |
| 常驻服务里找不到 claude / ffmpeg | 服务不读 shell 配置：macOS 重跑 `npm run install-service`（会重新取 `which claude`）；doctor 的 `service_claude_path` 会提示 |

## 11. 升级 / 回滚 / 卸载

- **升级**：

  ```bash
  git pull
  npm ci
  npm run setup
  launchctl kickstart -k gui/$(id -u)/<label>   # Linux: systemctl --user restart feishu-claude-bridge
  ```

  - 先看 [CHANGELOG.md](CHANGELOG.md) 有没有新增的 `.env` 项。新项都在 `.env.example` 里，默认关闭。
  - `.env`、`data/`、`workspace/` 下的记忆不受升级影响。
- **回滚**：

  ```bash
  git checkout v2.3.0
  npm ci
  ```

  然后重启服务。`git tag` 可列出版本。
- **卸载**：
  1. macOS：`npm run uninstall-service`。Linux：按 systemd 示例里的卸载注释。Windows：`uninstall-startup.ps1`。
  2. 删除仓库目录前**先问人**是否要保留 `data/`（会话、owner）和 `workspace/`（记忆、技能）。
  3. 飞书应用在开发者后台由人自行停用。
