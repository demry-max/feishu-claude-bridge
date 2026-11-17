// 每日新会话的线上接线：从 claude.js 取会话读写、运行、取消与默认工具表，交给 daily-session.js。
// daily-session.js 本身不 import claude.js（测试可以全桩）；index.js 只从这里取两个入口，不必再动 claude.js 的 import 行。
import { getSessionId, restoreSession, resetSession, isRunning, cancelRun, abortRetries, runClaude, DEFAULT_OWNER_TOOLS } from './claude.js';
import { createDailySession, dailySessionConfig, ownerEditsWarning } from './daily-session.js';

/**
 * @param {object} o
 * @param {string} o.dataDir           data/（state.json、原话、交接摘要放在 data/daily-session/）
 * @param {string} o.workspaceDir      owner 工作区（读 memory/journal/、统计 memory/ tasks/ 改动）
 * @param {Function} o.enqueue         index.js 的按会话串行队列（交接轮和 owner 轮排在同一条队里）
 * @param {Function} o.redact          凭据脱敏（原话落盘前过一遍）
 * @param {() => boolean} [o.isDraining] 进入优雅退出后返回 true：不再起新的交接
 */
export function createLiveDailySession({ env = process.env, dataDir, workspaceDir, enqueue, redact, isDraining, log = console.log } = {}) {
  return createDailySession({
    config: dailySessionConfig(env, log),
    dataDir, workspaceDir, enqueue, redact, isDraining, log,
    runClaude, getSessionId, restoreSession, resetSession, isRunning, cancelRun, abortRetries,
  });
}

/** 启动自检：显式 ALLOWED_TOOLS 缺了默认里的 Edit(./…/**) 写入项时返回一行警告（只列项名），否则 null。 */
export const ownerToolsWarning = (env = process.env) => ownerEditsWarning(env.ALLOWED_TOOLS, DEFAULT_OWNER_TOOLS);
