import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptWebhook,
  postToGrok,
  describeWebhookUrl,
  USER_AGENT,
  DEFAULT_TIMEOUT_MS,
} from '../src/webhook.js';
import { WEBHOOK_PAYLOAD_KEYS, buildWebhookPayload } from '../src/payload.js';

const URL = 'http://user:supersecretpass@127.0.0.1:9/hook/SECRETTOKEN?token=abcdefghij';
const KEY = 'test-webhook-key-value';

function payload() {
  return buildWebhookPayload({
    message_id: 'om_test',
    chat_id: 'oc_test',
    chat_type: 'p2p',
    sender_id: 'ou_owner',
    sender_type: 'user',
    content: 'hello',
    message_type: 'text',
    mentions: [],
    reply_to: null,
    root_id: null,
    thread_id: null,
    create_time: '1700000000000',
    event_id: 'evt_1',
    progress_message_id: 'om_progress',
    session_key: 'oc_test',
    is_owner: true,
    owner_open_id: 'ou_owner',
    workspace_dir: '/tmp/workspace',
    outbox_dir: '/tmp/workspace/outbox/oc_test',
    memory_hint: 'Read USER.md',
  });
}

test('describeWebhookUrl hides userinfo, path, and query', () => {
  const described = describeWebhookUrl(URL);
  assert.match(described, /host=127\.0\.0\.1/);
  assert.equal(described.includes('supersecretpass'), false);
  assert.equal(described.includes('SECRETTOKEN'), false);
  assert.equal(described.includes('abcdefghij'), false);
  assert.equal(described.includes(URL), false);
  assert.equal(DEFAULT_TIMEOUT_MS, 15_000);
});

test('200 posts the compatible body and does not treat res.ok as authority', async () => {
  let seen;
  const result = await attemptWebhook(payload(), {
    url: 'http://127.0.0.1:9/hook',
    key: KEY,
    attempt: 2,
    messageId: 'om_test',
    fetch: async (url, init) => {
      seen = { url, init };
      return { status: 200, ok: true, headers: {}, text: async () => '{"ok":true}' };
    },
  });
  assert.equal(result.class, 'delivered');
  assert.equal(result.status, 200);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['User-Agent'], USER_AGENT);
  assert.equal(seen.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(seen.init.headers['X-Api-Key'], KEY);
  assert.equal(seen.init.headers['X-Automation-Key'], KEY);
  assert.equal(seen.init.headers['Idempotency-Key'], 'om_test');
  assert.equal(seen.init.headers['X-Delivery-Attempt'], '2');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(Object.keys(body), WEBHOOK_PAYLOAD_KEYS);
  assert.equal(body.source, 'feishu-grok-bridge');
  assert.equal(body.type, 'im.message.receive_v1');
  assert.equal(body.content, 'hello');
  assert.equal(body.delivery_attempt, undefined);
  assert.equal(seen.init.body.includes(KEY), false);

  const lied = await attemptWebhook(payload(), {
    url: 'http://127.0.0.1:9/hook',
    fetch: async () => ({ status: 500, ok: true, headers: {}, text: async () => 'no' }),
  });
  assert.equal(lied.class, 'retryable');
  assert.notEqual(lied.class, 'delivered');
});

test('429/5xx are retryable and 4xx/504/409 are not success', async () => {
  async function statusOf(status, headers = {}) {
    const result = await attemptWebhook({ message_id: 'om_test' }, {
      url: 'http://127.0.0.1:9/hook',
      key: KEY,
      fetch: async () => ({ status, ok: status < 300, headers, text: async () => `body-${status}` }),
    });
    return result;
  }
  const tooMany = await statusOf(429, { get: (n) => (n.toLowerCase() === 'retry-after' ? '3' : null) });
  assert.equal(tooMany.class, 'retryable');
  assert.equal(tooMany.retryAfterMs, 3_000);
  assert.equal(tooMany.errorMessage.includes(KEY), false);
  assert.equal((await statusOf(500)).class, 'retryable');
  assert.equal((await statusOf(502)).class, 'retryable');
  assert.equal((await statusOf(503)).class, 'retryable');
  assert.equal((await statusOf(400)).class, 'poison');
  assert.equal((await statusOf(401)).class, 'poison');
  assert.equal((await statusOf(504)).class, 'ambiguous');
  assert.equal((await statusOf(409)).class, 'ambiguous');
  assert.notEqual((await statusOf(500)).class, 'delivered');
});

test('client timeout is ambiguous and is not delivered', async () => {
  const result = await attemptWebhook(payload(), {
    url: URL,
    key: KEY,
    timeoutMs: 30,
    messageId: 'om_test',
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error(`aborted ${url} ${KEY}`);
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  assert.equal(result.class, 'ambiguous');
  assert.equal(result.errorCode, 'timeout');
  assert.equal(result.status, null);
  assert.equal(result.errorMessage.includes('SECRETTOKEN'), false);
  assert.equal(result.errorMessage.includes('supersecretpass'), false);
  assert.equal(result.errorMessage.includes(KEY), false);
  assert.equal(result.errorMessage.includes('abcdefghij'), false);
  await assert.rejects(
    () => postToGrok({ message_id: 'om_test' }, {
      url: 'http://127.0.0.1:9/hook',
      timeoutMs: 20,
      fetch: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    }),
    (err) => err.code === 'WEBHOOK_TIMEOUT' && err.deliveryClass === 'ambiguous',
  );
});

test('connection refused retries; reset after send does not', async () => {
  const refused = await attemptWebhook({ message_id: 'om_test' }, {
    url: URL,
    key: KEY,
    fetch: async () => {
      throw Object.assign(new Error(`connect ${URL}`), { code: 'ECONNREFUSED' });
    },
  });
  assert.equal(refused.class, 'retryable');
  assert.equal(refused.errorMessage.includes('SECRETTOKEN'), false);
  const reset = await attemptWebhook({ message_id: 'om_test' }, {
    url: 'http://127.0.0.1:9/hook',
    fetch: async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    },
  });
  assert.equal(reset.class, 'ambiguous');
  assert.notEqual(reset.class, 'delivered');
});

test('missing URL is poison and legacy headers can be suppressed', async () => {
  const missing = await attemptWebhook({ message_id: 'om_test' }, { url: '' });
  assert.equal(missing.class, 'poison');
  assert.equal(missing.errorCode, 'MISSING_WEBHOOK');
  let headers;
  await attemptWebhook({ message_id: 'om_test' }, {
    url: 'http://127.0.0.1:9/hook',
    key: KEY,
    idempotencyHeader: false,
    fetch: async (url, init) => {
      headers = init.headers;
      return { status: 204, ok: true, text: async () => '' };
    },
  });
  assert.equal(headers['Idempotency-Key'], undefined);
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
});
