# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 安装与文档（让没见过仓库的 AI agent 只凭链接装到可用）

- **新增 `AGENTS.md`**：给 AI agent 的安装手册——每步「命令 / 预期 / 失败怎么办」，`[需要人]` 步骤附中英双语转告话术与核验命令；
  已有 App ID/Secret 与全新建应用两条路径；安全须知、验收清单、升级 / 回滚 / 卸载、可选功能总表。README 顶部提示「把仓库链接交给 AI agent 时先读 AGENTS.md」。
- **新增 `npm run setup`**（`scripts/setup.js`，可重复执行）：Node → 依赖 → claude CLI 与版本 → 登录态（`claude auth status`，拿不准报「未能确认」）
  → `.env` 不存在则从 `.env.example` 生成（权限 600）→ 必填项 → doctor。`--json` 每项 `id / status(ok|warn|fail|needs_human) / message / fix`；
  退出码 0 全绿 / 2 只差人 / 1 有失败。`--set-owner <ou_…>` 写 OWNER_OPEN_ID；OWNER_OPEN_ID 未填时从日志里找「owner 未登记时私聊过机器人的人」。不输出任何密钥值。
- **`npm run doctor`**：新增 `--json`（三态退出码）与 `--root`；依赖没装时报「先 npm ci」而不是抛 `ERR_MODULE_NOT_FOUND`；找不到 claude 时给安装命令、不再倾倒整条 PATH；
  登录邮箱打码；新增常驻服务（launchd plist / PATH 里的 claude / ExitTimeOut）、shell 环境变量覆盖 `.env`、`.env` 值格式、lark-cli / ffmpeg 检查。文本输出格式与退出码 0/1 不变。
- **`npm run register`**：新增 `--no-wait`（打印扫码链接、保存设备码后退出，退出码 2）与 `--resume [--timeout 秒]`（人扫完后取回凭据）；
  没有 TTY 时默认两段式，不再阻塞 10 分钟；`.env` 已有凭据时默认拒绝（避免重复建应用），`--force` 才继续；写凭据前先从 `.env.example` 生成完整 `.env`；
  不打印 App Secret；国际版的后台链接改为 `open.larksuite.com`；`FEISHU_DOMAIN` 从仓库根目录的 `.env` 读，不再依赖当前目录。
- **`npm run install-service`**：plist 写入 `ExitTimeOut = SHUTDOWN_GRACE_SEC + 10`（launchd 默认约 20 秒强杀，优雅退出等不完）；`LAUNCHD_LABEL` / `CLAUDE_BIN` 也读 `.env`；装完打印核验命令。
- **飞书应用由安装过程自动生成，不再要求到开发者后台手工建应用**：默认 `npm run register` 扫码（与 lark-cli `config init --new` 同一个注册接口，每扫一次码一个新应用）；
  新增 `npm run setup -- --link-lark-cli`（`scripts/lib/lark-link.js`）：用 `lark-cli config init --app-id … --app-secret-stdin --brand …` 让 lark-cli 用 `.env` 里同一个应用，Secret 只走 stdin；
  lark-cli 已配置别的应用时报 🙋、加 `--force` 才替换。`npm run setup` 新增 `lark_cli_app` 一项（只读 `lark-cli config show` 的 appId；没装 lark-cli 不报）。
- **新增 `examples/feishu-claude-bridge.service`**：Linux systemd 用户服务示例（本仓库不自动安装）。
- README.md / README.en.md 重写快速开始与功能列表（逐项写默认状态），中英文对齐，去掉内部称呼与内部路径；
  `docs/*-prompt-proposal.md` 去内部化，作为「可选的提示词补充」；旧版从零手写部署手册标注为过时、改指向 AGENTS.md。
- **安装加固**：`npm run register` 在上一条扫码链接没过期时不再重新申请（只重新打印同一条链接和剩余秒数，退出码 2），`--restart` 才作废重来；
  `--resume` 按 pending 里记下的 domain 轮询；register / `setup --set-owner` / doctor 补 owner 写完收紧回 600；`npm run setup` 每次都会把已有 `.env` 收紧为 600。
  owner 候选：日志里只有 1 人时才预填 `--set-owner`，≥2 人只列出、不给命令；`--set-owner` 遇到不同的已有 owner 拒绝覆盖（`--force` 才换），相同值不改动；文档改为 `npm start > bridge.log` 覆盖旧日志。
  `install-service` 发现同 label 的 plist 指向别的目录时拒绝覆盖（退出码 1，`--force` 才改）；doctor 的 `service` 对这种情况只报一条 ⚠️，owner 日志也不再读别的目录的 launchd 日志。
  文档里要解析的 JSON 一律 `npm run -s …`（去掉 npm 横幅）；systemd 示例加 `KillMode=mixed`（停止时只给主进程发 SIGTERM，进行中的 claude 不被一起杀）；
  `--link-lark-cli` 先校验 App ID 以 `cli_` 开头；`claude auth status` 子进程只额外传 `CLAUDE_CODE_OAUTH_TOKEN`。
- 测试：新增 `test/setup.test.js`、`test/register.test.js`（假 fetch，不调真实 claude、不连飞书、不装服务）；既有测试一个未改。

### 新增

- **心跳第二步：机器人事件 + 按钮 + 外部增量（新能力默认全关）**：表情 / 已读 / 撤回事件与卡片按钮回调
  （`card.action.trigger`）接成「owner 对心跳消息的操作」信号，全部由桥接按确定规则处理、不调模型；`sendMarkdown` 返回
  `message_id`（降级纯文本也返回），心跳消息记索引（最多 200 条、保留 14 天）。`HEARTBEAT_BUTTONS=true` 时只涉及一条台账的
  心跳消息带［知道了］［推迟一天］［不做了］：回调校验 owner、索引、nonce、台账后才异步回写（原子写、未知字段保留、journal 记一行），
  否则回「已失效」、不改任何文件；`HEARTBEAT_REPLY_SHORTCUTS=true` 时引用回复的同名短语确定性处理，其余引用回复带台账提示行进对话。
  `HEARTBEAT_WATCH` 实现 `chat_reply` / `approval`：以 owner 身份执行冻结的只读 lark-cli 命令（不经 shell、15 秒超时、输出 1MB 封顶、
  环境变量只给 HOME/PATH/LANG），游标只进不退、指纹不变不调模型、审批隔拍拉、失败降级为只看台账，外部原文进不可信围栏；
  心跳轮里改的 `watch` 不生效（watch 锁）。`HEARTBEAT_UNREAD_PAUSE=N`：最近 N 条心跳消息超过 24 小时未读就暂停发送，
  已读或 `/heartbeat on` 恢复。状态日期比今天晚超过 1 天时按今天计、保留计数；待发队列同一条连续 5 拍发送失败即移出、
  队满丢最旧一条，两者都在下一条成功发出的消息末尾说明；`/heartbeat status` 增加外部增量、watch、按钮、暂停与今日事件计数。
  新增 `.env` 项 `HEARTBEAT_WATCH_MAX` / `_BUTTONS` / `_REPLY_SHORTCUTS` / `_UNREAD_PAUSE`、`LARK_CLI_BIN`。
  `sonnet` 别名与 `HEARTBEAT_MODEL` 默认值统一为 `claude-sonnet-5-5`（`haiku` 别名、`DIAG_MODEL` 不变）。
