/**
 * Outbound Feishu ops via lark-cli (no plaintext app secret needed).
 */
import { spawn } from 'node:child_process';

const LARK = process.env.LARK_CLI || '/home/box/.local/bin/lark-cli';

const SECRET_PATTERNS = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-***'],
  [/\bcrsr_[A-Za-z0-9_-]{8,}/g, 'crsr_***'],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, 'github_token_***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'jwt_***'],
  [/\b(?:Bearer|token|secret|password|api[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9_\-]{16,})["']?/gi, (m) =>
    m.replace(/[A-Za-z0-9_\-]{16,}$/, '***')],
];

function runtimeSecrets() {
  return [process.env.FEISHU_APP_SECRET, process.env.GROK_WEBHOOK_KEY]
    .filter((v) => v && v.length >= 8);
}

export function redact(text) {
  let out = String(text ?? '');
  for (const v of runtimeSecrets()) out = out.split(v).join('***');
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

export function progressBody(status = 'done', note = '') {
  const head =
    status === 'cancelled' ? '🛑 已取消'
      : status === 'failed' ? '⚠️ 唤醒失败'
        : status === 'uncertain' ? '⏳ 结果不确定'
          : '✅ 已唤醒';
  return note ? `${head}\n${note}` : head;
}

function runLark(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(LARK, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`lark-cli timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `lark-cli exit ${code}`).trim().slice(0, 500)));
    });
  });
}

function parseJson(stdout) {
  const t = String(stdout ?? '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    const i = t.indexOf('{');
    if (i >= 0) {
      try { return JSON.parse(t.slice(i)); } catch { /* fallthrough */ }
    }
    return null;
  }
}

function extractMessageId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return (
    obj?.data?.message_id ??
    obj?.data?.data?.message_id ??
    obj?.message_id ??
    obj?.data?.message?.message_id ??
    null
  );
}

/** React with an emoji on a message (OnIt / DONE / …). */
export async function react(messageId, emoji) {
  if (!messageId || !emoji) return;
  try {
    await runLark([
      'im', 'reactions', 'create',
      '--as', 'bot',
      '--message-id', messageId,
      '--data', JSON.stringify({ reaction_type: { emoji_type: emoji } }),
      '--format', 'json',
    ]);
  } catch (e) {
    console.error('[react]', emoji, e?.message ?? e);
  }
}

/** Reply with plain text; returns the new message_id when parseable. */
export async function replyText(messageId, text) {
  const safe = redact(text).slice(0, 4000);
  const { stdout } = await runLark([
    'im', '+messages-reply',
    '--as', 'bot',
    '--message-id', messageId,
    '--text', safe,
    '--format', 'json',
  ]);
  const parsed = parseJson(stdout);
  return extractMessageId(parsed);
}

/** Reply with markdown (post); returns message_id when parseable. */
export async function replyMarkdown(messageId, markdown) {
  const safe = redact(markdown).slice(0, 8000);
  const { stdout } = await runLark([
    'im', '+messages-reply',
    '--as', 'bot',
    '--message-id', messageId,
    '--markdown', safe,
    '--format', 'json',
  ]);
  const parsed = parseJson(stdout);
  return extractMessageId(parsed);
}

/**
 * Immediate progress reply. Prefer plain text for easy later edit.
 * Returns { progressMessageId, finish }.
 */
export async function createProgress(messageId, initialText = '🔄 处理中…') {
  let progressMessageId = null;
  try {
    progressMessageId = await replyText(messageId, initialText);
  } catch (e) {
    console.error('[progress] create failed:', e?.message ?? e);
  }

  const finish = async (status = 'done', note = '') => {
    await finishProgress(progressMessageId, status, note);
  };

  return { progressMessageId, finish };
}

export async function finishProgress(progressMessageId, status = 'done', note = '') {
  if (!progressMessageId) return;
  const body = progressBody(status, note);
  try {
    await runLark([
      'im', '+messages-edit',
      '--as', 'bot',
      '--message-id', progressMessageId,
      '--text', redact(body).slice(0, 2000),
      '--format', 'json',
    ]);
  } catch (e) {
    console.error('[progress] finish skipped:', e?.message ?? e);
  }
}
