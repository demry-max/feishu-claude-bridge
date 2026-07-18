# feishu-claude-bridge

[中文](README.md) | **English**

**Chat with Claude Code from Feishu/Lark** — DM the bot or @mention it in a group chat, and Claude answers with full context continuity: it reads images, files, and voice messages, and remembers across days and weeks. **No public server, domain, or callback URL required** — events arrive over Feishu's persistent WebSocket connection, so it runs on any machine with Claude Code installed.

> Using international **Lark** (larksuite.com)? Check out the English-first sister repo: [lark-claude-bridge](https://github.com/demry-max/lark-claude-bridge). This codebase supports both — set `FEISHU_DOMAIN=lark` in `.env`.

Sister projects: [dingtalk-claude-bridge](https://github.com/demry-max/dingtalk-claude-bridge) (DingTalk) · [wecom-claude-bridge](https://github.com/demry-max/wecom-claude-bridge) (WeCom)

## Features

- 🔌 **Zero public-network dependency**: events over a persistent WebSocket — deploy on a home computer
- 📲 **App created by scanning a QR code**: `npm run register` uses Feishu's official app-registration OAuth flow — one scan auto-creates the app, writes credentials to `.env`, and registers you as owner
- 🧠 **Session memory**: each Feishu chat maps to one Claude session (`--resume`), valid across days; `/new` to reset, `/status` to inspect
- 🖼️ **Rich message types**: text / images (Claude reads them directly) / files / voice (Feishu transcript field, with an ffmpeg + speech-API fallback) / rich posts / merged forwards / share cards
- 🔐 **Tiered permissions**: the first person to DM the bot becomes **owner** (local read-only tools + web); everyone else gets web search only and cannot touch your machine's files
- 💰 **Runs on your Claude subscription, not API keys**: headless `claude -p` reuses your local Claude Code login
- 🖥️ **macOS + Windows** (cross-spawn handles `.cmd` shims)

## 🗂️ Agent Workspace (Hermes-style memory & skills)

The bot is more than Q&A — `workspace/` is its persistent home:

```
workspace/
├── CLAUDE.md          # Persona & protocols (auto-loaded on every call)
├── memory/            # Long-term memory: one fact = one md file
│   └── MEMORY.md      # Index, injected on every conversation via @import
└── skills/            # Self-authored skills, synced into .claude/skills
```

- Tell it "**remember**: I fly to Manila next Wednesday" → written to `memory/`, effective across all future sessions and chats
- Teach it a workflow and say "**save this as a skill**" → it writes `skills/<name>/SKILL.md`, auto-loaded in every later session
- Ask "**what skills do you have**" → it lists them
- Safety: write access is limited to `memory/` and `skills/` only (Claude Code itself forbids agents from writing `.claude/`; the bridge syncs skills over), and the protocol forbids storing secrets in memory

## Quick Start

```bash
npm install -g @anthropic-ai/claude-code   # install/update Claude Code CLI
claude /login                              # complete browser login (subscription account)

git clone https://github.com/demry-max/feishu-claude-bridge.git
cd feishu-claude-bridge
npm install
npm run register   # scan the QR with the Feishu app → app auto-created, .env auto-filled
npm start          # "[ws] ws client ready" in the log = connected
```

Then DM the bot in Feishu. Prerequisites: Node ≥ 18; optional ffmpeg for the voice-transcription fallback. For international Lark, add `FEISHU_DOMAIN=lark` to `.env` before registering.

- Auto-start on macOS: see [examples/launchd.example.plist](examples/launchd.example.plist)
- Auto-start on Windows: `powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1`
- Full deployment runbook (hand it to Claude Code and say "deploy per this manual", in Chinese): [docs](docs/飞书-Claude-机器人架设方案.md)
- If QR registration fails, the runbook's Appendix A covers manual console setup

## Architecture

```
Feishu DM / group @bot
        │  persistent WebSocket (im.message.receive_v1)
        ▼
Bridge service (Node.js: dedupe, per-chat serial queue, owner auth, message parsing)
        │  spawn: claude -p --resume <session> --allowedTools … (prompt via stdin)
        ▼
Claude Code CLI (headless)
        ▼
Markdown card reply (plain-text fallback) + emoji receipts
```

## Security

- `.env` (App Secret) and all runtime data are git-ignored
- Non-owners have zero local file access; attachments are exposed read-only in a dedicated directory
- Claude gets read-only tools by default — never grant Write/Bash to an unattended bot

## License

[MIT](LICENSE)