- **桥接自带心跳（默认关闭）**：交办台账 `workspace/tasks/<slug>.json`（一事一个 JSON，
  open/waiting/done/dropped）。每拍先由脚本读台账，有到期项才调一次模型（`sched:heartbeat`，不续会话、
  无中间进度、自带互斥锁），提示词只含到期条目、title/notes 进不可信围栏；答复不是 `HEARTBEAT_OK` 才以应用身份
  私聊 owner。每日调用上限（按本地日期，重启不清零）、免打扰时段（期间只记状态，结束后合并成一条）、
  同正文 24 小时去重。桥接自己的状态放 `data/heartbeat-state.json`（原子写；损坏时备份并当天停调）。
  新增 `.env` 项 `HEARTBEAT_ENABLED`（精确 `true` 才启动）/ `_INTERVAL_MIN` / `_MAX_RUNS_PER_DAY` /
  `_MODEL` / `_EFFORT` / `_QUIET_HOURS` / `_WATCH`（本版只实现 `none`）。
- **心跳工具档**：`--setting-sources ''` + `--strict-mcp-config`，内置工具白名单 Read/Grep/Glob/Edit/Write，
  写入只预批 `tasks/` 与 `memory/journal/`；无 Bash、lark-cli、联网、飞书 MCP，显式拒绝改 `schedules/`。
- **`/heartbeat on|off|status`**（仅 owner）：只改运行时开关、不写 `.env`；配置未启用时 `on` 拒绝并说明。
- owner 默认工具集新增 `Edit(./tasks/**)`；工作区启动时建 `tasks/`。
- **心跳反复到期退避**：同一条台账连续 3 次被成功送进模型、文件内容哈希一直没变，
  之后每再送一次就按 1 → 2 → 4 → 8 拍递增跳过（封顶 8 拍），文件一变即清零；`escalate_after` 首次越过的那一拍
  不受退避影响。退避中的条目不进提示词、不占每日次数（到期项全在退避里时整拍不调模型，动作记为 `backoff`）；
  退避状态（`stale_runs` / `skip_left` / `escalated`）放 `data/heartbeat-state.json`，`/heartbeat status` 显示退避中的条数。

### 修复

- **心跳每日计数遇时钟回拨被清零**：旧实现只要本地日期与记录日期不同就把计数归零，
  时钟往回拨一下（或回拨后再追回）每日上限就整份重新放出。现在只有本地日期晚于记录日期才翻日；
  日期变早时沿用原日期与计数，并每拍记一行「本机时钟回拨」日志。
- **群聊里的 `/heartbeat` 会回复并改状态**：现在只在 owner 私聊生效；群聊里（包括 owner 本人发的、
  `chat_type` 缺失或不认识的）不回复、不读不改心跳状态，也不落到 Claude。
- **心跳新消息插队、单拍发送超额**：待发队列没补发完（含本拍补发失败）时，本拍新产生的消息
  排到队尾、不再直接发；一拍合计（补发的包 + 新消息）最多发 3 条，超出的下一拍按原顺序再发。
- **调度器并发已满时触发永久丢失**：旧实现先把任务标成 `running` 再检查并发，被挡下的这次触发在下一拍
  因 `due <= last` 被当成「已经跑过」跳过，状态还一直停在 `running`。现在先查并发、被挡的不留占位，下一拍照常触发。

### 测试

- 心跳补测：待发队列首包（或唯一一包）发送失败时队列原样保留、下一拍补发；cron 任务并发已满被延后后
  逐拍补跑并当天落 `done`（新文件 `test/scheduler-cron-defer.test.js`）；心跳提示词永远不以 `/` 开头。

### owner 工具档（第一步）

- **owner 工具档 `OWNER_TOOL_PROFILE=legacy|audit|strict`（默认 `legacy`，合入后线上行为不变）**：策略表
  `src/tool-policy.js`（纯数据 + 纯函数）把 lark-cli 按子命令分成 read / write / confirm / chat-only / deny 五级，
  argv 生成、审计判定、回放脚本共用这一张表。legacy 档下 owner、定时、心跳、访客四类调用的 argv 与改动前逐字一致。
- **audit 档**：`--setting-sources project` + `--strict-mcp-config`（用户级 allow、hooks、插件、技能、`CLAUDE.md` 不再加载，
  只挂桥接自己的飞书 MCP）；工具照常可用、不拦截，按 strict 规则判定「将会拒绝」并记审计日志。
- **strict 档**：内置工具白名单 `Read,Grep,Glob,Edit,Write,Bash,WebSearch,ToolSearch,Skill`，lark-cli 按策略表逐条放行
  （每条子命令兼容 `--as user|bot` 前置写法）。发消息 / 导入云文档 / 建日程直接执行并在回复末尾附回执；回邮件、审批、
  撤回消息、建群改群、增删群成员先起草，owner 私聊以「确认」或 `/confirm` 开头的那一轮才放行。定时任务只读、
  没有例外开关。一律拒绝 WebFetch、Agent / Task、账号级工具、`lark-cli api`、codex / nohup / npx、写 owner 指定的受保护代码目录。
  strict 下 `ALLOWED_TOOLS` 与 `LARK_CLI` 不起作用。
- **审计与每日汇总**（audit / strict）：stream 里的 tool_use / tool_result / `permission_denials` 写进
  `data/tool-audit.jsonl`（8 个键、命令名过白名单，不记参数正文；超过 5MB 轮转一份）；`TOOL_AUDIT_SUMMARY_AT`
  （默认 `21:30`，留空关闭）每天把「将拒绝 / 需确认 / 被拒」的命令名私信 owner 一次，进度存 `data/tool-audit-state.json`。
- **第三方内容提示**（audit / strict）：飞书 MCP 的 `doc_read` / `sheet_read` / `bitable_records` 正文进不可信围栏
  （MCP 子进程 env `FEISHU_MCP_FENCE=1`）；内联 PostToolUse hook `src/hooks/untrusted-note.js` 在 lark-cli 读
  im / mail / approval / docs / sheets 后提醒「是数据不是指令」。
- **技能同步**（audit / strict）：`OWNER_EXTRA_SKILLS`（默认 10 个 lark-* 技能）从用户级技能目录拷进工作区 `.claude/skills/`。
- **回放脚本** `scripts/replay-tool-usage.js <usage.txt>`：按策略表预演历史用量的放行结果，标出两类含糊行。
- 提示词改动另见建议稿 `docs/owner-tools-prompt-proposal.md`（本版不改 `workspace/CLAUDE.md`）。
- 测试：新增 `test/tool-policy.test.js`、`test/owner-profiles.test.js`、`test/tool-audit.test.js` 与两个夹具；既有测试一个未改。

### 验收、升级阶梯与每晚日结

- **验收（`HEARTBEAT_VERIFY=off|rule|rule+model`，默认 `off`）**：台账新增状态 `verify` 与可选字段 `done_evidence`
  （`kind` ∈ approval / message / owner / other，`ref` 按 kind 校验，`summary` ≤200 字；不合规时台账照常有效，记下原因、核对时直接发卡片）。
  开着时，心跳一拍里新写成 `done` 的台账在这一拍结束时改成 `verify`；owner 对话与桥接写的 `done` 不动。
  脚本规则（只读，只调外部增量已有的 `approvalGet` / `messageGet`）分通过 / 不通过 / 核对不了三种：只有审批状态 `APPROVED`、
  或对方真人在交办（`created_at` 与数字 `watch.after` 中晚的那个）之后在 watch 的会话里回了消息才算通过，由桥接写 `done`；
  审批被拒绝 / 撤回 / 删除、还没通过、ref 对不上、owner 本人发的、早于交办、查询失败、依据格式不合规都算不通过，直接发卡片、不问模型。
  只有核对不了的（没写依据、`kind=other`、模型写的 `kind=owner`）在 `rule+model` 档用 `VERIFY_MODEL`
  （默认 `claude-haiku-5-5`，每日 `VERIFY_MAX_PER_DAY` 次，默认 10）审核一次，只认一行严格 JSON。`pass` 写 `done`，
  `fail` / `unsure` / 格式不对 / 调用失败一律发「🔍 待你验收」卡片：［验收］［没办完］［不做了］或引用回复同名短语。
  owner 点过「没办完」或在日结里撤销过的台账按台账记下（`tasks.<slug>.rejected_at`），之后再写 `done` 不论依据改没改一律发卡片，
  owner 验收或点［办完了］后清掉。
