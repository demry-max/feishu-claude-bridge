#!/bin/bash
# 定时恢复：把飞书机器人模型改回 claude-fable-5 + effort xhigh 并重启
# 由 launchd com.demry.feishu-restore-fable 在下周一 08:00 触发（触发后自我卸载，仅执行一次）
set -e
DIR="/Volumes/ORICO/Documents/claude code/feishu-claude-bridge"
ENV="$DIR/.env"
LOG="$HOME/Library/Logs/feishu-restore-fable.log"

echo "[$(date '+%F %T')] 开始恢复 fable5+xhigh" >> "$LOG"

if [ -f "$ENV" ]; then
  /usr/bin/sed -i '' 's|^CLAUDE_MODEL=.*|CLAUDE_MODEL=claude-fable-5|' "$ENV"
  /usr/bin/sed -i '' 's|^CLAUDE_EFFORT=.*|CLAUDE_EFFORT=xhigh|' "$ENV"
  /bin/launchctl kickstart -k "gui/$(id -u)/com.demry.feishu-claude-bridge" 2>>"$LOG" || true
  echo "[$(date '+%F %T')] 已恢复并重启桥接" >> "$LOG"
else
  echo "[$(date '+%F %T')] 未找到 .env，跳过" >> "$LOG"
fi

# 一次性任务：执行后卸载并删除自身的 launchd 配置
PLIST="$HOME/Library/LaunchAgents/com.demry.feishu-restore-fable.plist"
/bin/launchctl bootout "gui/$(id -u)/com.demry.feishu-restore-fable" 2>/dev/null || true
/bin/rm -f "$PLIST"
echo "[$(date '+%F %T')] 定时任务已自我清理" >> "$LOG"
