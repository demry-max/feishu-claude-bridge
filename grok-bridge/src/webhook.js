/**
 * One POST of an inbound Feishu message to the Grok Bot webhook.
 *
 * Auth: Authorization: Bearer <GROK_WEBHOOK_KEY>
 * Also X-Api-Key / X-Automation-Key for compatibility.
 * The bridge does not wait for Grok text — the agent replies via lark-cli.
 *
 * A 2xx is the only success. A client timeout is ambiguous: the server may
 * already have accepted the body. Callers must not treat that as delivered.
 */

import { classifyHttpStatus, classifyThrown } from './delivery-policy.js';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const USER_AGENT = 'feishu-grok-bridge/1.1';

/** Safe URL summary: host + pathLen only (never print full URL, userinfo, or query). */
export function describeWebhookUrl(url) {
  const u = String(url ?? '').trim();
  if (!u) return 'unset';
  try {
    const x = new URL(u);
    return `host=${x.hostname} pathLen=${x.pathname.length} scheme=${x.protocol.replace(':', '')}`;
  } catch (e) {
    return `bad-url len=${u.length} reason=${e?.code || e?.message || 'parse'}`;
  }
}

export function webhookConfigured(env = process.env) {
  const url = (env.GROK_WEBHOOK_URL ?? '').trim();
  if (!url) return false;
  try {
    const x = new URL(url);
    return x.protocol === 'https:' || x.protocol === 'http:';
  } catch {
    return false;
  }
}

export function scrubText(text, secrets = []) {
  let out = String(text ?? '');
  const extras = [];
  for (const secret of secrets) {
    const s = String(secret ?? '');
    if (s.length >= 8) extras.push(s);
  }
  for (const secret of extras) out = out.split(secret).join('***');
  return out.length > 300 ? out.slice(0, 300) : out;
}

function retryAfterMs(headers, now) {
  if (!headers || typeof headers.get !== 'function') return null;
  const raw = headers.get('retry-after') ?? headers.get('Retry-After');
  if (raw == null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(String(raw));
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return null;
}

function headerMap(headers) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers;
  const lower = new Map();
  for (const [k, v] of Object.entries(headers)) lower.set(String(k).toLowerCase(), v);
  return { get: (name) => lower.get(String(name).toLowerCase()) ?? null };
}

/**
 * Single attempt. Never throws for HTTP, timeout, or network failure.
 * @returns {{ class: 'delivered'|'retryable'|'ambiguous'|'poison', status: number|null, errorCode: string, errorMessage: string, retryAfterMs: number|null }}
 */
export async function attemptWebhook(payload, opts = {}) {
  const env = opts.env || process.env;
  const url = String(opts.url ?? env.GROK_WEBHOOK_URL ?? '').trim();
  const key = String(opts.key ?? env.GROK_WEBHOOK_KEY ?? '').trim();
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const secrets = [...(opts.secrets || []), key, url];
  try {
    const u = new URL(url);
    if (u.username && u.username.length >= 8) secrets.push(decodeURIComponent(u.username));
    if (u.password && u.password.length >= 8) secrets.push(decodeURIComponent(u.password));
    if (u.pathname && u.pathname.length >= 8) secrets.push(u.pathname);
    if (u.search && u.search.length >= 8) secrets.push(u.search);
  } catch { /* classified below as a bad URL */ }
  const idempotencyHeader = opts.idempotencyHeader !== false;
  const messageId = opts.messageId || payload?.message_id || '';

  if (!url) {
    return {
      class: 'poison',
      status: null,
      errorCode: 'MISSING_WEBHOOK',
      errorMessage: 'GROK_WEBHOOK_URL is empty',
      retryAfterMs: null,
    };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {
      class: 'poison',
      status: null,
      errorCode: 'BAD_WEBHOOK_URL',
      errorMessage: `GROK_WEBHOOK_URL is not a valid URL (${describeWebhookUrl(url)})`,
      retryAfterMs: null,
    };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      class: 'poison',
      status: null,
      errorCode: 'BAD_WEBHOOK_URL',
      errorMessage: `GROK_WEBHOOK_URL is not a valid URL (${describeWebhookUrl(url)})`,
      retryAfterMs: null,
    };
  }

  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    return {
      class: 'poison',
      status: null,
      errorCode: 'poison_payload',
      errorMessage: 'payload is not JSON-serializable',
      retryAfterMs: null,
    };
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
    headers['X-Api-Key'] = key;
    headers['X-Automation-Key'] = key;
  }
  if (idempotencyHeader && messageId) {
    headers['Idempotency-Key'] = String(messageId);
  }
  if (opts.attempt != null) headers['X-Delivery-Attempt'] = String(opts.attempt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (e) {
      const classified = classifyThrown(e);
      return {
        class: classified.class,
        status: null,
        errorCode: classified.errorCode,
        errorMessage: scrubText(e?.message || classified.errorCode, secrets),
        retryAfterMs: null,
      };
    }
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    const status = Number(res?.status);
    if (!Number.isInteger(status)) {
      return {
        class: 'ambiguous',
        status: null,
        errorCode: 'bad_status',
        errorMessage: 'webhook response had no integer status',
        retryAfterMs: null,
      };
    }
    const klass = classifyHttpStatus(status);
    const snippet = text ? `: ${text.slice(0, 180)}` : '';
    return {
      class: klass,
      status,
      errorCode: klass === 'delivered' ? 'http_2xx' : `http_${status}`,
      errorMessage: klass === 'delivered' ? '' : scrubText(`webhook HTTP ${status}${snippet}`, secrets),
      retryAfterMs: klass === 'retryable' ? retryAfterMs(headerMap(res.headers), now()) : null,
    };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener?.('abort', onExternalAbort);
  }
}

/**
 * Legacy single-shot helper. Throws unless the attempt class is `delivered`.
 * A timeout throws WEBHOOK_TIMEOUT and is not success.
 */
export async function postToGrok(payload, opts = {}) {
  const result = await attemptWebhook(payload, opts);
  if (result.class === 'delivered') {
    return { ok: true, status: result.status, body: '' };
  }
  const err = new Error(result.errorMessage || result.errorCode);
  err.code = result.errorCode === 'timeout' ? 'WEBHOOK_TIMEOUT' : (
    result.errorCode === 'MISSING_WEBHOOK' || result.errorCode === 'BAD_WEBHOOK_URL'
      ? result.errorCode
      : result.status ? 'WEBHOOK_HTTP' : 'WEBHOOK_NETWORK'
  );
  err.status = result.status;
  err.deliveryClass = result.class;
  throw err;
}