- **verifier 工具档**（`toolProfile:'verifier'`，仅 owner 调用生效）：`--tools ''`、`--setting-sources ''`、`--strict-mcp-config`，
  不续会话、`--effort low`，cwd 为每次新建、用完即删的系统临时目录（只删 `os.tmpdir()` 正下方 `feishu-verifier-` 开头的那个）；
  owner / 定时 / 心跳 / 访客四类 argv 逐字不变。
- **升级阶梯（`HEARTBEAT_ESCALATE_LADDER=true`，默认关；`ESCALATE_MAX` 默认 2）**：`escalate_after` 越过后第 1 级照旧是心跳消息
  （同一拍一起越过的几条、进了待发队列或 24 小时内发过同样的，都登第 1 级；不记消息 ID 的按没读等 48 小时），
  之后按固定模板（不调模型）再提醒。上一级读了满 24 小时、或没读满 48 小时才升一级（没读不叠发），点过「知道了」就不再升；
  到顶后只进日结「卡住」。模板消息多一个［办完了］按钮 / 短语，由桥接写 `done` 与 `kind=owner` 依据。
- **每晚台账日结（`HEARTBEAT_DIGEST_AT=HH:MM`，默认空＝关）**：五栏（今天办完并注明方式 / 今天放弃 / 待你验收 / 卡住 / 明天到期），
  每栏最多 5 条、整条不超过 15 行，五栏全空不发；只读台账与桥接自己记的状态变化（状态文件新增 `history`），不读 journal、不调模型。
  「今天办完 / 今天放弃」从上一份日结的时刻（`history.digest_at`）往后数，日结发完之后或没发日结那天关的单进下一份。
  自动判定办完的带圈号与［撤销］按钮，撤销后改回 `open`、明天再看；一天一次、重启不重发、晚到 30 分钟不补发，发出后 journal 记一段。
- **`/heartbeat status`** 增加验收、升级阶梯、日结三行，台账分布在验收开着或有待验收时多一栏 `verify`。
- **优雅退出**：SIGTERM / SIGINT 后不再接新消息（新消息回「正在重启，请稍后重发」）、停心跳与日结定时器，等进行中的对话轮、
  定时任务与心跳一拍做完再退出，最多 `SHUTDOWN_GRACE_SEC` 秒（默认 120）；第二次信号立即退出。
- 状态文件 `data/heartbeat-state.json` 新增顶层键 `verify` / `history` / `verify_runs` 与 `tasks.<slug>.esc`，缺了当空，不升版本号。
- 提示词改动另见建议稿 `docs/vr-prompt-proposal.md`（本版不改 `workspace/CLAUDE.md`）。
- 测试：新增 `test/verifier.test.js`、`test/digest.test.js`、`test/shutdown.test.js` 与共用夹具 `test/vr-harness.js`；
  `test/heartbeat.test.js`、`test/owner-tools.test.js` 只新增用例与断言，既有断言一条未改。

### owner 工具档（第二步：strict 补洞）

> strict 档补洞：技能 / `.claude` 提权路、写文件落点、排查诊断工具面、群聊回执。全部只在 `audit` / `strict` 下生效，`legacy` 逐字不变。

- **技能提权封堵（audit / strict）**：同步技能时，`SKILL.md` 的 frontmatter 顶层键若是 `allowed-tools` / `hooks`
  （含 `"allowed-tools"` 引号写法、`allowed_tools` 下划线变体、`disallowed-tools`）连同其缩进续行一起剥掉，正文一字不动、无 frontmatter 原样保留；
  技能树里的符号链接（含指向目录的）整棵跳过。用户级 `lark-*` 技能（`syncExtraSkills`）同样剥。
- **`.claude` 外来文件隔离（audit / strict）**：工作区 `.claude/` 下除桥接自己同步的真目录 `skills/` 外，
  `settings*.json` / `hooks/` / `commands/` / `agents/` / `CLAUDE.md` 等一律移进 `workspace/.claude-quarantine/`（带时间戳改名、不加载也不删）。
  strict 下隔离失败即 fail closed——抛「claude CLI 启动失败」（命中 `NEVER_RETRY`，不重试、宁可本轮不跑）；audit 兜底继续并记「无法隔离」日志。
  `skills/` 被换成软链或文件时同样隔离。legacy 仍是逐字节 `cpSync`，不隔离、不剥 frontmatter、不同步用户级技能。
- **strict 对话去掉 `skills/` 写权（Q1-B）**：strict 对话档 `--allowedTools` 不再含 `Edit(./skills/**)` / `Write(./skills/**)`，
  仍保留 `memory/` / `schedules/` / `outbox/` / `tasks/` 的写权。技能只能由桥接单向同步进来。
- **写文件落点闸（audit / strict）**：`lark-cli` 读类子命令若带 `--output` / `-o` / `>` / `>>` / `| tee`，落点必须在工作区 `outbox/`
  或系统临时目录，否则 strict 拒绝、audit 记「将会拒绝」；`.claude/`、`CLAUDE.md`、`schedules/`、`skills/`、`tasks/`、`.mcp.json`
  永不是合法落点；`cd` 进保护区后的相对落点、`../` 与符号链接逃逸都按物理路径判。纯函数 `checkOutputTargets` / `outputTargets`
  （`src/tool-policy.js`）可注入 `realpath`/`readlink`；内联 PreToolUse 钩子 `src/hooks/output-guard.js` 一律 fail closed（坏输入 / 缺 workspace / 缺命令都 `exit 2`，任何分支都不输出 `allow`）。
- **排查诊断（sched-diag）无工具档（audit / strict，Q2）**：定时任务排查诊断轮用 `--setting-sources ''` + `--strict-mcp-config` + `--tools ''`
  （外加 `--disallowedTools` 黑名单兜底、`autoMemoryEnabled:false`），`job.prompt` 与报错包进随机 nonce 的不可信围栏；legacy 的排查诊断逐字不变。
- **群聊不附回执（Q3）**：owner 以名义对外的动作，回执「— 本轮以你名义：…」只在 owner 私聊（`p2p`）末尾追加；
  群聊轮不附回执（群里的写动作仍照常记审计）。
- 提示词改动另见建议稿 `docs/owner-tools-prompt-proposal.md` §五（本版不改 `workspace/CLAUDE.md`）。这一步未引入新 `.env` 项。
- 测试：新增 `test/owner-profiles-perm2.test.js`（legacy 全矩阵回归、同步树、隔离 + 剥键、fail-closed、Q1-B、sched-diag）、
  `test/tool-policy-output.test.js`（落点闸纯函数 / 真实软链逃逸 / 审计 judge 闸 / 钩子子进程 / 词法分类对基线逐字回归）与两个夹具；
  既有 `test/owner-profiles.test.js`、`test/tool-audit.test.js` 各补测。
