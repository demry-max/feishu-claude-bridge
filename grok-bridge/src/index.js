#!/usr/bin/env node
/**
 * Feishu → Grok Bot bridge (lark-cli inbound + outbound).
 * UX mirrors the deployed bridge: dedupe, allowlist, @mention, serial accept,
 * immediate OnIt + progress reply, then wake Grok via webhook (no wait for text).
 *
 * Webhook delivery is a durable outbox. HTTP 2xx is the only delivered state.
 * Explicit rejections are retried with a capped backoff. Timeouts and crashes
 * mid-request are held as ambiguous and are not automatically retried.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadOwner, defaultDataDir } from './store.js';
import { react, replyText, createProgress, finishProgress, redact } from './outbound.js';
import { attemptWebhook, webhookConfigured, describeWebhookUrl, scrubText } from './webhook.js';
import { parseEventContent } from './messages.js';
import { buildWebhookPayload } from './payload.js';
import { parseDeliveryConfig, userFacingDetail } from './delivery-policy.js';
import { openStore } from './delivery-store.js';
import { createDelivery } from './delivery.js';
import {
  DEFAULT_WORKSPACE_DIR,
  DEFAULT_GUEST_WORKSPACE_DIR,
  workspaceFor,
  outboxDirFor,
  memoryHintFor,
  ensureWorkspaceDirs,
} from './workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HELP_TEXT = [
  'Feishu → Grok Bot bridge',
  '',
  'Forwards Feishu messages to a Grok Bot webhook.',
  'Grok replies asynchronously via lark-cli (this bridge does not wait).',
  '',
  'Local commands:',
  '- /help — this text',
  '- /ping — pong (no Grok wake)',
  '',
  'DM the bot, or @mention it in a group.',
].join('\n');

function csv(v) {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function bootLines({ env, dirs, config, summary }) {
  const owner = (env.OWNER_OPEN_ID || '').trim();
  return [
    '[boot] feishu-grok-bridge (lark-cli transport)',
    `[boot] owner=${owner || '(unset)'}`,
    `[boot] workspace=${dirs.workspaceDir}`,
    `[boot] guest_workspace=${dirs.guestWorkspaceDir}`,
    `[boot] webhook=${describeWebhookUrl(env.GROK_WEBHOOK_URL)} key=${env.GROK_WEBHOOK_KEY ? 'set' : 'MISSING'}`,
    `[boot] ack=${(env.ACK_EMOJI || 'OnIt').trim()} done=${(env.DONE_EMOJI || 'DONE').trim()}`,
    `[boot] delivery=durable retry_ambiguous=${config.retryAmbiguous} max_attempts=${config.maxAttempts} timeout_ms=${config.timeoutMs} queued=${summary.counts.queued} ambiguous=${summary.counts.ambiguous} dead=${summary.counts.dead}`,
    '[boot] waiting for events on stdin (event consume | node src/index.js)',
  ];
}

export function createBridge(options = {}) {
  const env = options.env || process.env;
  const log = options.log || ((line) => console.log(line));
  const errlog = options.errlog || ((...args) => console.error(...args));
  const outbound = options.outbound || { react, replyText, createProgress, finishProgress };
  const fetchImpl = options.fetch;
  const now = options.now || (() => Date.now());
  const config = options.config || parseDeliveryConfig(env, (line) => errlog(line));
  const dirs = {
    workspaceDir: options.workspaceDir || env.WORKSPACE_DIR || DEFAULT_WORKSPACE_DIR,
    guestWorkspaceDir: options.guestWorkspaceDir || env.GUEST_WORKSPACE_DIR || DEFAULT_GUEST_WORKSPACE_DIR,
  };
  const dataDir = options.dataDir || env.DATA_DIR || defaultDataDir();
  const deliveryDir = options.deliveryDir || env.DELIVERY_DIR || path.join(dataDir, 'delivery');
  const secrets = [env.GROK_WEBHOOK_KEY, env.FEISHU_APP_SECRET, env.GROK_WEBHOOK_URL]
    .filter((v) => v && String(v).length >= 8);
  const redactFn = options.redact || ((text) => redact(scrubText(text, secrets)));

  if (!webhookConfigured(env)) {
    const err = new Error(`GROK_WEBHOOK_URL missing/invalid — ${describeWebhookUrl(env.GROK_WEBHOOK_URL)}`);
    err.code = 'MISSING_WEBHOOK';
    throw err;
  }

  ensureWorkspaceDirs(dirs);

  const owner = (env.OWNER_OPEN_ID ?? '').trim() || loadOwner(dataDir) || '';
  const allowUsers = csv(env.ALLOW_USERS);
  const allowChats = csv(env.ALLOW_CHATS);
  const ackEmoji = (env.ACK_EMOJI || 'OnIt').trim();
  const doneEmoji = (env.DONE_EMOJI || 'DONE').trim();

  const store = options.store || openStore(deliveryDir, {
    now,
    retryAmbiguous: config.retryAmbiguous,
    warn: (line) => errlog(line),
  });

  async function onTerminal(job) {
    const progressId = job.payload?.progress_message_id || null;
    const messageId = job.message_id;
    if (job.state === 'delivered') {
      await outbound.react(messageId, doneEmoji);
      await outbound.finishProgress(progressId, 'done');
      log(`[webhook] ok status=${job.last_status} msg=${messageId} progress=${progressId || 'none'}`);
      return;
    }
    if (job.ux_pending === 'cancelled' || job.state === 'discarded') {
      await outbound.finishProgress(progressId, 'cancelled');
      return;
    }
    const detail = redactFn(userFacingDetail(job)).slice(0, 400);
    if (job.state === 'ambiguous') {
      await outbound.finishProgress(progressId, 'uncertain', detail);
      try {
        await outbound.replyText(messageId, `⚠️ ${detail}`);
      } catch (e) {
        errlog('[reply-err]', e?.message ?? e);
      }
      errlog('[webhook]', detail);
      return;
    }
    if (job.state === 'dead') {
      await outbound.finishProgress(progressId, 'failed', detail);
      try {
        await outbound.replyText(messageId, `⚠️ ${detail}`);
      } catch (e) {
        errlog('[reply-err]', e?.message ?? e);
      }
      errlog('[webhook]', detail);
    }
  }

  const delivery = createDelivery({
    store,
    now,
    config,
    log,
    scrub: (text) => redactFn(text),
    onTerminal,
    post: (payload, meta) => attemptWebhook(payload, {
      url: env.GROK_WEBHOOK_URL,
      key: env.GROK_WEBHOOK_KEY,
      fetch: fetchImpl,
      timeoutMs: config.timeoutMs,
      secrets,
      idempotencyHeader: config.idempotencyHeader,
      attempt: meta.attempt,
      messageId: meta.messageId,
      now,
    }),
  });

  const chatQueues = new Map();
  function enqueue(chatId, task) {
    const prev = chatQueues.get(chatId) ?? Promise.resolve();
    const next = prev.then(task).catch((e) => errlog('[queue]', e?.stack ?? e));
    chatQueues.set(chatId, next);
    next.finally(() => {
      if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
    });
    return next;
  }

  function isAllowed(openId, chatId, isP2p) {
    if (owner && openId === owner) return true;
    if (isP2p) return allowUsers.length === 0 || allowUsers.includes(openId);
    if (allowChats.length && !allowChats.includes(chatId)) return false;
    return allowUsers.length === 0 || allowUsers.includes(openId);
  }

  function handleMessage(ev) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return Promise.resolve();
    const message_id = ev.message_id || ev.id;
    const chat_id = ev.chat_id;
    const sender_id = ev.sender_id;
    const chat_type = ev.chat_type;
    const sender_type = ev.sender_type;

    if (!message_id || !chat_id || !sender_id) return Promise.resolve();
    if (sender_type === 'bot') return Promise.resolve();
    if (store.has(message_id)) return Promise.resolve();

    if (chat_type === 'group' || (chat_type && chat_type !== 'p2p')) {
      const mentions = ev.mentions || [];
      if (!Array.isArray(mentions) || mentions.length === 0) {
        store.insertSkip(message_id, 'no-mention');
        log(`[skip] group without @mention ${message_id}`);
        return Promise.resolve();
      }
    }

    const isP2p = chat_type === 'p2p';
    if (!isAllowed(sender_id, chat_id, isP2p)) {
      store.insertSkip(message_id, 'deny');
      log(`[deny] ${sender_id} @ ${chat_id}`);
      return Promise.resolve();
    }

    const { text } = parseEventContent(ev);
    if (text === '/help' || text === 'help' || text === '帮助') {
      store.insertSkip(message_id, 'command');
      return outbound.replyText(message_id, HELP_TEXT).catch((e) => errlog('[help]', e?.message ?? e));
    }
    if (text === '/ping') {
      store.insertSkip(message_id, 'command');
      return outbound.replyText(message_id, 'pong').catch((e) => errlog('[ping]', e?.message ?? e));
    }
    if (!text && (ev.message_type || 'text') === 'text') {
      store.insertSkip(message_id, 'empty');
      return Promise.resolve();
    }

    const isOwner = Boolean(owner && sender_id === owner);
    const session_key = isOwner ? chat_id : `guest:${chat_id}:${sender_id}`;
    const workspace_dir = workspaceFor(isOwner, dirs);
    const outbox_dir = outboxDirFor(session_key, isOwner, dirs);
    try {
      fs.mkdirSync(outbox_dir, { recursive: true });
    } catch (e) {
      errlog('[outbox-dir]', e?.message ?? e);
    }
    const payload = buildWebhookPayload({
      message_id,
      chat_id,
      chat_type,
      sender_id,
      sender_type,
      content: text,
      message_type: ev.message_type || 'text',
      mentions: ev.mentions || [],
      reply_to: ev.reply_to || null,
      root_id: ev.root_id || null,
      thread_id: ev.thread_id || null,
      create_time: ev.create_time || null,
      event_id: ev.event_id || null,
      progress_message_id: null,
      session_key,
      is_owner: isOwner,
      owner_open_id: owner || null,
      workspace_dir,
      outbox_dir,
      memory_hint: memoryHintFor(isOwner, dirs),
    });

    const ins = delivery.accept({
      messageId: message_id,
      chatId: chat_id,
      payload,
      ready: false,
    });
    if (ins.duplicate) return Promise.resolve();

    return enqueue(chat_id, async () => {
      log(`[msg] ${sender_id} @ ${chat_type || '?'} [${ev.message_type || 'text'}]: ${redactFn(text).slice(0, 80)}`);
      outbound.react(message_id, ackEmoji).catch(() => {});
      let progressMessageId = null;
      try {
        const created = await outbound.createProgress(message_id, '🔄 处理中…');
        progressMessageId = created?.progressMessageId || null;
      } catch (e) {
        errlog('[progress] create failed:', e?.message ?? e);
      }
      delivery.updatePayload(ins.job.id, { progress_message_id: progressMessageId }, { ready: true });
      await delivery.pump().catch((e) => errlog('[delivery] pump', e?.message ?? e));
    });
  }

  function handleLine(line) {
    const raw = String(line ?? '').trim();
    if (!raw) return Promise.resolve({ parsed: false });
    if (raw.startsWith('[') && !raw.startsWith('{')) return Promise.resolve({ parsed: false });
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      errlog('[bridge] skip non-json line');
      return Promise.resolve({ parsed: false });
    }
    try {
      return Promise.resolve(handleMessage(ev)).then(() => ({ parsed: true })).catch((e) => {
        errlog('[bridge] handle error:', e?.stack ?? e);
        return { parsed: true };
      });
    } catch (e) {
      errlog('[bridge] handle error:', e?.stack ?? e);
      return Promise.resolve({ parsed: true });
    }
  }

  return {
    handleLine,
    handleMessage,
    delivery,
    store,
    dirs,
    config,
    owner,
    helpText: HELP_TEXT,
    close() {
      store.close();
    },
  };
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    v = v.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    process.env[k] = v;
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

async function main() {
  loadEnv(path.join(ROOT, '.env'));
  if (!webhookConfigured(process.env)) {
    console.error('[boot] GROK_WEBHOOK_URL missing/invalid —', describeWebhookUrl(process.env.GROK_WEBHOOK_URL));
    process.exit(1);
  }
  const bridge = createBridge({ env: process.env });
  const summary = bridge.store.summary();
  for (const line of bootLines({
    env: process.env,
    dirs: bridge.dirs,
    config: bridge.config,
    summary,
  })) {
    console.log(line);
  }

  let events = 0;
  let exiting = false;
  const timer = setInterval(() => {
    bridge.delivery.pump().catch((e) => console.error('[delivery] pump', e?.message ?? e));
  }, bridge.config.pollMs);
  timer.unref();
  bridge.delivery.pump().catch((e) => console.error('[delivery] pump', e?.message ?? e));

  async function shutdown(reason, code) {
    if (exiting) return;
    exiting = true;
    clearInterval(timer);
    const grace = bridge.config.shutdownGraceMs;
    console.error(`[exit] ${reason} (drain up to ${Math.round(grace / 1000)}s)`);
    try {
      await bridge.delivery.drain(grace);
    } catch (e) {
      console.error('[exit] drain', e?.message ?? e);
    }
    setTimeout(() => process.exit(code), 20).unref();
  }

  process.on('uncaughtException', (e) => {
    console.error('[fatal] uncaughtException:', e?.stack ?? e);
    shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (e) => {
    console.error('[fatal] unhandledRejection:', e?.stack ?? e);
  });
  process.on('SIGTERM', () => shutdown('SIGTERM', 1));
  process.on('SIGINT', () => shutdown('SIGINT', 1));

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    bridge.handleLine(line).then((r) => {
      if (r?.parsed) events += 1;
    }).catch((e) => {
      console.error('[bridge] handle error:', e?.stack ?? e);
    });
  });
  rl.on('close', () => {
    console.error(`[bridge] stdin closed after ${events} event line(s) — exiting for supervisor restart`);
    shutdown('stdin EOF (event consume ended)', 1);
  });
}

if (isMainModule()) {
  main().catch((e) => {
    console.error('[fatal] boot', e?.stack ?? e);
    process.exit(1);
  });
}
