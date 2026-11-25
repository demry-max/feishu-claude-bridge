/**
 * Durable webhook outbox.
 *
 * Accept persists the job before any network call. A process death while the
 * HTTP call is in flight reopens as `ambiguous` and is not sent again unless
 * an operator writes a replay command (or WEBHOOK_RETRY_AMBIGUOUS is on for
 * fresh ambiguous HTTP results). Queued jobs that were never claimed are sent
 * after restart. That is safe: the request was not started.
 *
 * Per-chat order: a later message is not POSTed while an earlier one in the
 * same chat is still queued or in flight. Once the earlier job is terminal
 * (delivered, dead, ambiguous, discarded), later messages proceed. Replaying
 * an older ambiguous job can therefore arrive after newer ones.
 */
import { decideOutcome } from './delivery-policy.js';

const BLOCKING = new Set(['queued', 'inflight']);

function stubPayload(fields) {
  return {
    source: 'feishu-grok-bridge',
    type: 'im.message.receive_v1',
    message_id: fields.messageId,
    chat_id: fields.chatId,
    content: null,
    omitted: 'oversized_or_unserializable',
  };
}

export function createDelivery({
  store,
  post,
  now = () => Date.now(),
  rand = Math.random,
  config,
  log = () => {},
  onTerminal = null,
  scrub = (s) => String(s ?? '').slice(0, 300),
}) {
  if (!store) throw new Error('delivery store is required');
  if (!config) throw new Error('delivery config is required');
  let stopping = false;
  let chain = Promise.resolve();
  let draining = null;

  function logJob(job) {
    log(`[delivery] message_id=${job.message_id} state=${job.state} attempts=${job.attempts} outcome=${job.last_outcome || '-'} http=${job.last_status ?? '-'}`);
  }

  function chatBlocked(job, all) {
    return all.some((other) =>
      other.kind === 'delivery'
      && other.chat_id === job.chat_id
      && other.seq < job.seq
      && BLOCKING.has(other.state));
  }

  function selectDue(all, t) {
    return all
      .filter((job) =>
        job.kind === 'delivery'
        && job.state === 'queued'
        && job.ready === true
        && (job.next_attempt_at || 0) <= t
        && !chatBlocked(job, all))
      .sort((a, b) => a.seq - b.seq);
  }

  async function settleUx(job) {
    if (!job || job.ux_done || !job.ux_pending) return;
    if (typeof onTerminal !== 'function') return;
    try {
      await onTerminal(job);
      store.update(job.id, { ux_done: true, ux_pending: null });
    } catch (e) {
      const n = (job.ux_attempts || 0) + 1;
      if (n >= 5) {
        log(`[delivery] ux give-up message_id=${job.message_id} ${scrub(e?.message || e)}`);
        store.update(job.id, { ux_done: true, ux_attempts: n });
      } else {
        store.update(job.id, { ux_attempts: n, ux_next_at: now() + 5_000 });
      }
    }
  }

  async function flushUx() {
    const t = now();
    for (const job of store.list()) {
      if (job.ux_done || !job.ux_pending) continue;
      if ((job.ux_next_at || 0) > t) continue;
      await settleUx(job);
    }
  }

  function applyCommand(cmd) {
    if (!cmd || (cmd.op !== 'replay' && cmd.op !== 'discard')) {
      log('[delivery] ignored command');
      return;
    }
    const job = store.getByMessageId(cmd.message_id);
    if (!job || job.kind !== 'delivery') {
      log(`[delivery] command ${cmd.op} ignored; no delivery for message_id=${cmd.message_id}`);
      return;
    }
    if (job.state === 'inflight') {
      log(`[delivery] command ${cmd.op} ignored; message_id=${job.message_id} is in flight`);
      return;
    }
    if (cmd.op === 'discard') {
      if (job.state === 'delivered' || job.state === 'discarded' || job.state === 'skipped') {
        log(`[delivery] discard ignored; message_id=${job.message_id} state=${job.state}`);
        return;
      }
      const updated = store.update(job.id, {
        state: 'discarded',
        ux_pending: job.ux_done ? null : 'cancelled',
        next_attempt_at: null,
        last_outcome: 'discarded',
      });
      logJob(updated);
      return;
    }
    if (job.state === 'delivered' || job.state === 'discarded' || job.state === 'skipped') {
      log(`[delivery] replay ignored; message_id=${job.message_id} state=${job.state}`);
      return;
    }
    if (job.state === 'ambiguous' || job.last_outcome === 'crash_inflight' || job.last_outcome === 'timeout') {
      log(`[delivery] manual replay of ambiguous message_id=${job.message_id} can duplicate downstream work`);
    }
    const updated = store.update(job.id, {
      state: 'queued',
      ready: true,
      attempts: 0,
      next_attempt_at: now(),
      last_outcome: 'manual_replay',
      ux_pending: null,
      delivered_at: null,
    });
    logJob(updated);
  }

  function consumeCommands() {
    for (const { file, cmd } of store.listCommands()) {
      try {
        applyCommand(cmd);
      } catch (e) {
        log(`[delivery] command failed: ${scrub(e?.message || e)}`);
      } finally {
        store.removeCommand(file);
      }
    }
  }

  async function perform(job) {
    const attempt = (job.attempts || 0) + 1;
    store.update(job.id, { state: 'inflight', attempts: attempt, leased_at: now() });
    let result;
    try {
      const current = store.get(job.id);
      result = await post(current.payload, { attempt, messageId: current.message_id });
    } catch (e) {
      result = {
        class: 'ambiguous',
        status: null,
        errorCode: 'post_threw',
        errorMessage: scrub(e?.message || e),
        retryAfterMs: null,
      };
    }
    if (!result || typeof result.class !== 'string') {
      result = {
        class: 'ambiguous',
        status: result?.status ?? null,
        errorCode: 'bad_result',
        errorMessage: 'post returned no class',
        retryAfterMs: null,
      };
    }
    if (result.errorMessage) result = { ...result, errorMessage: scrub(result.errorMessage) };
    const decision = decideOutcome({
      attempt,
      result,
      cfg: config,
      now: now(),
      rand,
    });
    const { terminal, ...patch } = decision;
    const updated = store.update(job.id, patch);
    logJob(updated);
    if (terminal) await settleUx(updated);
  }

  async function pumpOnce() {
    consumeCommands();
    await flushUx();
    if (stopping) return;
    const due = selectDue(store.list(), now());
    for (const job of due) {
      if (stopping) return;
      const fresh = store.get(job.id);
      if (!fresh || fresh.state !== 'queued' || !fresh.ready) continue;
      if (chatBlocked(fresh, store.list())) continue;
      await perform(fresh);
    }
  }

  function pump() {
    const run = chain.then(() => pumpOnce());
    chain = run.then(() => {}, (err) => {
      log(`[delivery] pump ${scrub(err?.stack || err?.message || err)}`);
    });
    return run;
  }

  function accept(fields) {
    const messageId = fields.messageId;
    const chatId = fields.chatId;
    let payload = fields.payload;
    let bytes = 0;
    let serializable = true;
    try {
      bytes = Buffer.byteLength(JSON.stringify(payload));
    } catch {
      serializable = false;
    }
    if (!serializable || bytes > config.maxPayloadBytes) {
      return store.insertDelivery({
        message_id: messageId,
        chat_id: chatId,
        payload: stubPayload(fields),
        state: 'dead',
        ready: true,
        last_outcome: 'poison_payload',
        last_error: serializable
          ? `payload ${bytes} bytes exceeds ${config.maxPayloadBytes}`
          : 'payload is not JSON-serializable',
        ux_pending: 'failed',
        next_attempt_at: null,
      });
    }
    return store.insertDelivery({
      message_id: messageId,
      chat_id: chatId,
      payload,
      state: 'queued',
      ready: fields.ready !== false,
      next_attempt_at: now(),
    });
  }

  function updatePayload(jobId, fields, extra = {}) {
    const job = store.get(jobId);
    if (!job) throw new Error(`unknown delivery job ${jobId}`);
    const payload = { ...(job.payload || {}), ...fields };
    return store.update(jobId, { payload, ...extra });
  }

  function drain(graceMs) {
    stopping = true;
    if (draining) return draining;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('grace'), graceMs);
    });
    draining = Promise.race([
      chain.then(() => 'drained'),
      timeout,
    ]).finally(() => clearTimeout(timer));
    return draining;
  }

  return {
    accept,
    updatePayload,
    pump,
    drain,
    idle: () => chain,
    applyCommand,
    stopping: () => stopping,
  };
}