- **第一轮修正**：
  - `.claude/skills` 改为整树重建（`.claude-staging/<pid>-<序号>-<8 位随机 hex>/` 暂存后整体换上），存量外来技能 / 软链进
    `.claude-quarantine/skills-<名>.<时间戳>`；拷贝目的地一律 `wx` / `COPYFILE_EXCL` 新建，不再跟随软链写穿。
  - `SKILL.md` frontmatter 从「黑名单剥键」改为「白名单重建」（只留 `name` / `description` / `version` / `metadata`）；开头分隔行带空白、
    或与 CLI 截取不一致时整个技能不拷。
  - 用户级 `lark-*` 顶层软链按 realpath 解引用，只认 `~/.agents/skills` 的直接子目录（`~/.claude/skills` 根暂不认，见停卡项）。
  - `.claude` 本身是软链 / 文件时只挪链接本身；`.claude-quarantine` / `.claude-staging` 不是真目录算隔离失败。
  - 落点闸新增隐式落点：`drive +download`、`im +messages-resource(s)-download` 不带输出参数按写当前目录判，`--download-resources`
    按写 `./lark-im-resources/` 判；钩子拒绝文案提示显式写 `--output`。
  - 钩子只静态 import `node:*`，判定模块动态加载，加载失败 / 未捕获异常都 `exit 2`。
  - 新增导出 `usesEqAsPrefix`：`lark-cli --as=user …` 在审计判定里一律 deny（`classifyCommand` / strict argv 不变）。
  - sched-diag（audit / strict）任务名单行化、限 80 字。
  - 测试：新增 `test/skills-sync-perm2.test.js`，`test/tool-policy-output.test.js` / `test/owner-profiles-perm2.test.js` 补用例。
- **第二轮修正**：隐式落点所在那一段自己用 `env -C` / `--chdir` / 嵌套 `sh -c` 的 `cd` 改了目录时不按 `cd` 链判、退回全部 base；用户级技能软链只认 `~/.agents/skills`；补测对应用例。

### owner 私聊忙时连续发消息（排队、合并、接着办）

> 助理忙时 owner 可以连续发消息：排队、合并、接着办。新开关 `OWNER_MESSAGE_QUEUE` 默认关，关着时与以前逐项相同。

- **owner 私聊忙时排队（`OWNER_MESSAGE_QUEUE=true`，精确 `true` 才开）**：会话正忙时（从这一轮排进会话起，到回复发完为止）
  到达的普通消息（非生命周期命令、非 `/redirect`）不再回「还在跑」，进内存队列（每个会话键一条，上限 10 条；满了回
  「排队已满（10 条），等手头的办完再发」、不入队）。入队成功加表情（`OnIt`，与开轮时同一个）；加表情失败退回为每一轮忙碌期只回一次
  「收到，办完手头的接着办这条」。附件 / 图片 / 富文本照现有接收路径在入队前处理好，失败照旧当场告知。
- **接着办**：当前轮结束（答完、出错、被取消、整轮抛异常都算）后一次取走此刻队列里的全部消息：1 条照平时路径（引用回复快捷、
  台账提示与空闲时直接发完全相同；确认通道例外，见下「第一轮修正」）；多条按到达顺序合并成一轮，开头注明这些是 owner 在助理忙时
  连续发来的消息、按顺序一并处理、后面的可能是对前面的补充或更正，每条前标「第 N 条（HH:MM）」，回复挂最后一条，任一条是执行指令就整轮走执行车道。
  合并轮不触发确认通道（strict 档下其中的「确认」不算数，并提示 owner 单独再回「确认」），也不触发引用回复快捷（快捷只在到达时判定一次）。
- **取消与生命周期命令**：`/cancel`（或「取消」）取消并清空队列，同一条回复里说明清掉几条；`/redirect X` 取消、清空（另回一句条数）、只按 X 重来；
  `/new` 照旧处理，队列非空时一并清空并先回一句清掉几条；`/voice`、`/tasks` 等其它命令不清队列。`/status` 在 owner 私聊（开关开着）多一行「排队消息: N 条」。
- **优雅退出**：还没轮到的排队消息逐条回「助理正在重启，这条没处理，请稍后重发」，这些回复发完前不退出（计入进行中）；进行中那轮做完后不再出队。
- 群聊、访客、非 owner、定时任务、心跳完全不变；排队文字按 owner 输入对待，第三方内容的不可信围栏原样保留，合并 prompt 照旧经 stdin 传给 claude。
- 新增 `src/message-queue.js`；`src/index.js` 把原 `handleMessage` 末段原样拆成 `runTurn(spec)`（出队时复用同一条路径），`enqueue` 挂轮次开始 / 结束钩子，
  `react` 返回是否加上（既有调用方不看返回值）。测试：新增 `test/message-queue.test.js`（MQ-1…MQ-10，执行 index.js 真实代码段、依赖全桩），既有测试一条未改。
- **第一轮修正**：
  - `/voice`、`/voice on|off`、`/tasks` 不再清队列（只有 `/new`、`/cancel`、「取消」、`/redirect` 清）；
  - 入队表情改为 `OnIt`（仓库里 runTurn 开轮时每轮都在用的那个；原先选的类型没核实过）；
  - strict 档下单独排队的「确认」出队时不放行确认级操作（排队期间上一轮可能已出新草稿），原样交给模型并提示 owner 看完最新回复再单独回「确认」；
  - 附件下载慢时出队先等更早到、还没接收完的消息（最多 30 秒，`ARRIVAL_HOLD_MS`），合并仍按到达顺序；下载失败照旧告知、不拖住后面的；到点先办已排好的，迟到的进下一轮；
  - 文档写明优雅退出的例外：`SHUTDOWN_GRACE_SEC=0`、二次信号、SIGKILL、崩溃、launchd 提前强杀时排队消息直接丢、不回「请重发」。

### owner 私聊每日新会话（凌晨预交接 + 换新后首条懒切换，默认关闭）

> owner 私聊不再永远续同一条会话：每天凌晨先交接（写台账 / 记忆、出一段摘要），换新时刻之后的第一条消息起换新会话并带上接续材料。新开关 `DAILY_SESSION` 默认 `off`，关着时逐字照旧。

- **开关**：`DAILY_SESSION=off|shadow|on`（乱值按 off 并打日志）；`DAILY_SESSION_AT`（默认 `04:00`）、`DAILY_SESSION_HANDOFF_AT`（默认 `03:30`，留空不预交接，不早于 AT 时按留空）、
  `DAILY_SESSION_ROUNDS`（默认 10，0–30）、`DAILY_SESSION_KEEP_DAYS`（默认 14，1–28）。只作用于 owner 私聊。`shadow` 只记原话、只打「该切 / 推迟」日志（无正文）。
- **新模块 `src/daily-session.js`**（纯逻辑，时钟 / 文件系统 / 定时器可注入）与接线 `src/daily-session-live.js`：状态 `data/daily-session/state.json`（原子写、永不抛，读坏按无状态）、
  原话环形文件（最近 30 轮，落盘前脱敏）、交接摘要文件；`data/sessions.json` 格式不变（零迁移）。
- **交接档**（`src/claude.js`，`toolProfile: 'handoff'`）：续调用方给的会话、`--tools Read,Grep,Glob,Edit,Write`、只预批 `Read(./**)`、`Edit(./memory/**)`、`Edit(./tasks/**)`，
  黑名单在心跳的基础上再点名 Bash / 联网 / 飞书与 schedules、skills、outbox、CLAUDE.md、`.claude`；`--setting-sources ''`、`--strict-mcp-config`；不受任何 owner 工具配置影响；没有 resumeId 直接抛错。
  `runClaude` 新增 `persistSession:false`（交接轮的结果 id 不写回）；新增 `getSessionId` / `restoreSession`（回退用，不动代际计数）。
