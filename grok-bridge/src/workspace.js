/**
 * Owner vs guest workspace paths + per-session outbox isolation.
 * Mirrors feishu-claude-bridge isolation intent for Grok Bot wakes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_WORKSPACE_DIR = path.resolve(__dirname, '..', 'workspace');
export const DEFAULT_GUEST_WORKSPACE_DIR = path.resolve(__dirname, '..', 'workspace-guest');

export function workspaceDir(dirs = {}) {
  return dirs.workspaceDir || process.env.WORKSPACE_DIR || DEFAULT_WORKSPACE_DIR;
}

export function guestWorkspaceDir(dirs = {}) {
  return dirs.guestWorkspaceDir || process.env.GUEST_WORKSPACE_DIR || DEFAULT_GUEST_WORKSPACE_DIR;
}

export function workspaceFor(isOwner, dirs = {}) {
  return isOwner ? workspaceDir(dirs) : guestWorkspaceDir(dirs);
}

/** Keep distinct keys when chatId has : . etc. (sched jobs, guest keys). */
export function safeKey(chatId) {
  const raw = String(chatId);
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return `${cleaned}-${h.toString(36)}`;
}

export function outboxDirFor(sessionKey, isOwner = true, dirs = {}) {
  return path.join(workspaceFor(isOwner, dirs), 'outbox', safeKey(sessionKey));
}

export function memoryHintFor(isOwner, dirs = {}) {
  if (!isOwner) return null;
  const root = workspaceDir(dirs);
  const user = path.join(root, 'memory', 'USER.md');
  const index = path.join(root, 'memory', 'MEMORY.md');
  return `Read ${user} and ${index} at session start`;
}

/** Idempotent scaffold for owner + guest workspaces. */
export function ensureWorkspaceDirs(dirs = {}) {
  const owner = workspaceDir(dirs);
  const guest = guestWorkspaceDir(dirs);
  const ownerDirs = [
    path.join(owner, 'incoming'),
    path.join(owner, 'outbox'),
    path.join(owner, 'memory'),
    path.join(owner, 'memory', 'journal'),
    path.join(owner, 'skills'),
    path.join(owner, 'schedules'),
  ];
  const guestDirs = [
    path.join(guest, 'incoming'),
    path.join(guest, 'outbox'),
  ];
  for (const d of [...ownerDirs, ...guestDirs]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
