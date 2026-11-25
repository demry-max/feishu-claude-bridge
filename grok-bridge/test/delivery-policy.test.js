import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIVERY_DEFAULTS,
  parseDeliveryConfig,
  classifyHttpStatus,
  classifyThrown,
  backoffMs,
  decideOutcome,
  userFacingDetail,
} from '../src/delivery-policy.js';
import { progressBody } from '../src/outbound.js';

const cfg = { ...DELIVERY_DEFAULTS };

test('default webhook timeout stays 15s', () => {
  assert.equal(DELIVERY_DEFAULTS.timeoutMs, 15_000);
  assert.equal(DELIVERY_DEFAULTS.retryAmbiguous, false);
  assert.equal(DELIVERY_DEFAULTS.maxAttempts, 6);
});

test('invalid numeric env does not echo the value', () => {
  const warnings = [];
  const parsed = parseDeliveryConfig({
    WEBHOOK_TIMEOUT_MS: 'supersecretvalue',
    WEBHOOK_RETRY_AMBIGUOUS: 'yes',
    WEBHOOK_BACKOFF_CAP_MS: '50',
    WEBHOOK_BACKOFF_BASE_MS: '5000',
  }, (line) => warnings.push(line));
  assert.equal(parsed.timeoutMs, 15_000);
  assert.equal(parsed.retryAmbiguous, false);
  assert.equal(parsed.backoffCapMs, 60_000);
  const raised = parseDeliveryConfig({ WEBHOOK_BACKOFF_CAP_MS: '2000', WEBHOOK_BACKOFF_BASE_MS: '5000' });
  assert.equal(raised.backoffCapMs, 5_000);
  assert.equal(warnings.join('\n').includes('supersecretvalue'), false);
  assert.equal(parseDeliveryConfig({ WEBHOOK_RETRY_AMBIGUOUS: 'true' }).retryAmbiguous, true);
  assert.equal(parseDeliveryConfig({ WEBHOOK_RETRY_AMBIGUOUS: '1' }).retryAmbiguous, true);
  assert.equal(parseDeliveryConfig({ WEBHOOK_IDEMPOTENCY_HEADER: 'false' }).idempotencyHeader, false);
});

test('http classification matrix', () => {
  for (const status of [200, 201, 202, 204]) assert.equal(classifyHttpStatus(status), 'delivered');
  for (const status of [408, 409, 504]) assert.equal(classifyHttpStatus(status), 'ambiguous');
  for (const status of [429, 425, 500, 502, 503, 505]) assert.equal(classifyHttpStatus(status), 'retryable');
  for (const status of [400, 401, 403, 404, 501, 302, 199]) assert.equal(classifyHttpStatus(status), 'poison');
});

test('thrown network errors: refused retries, reset and abort do not', () => {
  assert.equal(classifyThrown(Object.assign(new Error('nope'), { code: 'ECONNREFUSED' })).class, 'retryable');
  const wrapped = new TypeError('fetch failed');
  wrapped.cause = Object.assign(new Error('connect'), { code: 'ENOTFOUND' });
  assert.equal(classifyThrown(wrapped).class, 'retryable');
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(classifyThrown(abort).class, 'ambiguous');
  assert.equal(classifyThrown(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).class, 'ambiguous');
  assert.equal(classifyThrown(new Error('mystery')).class, 'ambiguous');
});

test('backoff is bounded', () => {
  assert.equal(backoffMs(1, null, cfg, () => 0.5), 1_000);
  assert.equal(backoffMs(1, null, cfg, () => 0), 800);
  assert.equal(backoffMs(1, null, cfg, () => 1), 1_200);
  assert.equal(backoffMs(2, null, cfg, () => 0.5), 2_000);
  assert.equal(backoffMs(20, null, cfg, () => 0.5), 60_000);
  assert.equal(backoffMs(1, 120_000, cfg, () => 0.5), 60_000);
  assert.equal(backoffMs(1, 5_000, cfg, () => 0.5), 5_000);
  assert.equal(backoffMs(1, 0, cfg, () => 0.5), 1_000);
});

test('only a delivered result can mark the job delivered', () => {
  const classes = ['retryable', 'ambiguous', 'poison', 'weird', undefined];
  for (const klass of classes) {
    const out = decideOutcome({
      attempt: 1,
      result: { class: klass, status: klass === 'retryable' ? 500 : 400, errorCode: 'x', errorMessage: 'no' },
      cfg,
      now: 10,
      rand: () => 0.5,
    });
    assert.notEqual(out.state, 'delivered', klass);
    assert.equal(out.delivered_at, undefined);
  }
  const ok = decideOutcome({
    attempt: 1,
    result: { class: 'delivered', status: 200, errorCode: 'http_2xx', errorMessage: '' },
    cfg,
    now: 10,
    rand: () => 0.5,
  });
  assert.equal(ok.state, 'delivered');
  assert.equal(ok.delivered_at, 10);
  assert.equal(ok.terminal, true);
});

test('retryable failures use capped attempts then dead-letter', () => {
  const again = decideOutcome({
    attempt: 1,
    result: { class: 'retryable', status: 429, errorCode: 'http_429', errorMessage: 'slow', retryAfterMs: null },
    cfg,
    now: 50,
    rand: () => 0.5,
  });
  assert.equal(again.state, 'queued');
  assert.equal(again.terminal, false);
  assert.equal(again.next_attempt_at, 1_050);
  const dead = decideOutcome({
    attempt: cfg.maxAttempts,
    result: { class: 'retryable', status: 503, errorCode: 'http_503', errorMessage: 'down' },
    cfg,
    now: 50,
    rand: () => 0.5,
  });
  assert.equal(dead.state, 'dead');
  assert.equal(dead.last_outcome, 'exhausted');
});

test('ambiguous is held unless retryAmbiguous is on, and still not delivered', () => {
  const held = decideOutcome({
    attempt: 1,
    result: { class: 'ambiguous', status: null, errorCode: 'timeout', errorMessage: 'aborted' },
    cfg,
    now: 50,
    rand: () => 0.5,
  });
  assert.equal(held.state, 'ambiguous');
  assert.equal(held.terminal, true);
  const retry = decideOutcome({
    attempt: 1,
    result: { class: 'ambiguous', status: null, errorCode: 'timeout', errorMessage: 'aborted' },
    cfg: { ...cfg, retryAmbiguous: true },
    now: 50,
    rand: () => 0.5,
  });
  assert.equal(retry.state, 'queued');
  assert.notEqual(retry.state, 'delivered');
});

test('user-facing copy distinguishes uncertain from definite failure', () => {
  assert.match(userFacingDetail({ state: 'ambiguous', last_outcome: 'timeout' }), /结果不确定/);
  assert.match(userFacingDetail({ state: 'dead', last_outcome: 'exhausted', last_error: 'webhook HTTP 503' }), /唤醒 Grok 失败：webhook HTTP 503/);
  assert.match(userFacingDetail({ state: 'dead', last_outcome: 'MISSING_WEBHOOK' }), /GROK_WEBHOOK_URL is missing/);
  assert.equal(progressBody('done'), '✅ 已唤醒');
  assert.equal(progressBody('failed'), '⚠️ 唤醒失败');
  assert.equal(progressBody('cancelled'), '🛑 已取消');
  assert.equal(progressBody('uncertain'), '⏳ 结果不确定');
});