- **切换规则**：AT 之后第一条消息换新；第一次见到的会话先接管不换；「确认」、排队出队的单条、带「确认」的合并轮永远不在当轮换（判定对原 prompt 做，不复用排队轮里被强制成不放行的确认结果）；
  裸 `/do`、`/redirect` 推迟、连续第 3 条强制换。切换那轮删掉已拼上的固化提醒；新会话首轮确定没动过手（`producedOutput === false`）就失败才自动退回原会话，已有输出或说不清的不退回、不叫重发；
  换新那轮结束后还没有新会话 id，下一条重带接续材料。`runClaude` 的取消、超时、启动失败三种错误也带上 `producedOutput`（重试判定不变）。
- **接续材料**：交接摘要与 journal 也放进与原话同一 nonce 的不可信围栏；新会话首条回复与 `/session` 列出交接改了哪几个文件（最多 5 个，状态里只存路径、最多 20 条）。
- **命令**：`/session [status|back|auto|rotate]`（只在 owner 私聊；群里不回复）；`/status` 末尾多一行（off 时不加）；`/new` 在非 off 时把被清的会话记进可退回列表。HELP 加一行。
- **预交接定时器**：照日结的 arm / tick 写法，排进 owner 会话同一个队列（和对话串行、计入优雅退出的在途数），硬超时 5 分钟取消；进入优雅退出后不再开始新的交接；重启时把 `running` 记为 `failed`。
- **启动自检**：显式配置 `ALLOWED_TOOLS` 且缺默认 owner 工具里的 `Edit(./…/**)` 写入项时，打一行 `[config] ⚠️` 列出缺的项名（不打整行配置、不改权限）。
- **回放对比脚本** `scripts/daily-session-replay.js`（只读两臂、盲评、产物只写 `--out`、`--dry-run` 只打 argv）与占位题目 `scripts/daily-session-replay.questions.example.txt`。
- **提示词**：新增 `docs/ds-prompt-proposal.md`（「接续材料」「交接轮」两节与「新写入的记忆当天写全」一句）；本版不改 `workspace/CLAUDE.md`，把 `DAILY_SESSION` 改成 `on` 的当天再并入。README 中英、AGENTS.md 可选功能表补一行。
- 测试：新增 `test/daily-session.test.js`、`test/daily-session-replay.test.js`；既有测试与夹具一条未改。

## [2.3.0] - 2026-09-14

### 新增

- **聊天/规划与执行分工两个模型**：`CLAUDE_MODEL`（如 fable 5.1）负责平常对话与规划，
  `CLAUDE_EXEC_MODEL`（如 sonnet 5）负责执行。消息以 `/do` `/exec` `/run` 开头、或句首是
  「执行」「开始执行」「去做」「动手」「go」「do it」等触发词时，这一轮切到执行模型，
  会话通过 `--resume` 保留——执行模型看得见刚谈妥的计划。判定是确定性的（前缀/句首词边界），
  不靠模型猜：「执行力很重要」「google 一下」都不会误切；`EXEC_TRIGGERS` 可整体覆盖。
  定时任务默认走执行车道（任务自带 `model` 优先）。`/model` 显示两个模型，`/model exec <模型|off>`
  随时切换；`set-model` 定时动作支持 `exec_model` / `exec_effort`。留空 `CLAUDE_EXEC_MODEL` 即关闭，
  老配置行为字节不变。
- **`npm run doctor` 安装体检**：Node ≥ 18（失败给免 sudo 的 tarball 安装命令）、npm ≥ 11 的
  install-scripts 警告说明、claude CLI 版本与登录态（`claude auth status`）、`.env` 必填项
  （`OWNER_OPEN_ID` 为空而 `data/owner.json` 有值时自动补写）、owner 工作区目录、飞书 scope 探测。
- **启动时自检飞书 scope**：`GET /application/v6/scopes` 查已开通权限，对照 10 个 MCP 工具逐个判定，
  不可用的列进日志与启动通知，附可直接粘贴到「权限管理 → 批量导入」的 JSON。
  `npm run register` 成功后同样打印这段——注册接口建出来的应用是**零权限**，此前没有任何提示，
  10 个工具里 7 个静默失效。
- **`npm run install-service` / `uninstall-service`（macOS）**：用当前 `node`、本仓库目录与
  `which claude` 的结果生成 plist 并 `launchctl bootstrap`，不再手改 5 处占位符；PATH 把 node
  与 claude 所在目录排最前，消除「launchd 用到另一份 claude」的坑。`LAUNCHD_LABEL` 可指定 label。
- **可选 lark-cli 集成**：`LARK_CLI=true` 只给 owner 加一条 `Bash(lark-cli:*)`（拼接命令与其他
  Bash 仍被拒，访客永远拿不到），覆盖审批/日历/任务等租户身份答不了的查询。
- README 新增「飞书侧能做什么、不能做什么」表格与两模型分工说明；前置条件挪到快速开始代码块之前。

### 修复

- **owner 工作区从不被创建**：仓库只带 `workspace/CLAUDE.md`，`memory/`、`skills/` 要靠机器人
  第一次写入时自己建，而它没有建目录的权限；`CLAUDE.md` 里 `@memory/USER.md`、`@memory/MEMORY.md`
  两行 `@import` 一直悬空。现在启动时建好 `memory/journal`、`skills`、`schedules`、`outbox`、`incoming`
  并写入 `USER.md` / `MEMORY.md` 种子（已有内容一个字节不动）。
- **默认工具集没有任何写入工具**：`ALLOWED_TOOLS` 默认值只有 `Read,Grep,Glob,WebSearch,WebFetch`，
  README 与 CLAUDE.md 承诺的三层记忆、技能沉淀、自建定时任务、文件回传在开箱状态下全部写不进去。
  默认值改为含 `Edit(./memory/**)`、`Edit(./skills/**)`、`Edit(./schedules/**)`、`Edit(./outbox/**)`。
  注意 CLI 的文件权限规则只认 `Edit(path)`（覆盖 Write 等全部编辑工具），`Write(path)` 写法不会被匹配。
- **`register.js` 拿到 open_id 却不写 `OWNER_OPEN_ID`**：现在与凭据一起写入 `.env`；
  `.env` 回写统一为一份实现（`src/env-file.js`，原子替换、保留注释）。
- **App Secret 出现在进程命令行**：`--mcp-config` 此前把凭据 JSON 拼进 argv，`ps aux` 可见。
  改为 0600 临时文件，子进程结束即删。
- **启动通知从未带上自检结果**：`announceStartup()` 在 config 块之前调用，`cliProblem` 在发通知那一刻
  永远是 null——「启动自检发现问题」那段文案从未真正发出过。现改为所有自检完成后再发。

### 测试

- 新增 8 个测试文件、73 条测试（45 → 118；车道判定/模型选择、工作区种子、默认工具集、scope 判定与
  桩 fetch、.env 回写、凭据不进 argv、plist 生成与 `--dry-run` 真跑、doctor 单项与真跑）。

## [2.2.0] - 2026-09-02

### 新增

- **读得到你引用的那条消息**。飞书的「回复」把被引用内容放在另一条消息上（`parent_id`），
  事件里只带一个 id——此前完全没被读取，于是你引用一份文档说「这份也读一读」，
  机器人看到的只有「读一读」，只能回一句「你没给我链接」。现在会拉取被引用消息
  （含其中的图片/文件），并按来源区别对待：引用自己的当作你提供的材料，
  引用他人的进不可信围栏；拉取失败则降级为正常处理，不让整条消息报错。
