/**
 * Pure webhook delivery decisions.
 *
 * `delivered` is only HTTP 2xx. Timeouts, connection resets, 408/504/409, and
 * crashes while a request is in flight are `ambiguous`: they are not marked
 * delivered and are not retried unless `retryAmbiguous` is explicitly on.
 * That flag is off by default because a retry can duplicate downstream work
 * when the receiver is not idempotent on `message_id`.
 *
 * This is not exactly-once. Explicit rejections (429 / most 5xx / connection
 * refused before the request is sent) are retried with a capped backoff, then
 * dead-lettered. Poison (other 4xx, unusable payload) is dead-lettered once.
 */

export const DELIVERY_DEFAULTS = Object.freeze({
  timeoutMs: 15_000,
  maxAttempts: 6,
  backoffBaseMs: 1_000,
  backoffCapMs: 60_000,
  retryAmbiguous: false,
  maxPayloadBytes: 262_144,
  idempotencyHeader: true,
  pollMs: 500,
  shutdownGraceMs: 20_000,
});

function intEnv(env, key, def, min, max, warn) {
  const raw = env?.[key];
  if (raw == null || String(raw).trim() === '') return def;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    warn?.(`[config] ${key} is invalid; using ${def}`);
    return def;
  }
  return n;
}

export function parseDeliveryConfig(env = {}, warn = () => {}) {
  const cfg = {
    timeoutMs: intEnv(env, 'WEBHOOK_TIMEOUT_MS', DELIVERY_DEFAULTS.timeoutMs, 1_000, 120_000, warn),
    maxAttempts: intEnv(env, 'WEBHOOK_MAX_ATTEMPTS', DELIVERY_DEFAULTS.maxAttempts, 1, 10, warn),
    backoffBaseMs: intEnv(env, 'WEBHOOK_BACKOFF_BASE_MS', DELIVERY_DEFAULTS.backoffBaseMs, 100, 60_000, warn),
    backoffCapMs: intEnv(env, 'WEBHOOK_BACKOFF_CAP_MS', DELIVERY_DEFAULTS.backoffCapMs, 1_000, 300_000, warn),
    retryAmbiguous: env.WEBHOOK_RETRY_AMBIGUOUS === 'true' || env.WEBHOOK_RETRY_AMBIGUOUS === '1',
    maxPayloadBytes: intEnv(env, 'WEBHOOK_MAX_PAYLOAD_BYTES', DELIVERY_DEFAULTS.maxPayloadBytes, 1_024, 2_000_000, warn),
    idempotencyHeader: env.WEBHOOK_IDEMPOTENCY_HEADER !== 'false',
    pollMs: intEnv(env, 'DELIVERY_POLL_MS', DELIVERY_DEFAULTS.pollMs, 200, 60_000, warn),
    shutdownGraceMs: intEnv(env, 'DELIVERY_SHUTDOWN_GRACE_MS', DELIVERY_DEFAULTS.shutdownGraceMs, 0, 120_000, warn),
  };
  if (cfg.backoffCapMs < cfg.backoffBaseMs) cfg.backoffCapMs = cfg.backoffBaseMs;
  return cfg;
}

/** HTTP status → delivery class. `res.ok` is intentionally ignored. */
export function classifyHttpStatus(status) {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 408 || status === 409 || status === 504) return 'ambiguous';
  if (status === 501) return 'poison';
  if (status === 429 || status === 425 || (status >= 500 && status <= 599)) return 'retryable';
  return 'poison';
}

const AMBIGUOUS_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_ABORTED',
  'ABORT_ERR',
]);

const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NODATA',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Walk fetch/undici errors. Unknown throws are ambiguous so they are not hot-looped. */
export function classifyThrown(err) {
  const seen = new Set();
  function walk(e, depth) {
    if (!e || typeof e !== 'object' || depth > 5 || seen.has(e)) return null;
    seen.add(e);
    const name = e.name;
    const code = e.code;
    if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR' || code === 20) {
      return { class: 'ambiguous', errorCode: 'timeout' };
    }
    if (AMBIGUOUS_CODES.has(code)) return { class: 'ambiguous', errorCode: String(code) };
    if (RETRYABLE_CODES.has(code)) return { class: 'retryable', errorCode: String(code) };
    if (e.cause) {
      const inner = walk(e.cause, depth + 1);
      if (inner) return inner;
    }
    if (Array.isArray(e.errors)) {
      for (const sub of e.errors) {
        const inner = walk(sub, depth + 1);
        if (inner) return inner;
      }
    }
    return null;
  }
  return walk(err, 0) || { class: 'ambiguous', errorCode: 'unknown_network' };
}