- **邮件附件能读了**（`mcp__feishu__mail_attachment_download`）。此前是一条断链：
  `lark-cli` 能列出附件元数据、也能换到下载链接，但机器人没有 curl 也没有通用 Bash，
  拿到 URL 也落不了地；WebFetch 只把网页转成文本，对 PDF/docx 无用——于是永远停在
  「看得见附件名字，读不到内容」。新工具把「取链接 → 下载到工作区」补上，
  模型随后用 Read 打开即可。文件名按「调用方传入 → 响应头解码 → 附件 id」三级回退，
  避免丢掉扩展名导致 Read 认不出类型。

### 说明

引用消息为飞书/Lark 特性（钉钉与企业微信的消息机制不同，未做未经验证的移植）。
邮件附件工具依赖已登录的 `lark-cli`（走用户身份——邮件在个人邮箱里，应用的租户凭据读不到）。

## [2.1.1] - 2026-09-02

### 修复

- **附件下载遇到瞬时网络故障会自动重试**（2 次，退避 1s/3s）。此前 `EHOSTUNREACH`
  这类抖动会直接变成一句「处理失败」，而重发往往就好了。
- **错误提示不再把所有失败都说成权限问题**。此前无论真因是什么，都会附上
  「请确认已开通 im:resource 权限」；而平台 SDK 的 AxiosError 常常 `message` 为空，
  用户看到的是「处理该消息失败：」后面一片空白 + 一句误导性的建议。
  现在按类型分流：网络问题说是网络问题并提示重发，权限问题才给权限建议
  并带上接口返回码，其余情况也保证有可读描述。

## [2.1.0] - 2026-09-02

### 新增

- **启动时自检 claude CLI**：打印桥接**实际会调用**的那个可执行文件路径与版本，
  并在版本不足以运行当前模型时告警（日志 + 启动通知里一并告知 owner）。
- **`/model` 切换前预检**：本机 CLI 跑不动目标模型时直接拒绝切换并说明原因，
  不再出现「切换成功、然后每条消息都失败」。
- **`/status` 显示 CLI 路径与版本**。

### 背景

一台机器上可能装了多份 claude（如 nvm 一份、homebrew 一份），子进程按 **PATH 顺序**解析。
升级了终端里那份、而进程管理器的 PATH 指向另一份时，模型切换后每条消息都会返回
`400 does not support this model`——桥接自身看着一切正常，问题只在用户发消息那一刻暴露。
自检把这件事挪到启动时，并直接点明用的是哪个路径下的哪个版本。

## [2.0.4] - 2026-09-02

### 新增

- **启动时打印真正生效的模型与思考档**，并在检测到 `.env` 的值被 shell 环境变量
  覆盖时明确告警。dotenv 不会覆盖已存在的环境变量——若在终端 export 过
  `CLAUDE_MODEL`/`CLAUDE_EFFORT` 再手动启动，`.env` 会被**静默忽略**，
  此前只能靠追代码才能发现。

## [2.0.3] - 2026-09-02

### 变更

- **`fable` 别名默认指向 Claude Fable 5.1**（`claude-fable-5-1`）。
  `/model fable`、定时任务的 `model` 字段、`.env` 的 `CLAUDE_MODEL` 三条路径一致生效。
  - 需要 **Claude Code CLI ≥ 2.1.251**；旧版会报 `does not support this model`，
    跑 `claude update` 升级即可。
  - 想留在上一代用 `fable5`（→ `claude-fable-5`）；`fable5.1` 与 `fable` 等价。
  - 注意完整 ID 是 `claude-fable-5-1`，写成 `claude-fable-5.1` 是无效的。

## [2.0.2] - 2026-08-30

验收报告里剩余的中低优先级问题一次清完。无破坏性变更。

### 安全加固

- **访客工具的硬下限**：`Bash`/`Write`/`SendMessage`/`Artifact`/`Workflow` 等高危工具
  现在写死在代码里，`GUEST_TOOLS` 环境变量只能往白名单里**加别的**，解不开这些
  （此前配错 env 就能把限制整个放宽）。
- **访客系统提示词按身份分叉**：不再把 outbox、定时任务、chat_id 这些 owner 侧概念
  讲给访客——它没有这些能力，讲了只会诱导它去尝试。

### 修复

- 进度卡片的串行化改为真正的串行链：此前是「await 当前在途请求的快照」，
  三个并发刷新里第三个仍会与第二个并行，重复建卡。
- `/redirect` 与 `/new` 现在也会叫停**退避等待中**的重试（此前只 `cancelRun`，
  退避期内旧要求会照跑完再执行新要求）。
- 聊天失败路径也清空本轮 outbox，避免失败轮写的文件挂到下一次成功回答上一起发出。
- 状态文件路径改用 `store.js` 导出的 `DATA_DIR`：自定义 `WORKSPACE_DIR` 时，
  原先推导出的目录可能不存在，写入被静默吞掉、启动通知去重永久失效。
- 退出阻尼改为**跨重启累积的递增退避**（15s→1m→5m→15m，稳定运行 5 分钟即清零），
  并把 launchd 示例的 `ThrottleInterval` 由 10 提到 60。
- `/tasks` 在状态文件尚未生成时正常显示任务列表，不再整体报错。
- 纯日期形式的一次性任务（`2026-09-01`）按本地零点解析，不再被当作 UTC 而偏移时区。
- v1.x 遗留在 `outbox/` 根目录的文件启动时归拢到 `outbox/_legacy/`：
  升级后它们既发不出也清不掉，会一直躺在那里。

### 文档

- 新增 `.env.example`，按「必填 / owner 身份 / 访问控制 / 安全 / CLI / 调度 / 其他」
  分组列出全部开关，注明默认值与留空后果。
- README 更正 owner 认领的措辞：v2.0.0 起默认**不再**由「首个私聊者自动成为 owner」，
  手动安装需在 `.env` 设 `OWNER_OPEN_ID`。

## [2.0.1] - 2026-08-30

### 安全（重要，建议从 2.0.0 立即升级）

发布后验收实测发现：v2.0.0 的访客限制建立在**黑名单**（`--disallowedTools`）上，
而黑名单只能挡住列进去的名字——实测访客手里仍有 **22 个内置工具**，包括
`SendMessage`、`Artifact`、`CronCreate`、`Workflow`、`ListAgents`。更要命的是，
访客进程跑在 **owner 自己的 Claude 账号身份**下，因此一个非 owner 可以：
以 owner 名义发布 Artifact 网页、创建定时任务，甚至把消息**注入 owner 正在运行的
高权限会话**（那些会话有完整的 Bash/写文件能力）。

- **改用白名单**：访客现在走 `--tools`，只有显式列出的内置工具存在。
  实测工具数由 22 降为 1（`WebSearch`）。白名单同时面向未来——CLI 以后新增的内置工具
  不会自动对访客开放。黑名单保留作双保险。
- **默认移除访客的 WebFetch**：它不限制目标地址，实测可连 `http://127.0.0.1:3000`
  探测本机端口（错误信息即泄露可达性），也能把数据编码进 URL 外传。
  需要访客读网页时用 `GUEST_TOOLS=WebSearch,WebFetch` 显式开启。
- **访客不再加载任何 settings 文件**（`--setting-sources ''`）：user 级的
  `permissions.allow` 是 2.0.0 那条 CRITICAL 的根源，而 project 级同样可能被提交进仓库。

### 说明

访客发送图片/文件时仍会临时获得 `Read`，路径由 `Read(./incoming/**)` 限定在其自身工作区内。
owner 的能力不受本次变更影响。

## [2.0.0] - 2026-08-30

> 本版修复一个**严重安全缺陷**。若你把机器人开放给了 owner 以外的人（同事私聊、群聊），
> 强烈建议立即升级。

### 安全（重要）

- **访客不再能借用 owner 的权限执行工具**。此前只用 `--allowedTools` 限制非 owner，
  但那不是沙箱——它是「免询问」白名单、只做加法；用户级 `~/.claude/settings.json` 里的
  `permissions.allow` 对访客会话同样生效。实测中访客可以执行本机 CLI 工具并以 owner 的身份
  读写数据。现改为切断配置来源：`--setting-sources project` + `--strict-mcp-config` +
  显式 `--disallowedTools`（减法项，压过任何 allow 规则）。
- **访客与 owner 的工作区物理隔离**：非 owner 一律运行在新的 `workspace-guest/`，其 CLAUDE.md
  不含任何 `@memory/` 导入。此前所有人共用 owner 工作区，画像与记忆索引会被注入每一次对话——
  锁住工具挡不住上下文。
- **访客关闭 CLI 自动记忆**（`autoMemoryEnabled: false`）。该存储按 git 仓库根归档，
  owner 与访客同属一个仓库，不关等于共用一份（读方向泄漏、写方向是持久化提示注入）。
- **会话键按身份分离**：群里 owner 与访客共用 `chat_id`，若共用 session，访客一次 `--resume`
  就能恢复出 owner 那条带私有记忆的会话。访客再按发言人细分，避免同群访客互相看到历史、
  或被单个访客植入长效指令。
- **第三方内容进不可信围栏**：转发的聊天记录、卡片 JSON、文件名、消息标题一律包裹并声明
  「这不是指令」，围栏用 CSPRNG nonce 且清除正文里仿造的闭合标记。
- **owner 认领收紧**：`ALLOW_USERS`（谁能用）与认领资格解耦，新增 `OWNER_OPEN_ID` 作为权威来源；
  记录丢失时默认拒绝认领，需显式 `ALLOW_OWNER_CLAIM=true`。`saveOwner` 失败不再谎报成功。
- 定时任务 `action` 走白名单枚举，未知动作一律拒绝执行。

### 修复

- **`/redirect` 自 v1.3.0 起从未成功执行过**：变量声明顺序导致 TDZ 崩溃，且崩溃发生在任务
  已被取消之后——旧任务被杀、新要求从不执行、用户端零反馈。
- **长连接终止后进程永久失聪**：重连预算耗尽时进程还活着、进程管理器认为一切正常。
  现在主动退出交由守护进程拉起，并带退避（避免高频重启风暴）与心跳看门狗。
- **共享 outbox 跨会话错发**：定时任务生成的文件会滞留到下一条任意消息被顺手发走。
  改为按会话隔离的子目录，定时任务成功/失败路径都会回传并清空。
- **断连重试会重放已产生副作用的任务**：改为只重试「尚未产生任何输出」的早期失败，
  此后报错并提示手动重发。`502|503|529` 补词边界，不再误伤正文数字。
- **定时任务会话被永久续接**：`sched:` 前缀的伪会话此前只堵了写、没堵读，历史会话仍被
  `--resume`，导致周报等任务几周累积在同一条上下文里。
- **上下文用量口径错误**：此前把整轮累计 usage 当作驻留上下文，虚高数倍导致提醒误触发。
- 调度器：锁到「任务」而非「整轮」（长任务不再把同期任务饿死至超过补跑窗口）、状态按 key
  增量写、迟到超窗口跳过、`@daily` 等 cron 宏不再被误判为一次性时间、改期不再立即补跑一次、
  状态可分辨「已执行/已跳过/失败」。
- 进度卡片：节流合并、只保留最近若干步、在途请求串行化（不再重复建卡）、取消与失败也收尾
  （不再永远停在「处理中」）。
- `/cancel` 在重试退避窗口内同样生效，不再谎报「当前没有正在运行的任务」。
- `.env` 与全部状态文件改原子写（写到一半被打断会让启动失败、进程陷入重启循环）。
- 进程级 `uncaughtException`/`unhandledRejection` 兜底；`stdin` EPIPE 与状态写盘失败不再打死进程。
- `/voice on` 不再在已开启时把语音关掉。
- `/new` 在任务运行期间不再被静默撤销（旧任务收尾会把刚删掉的会话写回来）。

### 新增

- **记忆自动召回**：每条消息先在 `memory/`（含 journal）做关键词检索，把可能相关的文件
  提示给模型。此前只靠模型自觉 Grep——写得勤，取的时候常想不起来。
- **`/tasks`**：查看定时任务的上次/下次触发时间与状态。
- **启动通知**：桥接重启后主动告知 owner（30 分钟内去重），进程死亡不再完全静默。
- **无事不报**：定时任务返回 `HEARTBEAT_OK` 时静默跳过，巡检型任务成为可能。
- **任务级模型**：定时任务可写 `model`/`effort` 单独指定档位（日常巡检用便宜模型）。
- **附件 TTL**：`incoming/` 定期清理（实测已累积 24MB）。
- **回归测试**（`npm test`，零额外依赖）：以行为断言为主，并经变异测试验证——
  把修复改回去会立刻变红。

### 破坏性变更

- `workspace/runtime.md` 已废弃：运行配置改为随每次调用注入系统提示词（此前是共享文件，
  并发运行会互相覆写，模型会读到别人的 chat_id）。
- 文件回传目录从 `outbox/` 改为 `outbox/<本轮标识>/`，路径由系统提示词告知；
  写到根目录不再会被发送。
- `schedule-state.json` 记录格式由字符串改为 `{at, when, status}`（向下兼容旧格式）。

## [1.6.0] - 2026-08-13

### 新增
- **三层记忆架构（借鉴 OpenClaw / Hermes Agent）**：`memory/` 拆为画像层（`USER.md`——用户身份、偏好、风格，每次对话自动加载）、事实层（一条记忆一文件 + `MEMORY.md` 索引）、流水层（`journal/YYYY-MM-DD.md` 当日工作笔记，Grep 检索、不占上下文）。
- **主动记忆规则**：不用等用户说「记住」——纠正假设、做出决定、表达偏好、数字口径、时限承诺当场落盘；配套「何时不写」清单、supersede 就地改写不留矛盾、回答历史问题先 Grep 记忆再作答。
- **每周记忆整理（dreaming）**：可让机器人自建每周定时任务，通读 7 天 journal 提炼入长期层、合并重复、修正过时并汇报变动。
- 压缩前固化提醒（v1.5.0）文案同步分层口径：画像→USER.md、长期事实→独立文件+索引、过程细节→journal。

### 变更
- `workspace/CLAUDE.md` 记忆协议全面重写；新增 `workspace/memory/USER.md` 骨架与 `memory/journal/` 目录。

## [1.5.0] - 2026-08-13

### 新增
- **上下文压缩前自动固化记忆**：桥接监测每轮喂入的上下文规模，超过 `CONTEXT_NUDGE_TOKENS`
  （默认 85 万，`0` 关闭）时，在**下一轮**提示词里注入一次提醒，让机器人把这段对话里值得长期保留的
  事实/决定/偏好写进 `memory/` 并更新索引。仅 owner 触发（只有 owner 有 memory 写权限），
  提醒只注入一次（取走即消费），且明确要求不因此改变回答语气。