/**
 * Bounded exponential backoff, ±20% jitter, never above the cap.
 * `attempt` is 1-based (the attempt that just failed).
 * Retry-After is honored only up to the same cap.
 */
export function backoffMs(attempt, retryAfterMs, cfg, rand = Math.random) {
  const cap = cfg.backoffCapMs;
  const base = cfg.backoffBaseMs;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const unit = Math.min(1, Math.max(0, Number(rand()) || 0));
  const jitter = exp * 0.2 * (unit * 2 - 1);
  let ms = Math.round(exp + jitter);
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    ms = Math.max(ms, retryAfterMs);
  }
  if (ms > cap) ms = cap;
  return ms;
}

function clip(text) {
  const s = String(text ?? '');
  return s.length > 300 ? s.slice(0, 300) : s;
}

/**
 * @returns patch fields plus `terminal`.
 * `state === 'delivered'` is assigned only when `result.class === 'delivered'`.
 */
export function decideOutcome({ attempt, result, cfg, now, rand = Math.random }) {
  const status = Number.isInteger(result?.status) ? result.status : null;
  const base = {
    attempts: attempt,
    last_status: status,
    last_error: clip(result?.errorMessage),
    last_outcome: result?.errorCode || result?.class || 'unknown',
    leased_at: null,
  };
  let out;
  if (result?.class === 'delivered') {
    out = {
      ...base,
      state: 'delivered',
      delivered_at: now,
      ux_pending: 'success',
      next_attempt_at: null,
      terminal: true,
    };
  } else if (result?.class === 'poison') {
    out = {
      ...base,
      state: 'dead',
      last_outcome: 'poison',
      ux_pending: 'failed',
      next_attempt_at: null,
      terminal: true,
    };
  } else if (result?.class === 'retryable') {
    if (attempt >= cfg.maxAttempts) {
      out = {
        ...base,
        state: 'dead',
        last_outcome: 'exhausted',
        ux_pending: 'failed',
        next_attempt_at: null,
        terminal: true,
      };
    } else {
      const delay = backoffMs(attempt, result.retryAfterMs, cfg, rand);
      out = {
        ...base,
        state: 'queued',
        ready: true,
        next_attempt_at: now + delay,
        ux_pending: null,
        terminal: false,
      };
    }
  } else if (result?.class === 'ambiguous' && cfg.retryAmbiguous && attempt < cfg.maxAttempts) {
    const delay = backoffMs(attempt, null, cfg, rand);
    out = {
      ...base,
      state: 'queued',
      ready: true,
      next_attempt_at: now + delay,
      last_outcome: result.errorCode || 'ambiguous',
      ux_pending: null,
      terminal: false,
    };
  } else {
    out = {
      ...base,
      state: 'ambiguous',
      last_outcome: result?.errorCode || result?.class || 'ambiguous',
      ux_pending: 'ambiguous',
      next_attempt_at: null,
      terminal: true,
    };
  }
  if (out.state === 'delivered' && result?.class !== 'delivered') {
    throw new Error('refusing to mark delivered without a delivered result');
  }
  return out;
}

export function userFacingDetail(job) {
  const outcome = job?.last_outcome;
  if (outcome === 'MISSING_WEBHOOK' || outcome === 'BAD_WEBHOOK_URL') {
    return 'GROK_WEBHOOK_URL is missing/invalid. Fix .env and restart.';
  }
  if (job?.state === 'ambiguous') {
    return '唤醒超时，结果不确定（可能已经送达）。为避免重复执行，没有自动重试。如果没有后续回复，请再发一次。';
  }
  const err = String(job?.last_error || job?.last_outcome || 'webhook failed');
  return `唤醒 Grok 失败：${err}`.slice(0, 400);
}