- **`/status` 显示上下文用量**：当前会话喂入规模与固化提醒阈值，随时知道离压缩还有多远。

### 背景
Claude Code 在上下文接近上限时会自动压缩对话历史（实测某会话在 100 万 token 处触发，早期对话被替换为摘要）。
压缩**不影响** `memory/` 文件——它们在磁盘上、每次调用重新读取——但压缩本身**不会**把重要内容写进记忆，
只活在对话里的细节因此会流失。本功能补的就是这个缺口。

## [1.4.0] - 2026-08-10

### 新增
- **`/model` 指令**：在聊天里直接查看/切换模型与思考档，如 `/model fable high`、`/model opus xhigh`、
  `/model high`（只改档位）。**立即生效、无需重启**，并同步回写 `.env` 让重启后保持。仅 owner 可用，
  取值走白名单校验（模型名格式 + `low/medium/high/xhigh/max`）。
- **定时切换模型**：定时任务支持 `"action": "set-model"`，配 `model` / `effort` 字段即可按 cron 或
  一次性时间自动切档，例如工作日早八点自动切回便宜档位。

### 修复
- **模型配置此前必须重启才能生效**：`CLAUDE_MODEL` / `CLAUDE_EFFORT` 从模块加载时的常量改为运行时变量。
- **弃用外部定时脚本**：原先靠 macOS launchd 拉起 shell 脚本改配置，在外置卷（exFAT）上会被系统拦下
  （`Operation not permitted`，TCC 层面），定时切换静默失败。现由桥接自身的调度器执行，不再依赖 launchd。

## [1.3.1] - 2026-07-31

### 修复
- **升级后旧配置导致长任务被误杀**：v1.3.0 把 `CLAUDE_TIMEOUT_MS` 的语义从「硬超时」改为「绝对上限」，
  但老 `.env` 里常见的 `300000`（5 分钟）会让上限反而变得比空闲超时还短，长任务必然被杀
  （实测：一个需要串行拉日程、审批、会话记录的周报任务每次都在 5 分钟被终止）。
  现在启动时自检：若绝对上限小于空闲超时，打印明确告警并自动提升到合理值。
  **升级建议**：把 `.env` 里的 `CLAUDE_TIMEOUT_MS` 改为 `3600000`，并增加 `CLAUDE_IDLE_TIMEOUT_MS=600000`。

## [1.3.0] - 2026-07-26

对照 GitHub 同类项目（ofoxai/lark-claude-bot、Kirafy123/feishu-claude-bot、yangwhale/CloseCrab）补齐的能力。

### 新增
- **活动式超时**：只要 Claude 还在输出就不计时，静默超过 `CLAUDE_IDLE_TIMEOUT_MS`（默认 10 分钟）才判定卡死，
  另设 `CLAUDE_TIMEOUT_MS`（默认 60 分钟）作为绝对上限。此前是 5 分钟硬超时，长任务会被误杀。
- **`/cancel` 取消任务**：随时终止正在运行的任务，解除会话队列阻塞。
- **`/redirect <新要求>`**：中断当前任务并按新要求重来，会话上下文保留。
- **任务进行中提示**：跑任务时收到新消息会提示可 `/cancel` 或 `/redirect`，不再默默排队。
- **出站脱敏**：所有回复送出前抹掉 API key、token、JWT、`Bearer`/`password` 字面量与内网 IP，
  运行时凭据（App Secret 等）也一并过滤。
- **结构化进度**：进度卡片以 ✅/🔄 标记各步骤状态，完成后整体转为 ✅。
- **定时任务失败自诊断**：任务失败时自动触发一次诊断，给出失败类别、根因判断与建议动作，随报错一起推送。
- **`/voice` 语音回复**：开启后回答附带一条语音消息（macOS `say` + ffmpeg/libopus 合成）。
- **飞书电子表格工具**：MCP 新增 `sheet_read` / `sheet_write`（工具总数 9 个）。

### 说明
- 飞书邮件工具未做：企业邮箱 API 走用户身份授权，与本项目「只用应用租户凭据」的安全模型不符。

## [1.2.0] - 2026-07-26

对齐 OpenClaw 飞书扩展的能力缺口。

### 新增
- **飞书文档 / 多维表格读写**：内置 MCP 工具服务（`src/mcp-feishu.js`）暴露 7 个动作——读文档、追加段落、
  列数据表、列字段、读记录、新增记录、更新记录。用**机器人应用自己的租户凭据**，能碰什么由飞书后台 scope
  精确控制；**仅 owner 可用**，同事与群成员无法访问。可直接把飞书链接（`/docx/`、`/base/`、`/wiki/`）发给机器人。
- **回传图片与文件**：机器人写入 `workspace/outbox/` 的文件会在本轮回复后自动上传发送并清空；
  图片以图片消息发送、可直接预览。
- **进度卡片原地更新**：长任务的阶段说明改为更新同一张卡片（此前每段发一条新消息），完成后折叠为一行。
- **访问控制**：`ALLOW_USERS` / `ALLOW_CHATS` 白名单，留空保持原行为（不限制）。
- **群内发言人识别**：群消息带上发送者姓名，机器人知道是谁在说话（无通讯录权限时静默降级）。
- **`/help`**：列出指令与能力说明。

### 需要的新权限
开发者后台按需增开并发布版本：`docx:document:readonly`、`docx:document`、`bitable:app:readonly`、
`bitable:app`、`wiki:wiki:readonly`、`contact:user.base:readonly`。

## [1.1.0] - 2026-07-26

首次公开发布（1.0.0）之后累积的功能与修复。

### 新增
- **定时任务**：机器人可自行排期——对它说「每天八点提醒我…」，它会把任务定义写进 `workspace/schedules/*.json`，
  桥接到点执行并把结果主动推送到会话。支持 cron 表达式与一次性时间；cron 任务首次登记不补跑历史时间点，
  一次性任务执行后自动停用。**机器人不获得 Bash/命令执行权限**，只能写受限目录里的任务定义。
- **Agent 工作区**：`workspace/CLAUDE.md` 人格协议 + `memory/` 长期记忆（说「记住…」自动落盘、跨会话生效）
  + `skills/` 技能沉淀（说「存成技能」自动生成 SKILL.md，桥接同步到 `.claude/skills` 后自动加载）。
- **中间进度实时推送**：长任务的阶段性说明即时发到会话（`⏳` 前缀），最终答案仍只发一次（基于 stream-json 解析与去重）。
- **思考深度可配**：`CLAUDE_EFFORT`（low/medium/high/xhigh/max）。
- **`runtime.md` 运行配置**：桥接每次调用前写入真实模型、思考档位与当前 `chat_id`，
  机器人据此如实回答「你用什么模型」并自助填写定时任务的 `chat_id`。
- `/status` 增加模型与思考深度两项。

### 修复
- **语音转写在常驻模式下静默失败**：launchd 不继承终端 PATH，homebrew 的 ffmpeg（`/opt/homebrew/bin`）不可达；
  自启模板补上该目录，并新增 `FFMPEG_BIN` 绝对路径配置。
- **机器人误报自身模型**：无头模式下模型无从得知自己跑在哪个模型上，会凭记忆猜测；改由桥接写入 `runtime.md` 提供权威来源。
- 跳过 exFAT 外置盘产生的 `._*` 影子文件，避免被当成任务/技能解析。

## [1.0.0]

首次公开发布：长连接免公网接入、扫码自动创建应用、多消息类型（文本/图片/文件/语音/富文本/转发/卡片）、
会话持久续聊、owner 权限分级、macOS launchd 与 Windows 启动项自启。
