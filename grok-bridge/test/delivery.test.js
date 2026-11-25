import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, readSnapshot, writeCommand } from '../src/delivery-store.js';
import { createDelivery } from '../src/delivery.js';
import { DELIVERY_DEFAULTS } from '../src/delivery-policy.js';
import { attemptWebhook } from '../src/webhook.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grok-del-'));
}

function harness(opts = {}) {
  const dir = tempDir();
  let t = opts.t ?? 1_000_000;
  const posts = [];
  const ux = [];
  let uxThrows = opts.uxThrows ?? 0;
  const store = openStore(dir, { now: () => t, retryAmbiguous: Boolean(opts.retryAmbiguous) });
  const config = {
    ...DELIVERY_DEFAULTS,
    maxAttempts: opts.maxAttempts ?? DELIVERY_DEFAULTS.maxAttempts,
    retryAmbiguous: Boolean(opts.retryAmbiguous),
    ...opts.config,
  };
  const delivery = createDelivery({
    store,
    now: () => t,
    rand: () => 0.5,
    config,
    log: () => {},
    onTerminal: async (job) => {
      if (uxThrows > 0) {
        uxThrows -= 1;
        throw new Error('ux failed');
      }
      ux.push({ state: job.state, pending: job.ux_pending });
    },
    post: async (payload, meta) => {
      posts.push({ payload, meta });
      if (opts.post) return opts.post(payload, meta);
      const next = opts.results ? opts.results.shift() : null;
      return next || { class: 'delivered', status: 200, errorCode: 'http_2xx', errorMessage: '' };
    },
  });
  return {
    dir,
    store,
    delivery,
    posts,
    ux,
    setTime: (n) => { t = n; },
    time: () => t,
    cleanup() {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function accept(delivery, messageId, extra = {}) {
  return delivery.accept({
    messageId,
    chatId: extra.chatId || 'oc_chat',
    payload: {
      source: 'feishu-grok-bridge',
      type: 'im.message.receive_v1',
      message_id: messageId,
      chat_id: extra.chatId || 'oc_chat',
      content: extra.content ?? `text-${messageId}`,
    },
    ready: extra.ready !== false,
  });
}

test('200 marks delivered once and survives reopen', async () => {
  const h = harness();
  try {
    accept(h.delivery, 'om_1', { content: 'UNIQUE_CONTENT_XYZ' });
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
    assert.equal(h.store.getByMessageId('om_1').state, 'delivered');
    assert.equal(h.ux.length, 1);
    const snap = readSnapshot(h.dir);
    assert.equal(JSON.stringify(snap).includes('UNIQUE_CONTENT_XYZ'), false);
    assert.equal(fs.readFileSync(path.join(h.dir, 'status.json'), 'utf8').includes('UNIQUE_CONTENT_XYZ'), false);
    h.store.close();
    const reopened = openStore(h.dir);
    assert.equal(reopened.getByMessageId('om_1').state, 'delivered');
    assert.ok(reopened.getByMessageId('om_1').delivered_at);
    reopened.close();
  } finally {
    h.cleanup();
  }
});

test('429 then 200 waits for backoff and is not delivered on 429', async () => {
  const h = harness({
    results: [
      { class: 'retryable', status: 429, errorCode: 'http_429', errorMessage: 'slow', retryAfterMs: null },
      { class: 'delivered', status: 200, errorCode: 'http_2xx', errorMessage: '' },
    ],
  });
  try {
    accept(h.delivery, 'om_429');
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
    assert.equal(h.store.getByMessageId('om_429').state, 'queued');
    assert.equal(h.store.getByMessageId('om_429').delivered_at, null);
    assert.equal(h.ux.length, 0);
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
    h.setTime(h.time() + 1_000);
    await h.delivery.pump();
    assert.equal(h.posts.length, 2);
    assert.equal(h.store.getByMessageId('om_429').state, 'delivered');
  } finally {
    h.cleanup();
  }
});

test('5xx is bounded then dead-lettered and never delivered', async () => {
  const h = harness({
    maxAttempts: 2,
    post: async () => ({ class: 'retryable', status: 503, errorCode: 'http_503', errorMessage: 'down' }),
  });
  try {
    accept(h.delivery, 'om_503');
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
    assert.notEqual(h.store.getByMessageId('om_503').state, 'delivered');
    h.setTime(h.time() + 1_000);
    await h.delivery.pump();
    assert.equal(h.posts.length, 2);
    assert.equal(h.store.getByMessageId('om_503').state, 'dead');
    assert.equal(h.store.getByMessageId('om_503').last_outcome, 'exhausted');
    h.setTime(h.time() + 60_000);
    await h.delivery.pump();
    assert.equal(h.posts.length, 2);
  } finally {
    h.cleanup();
  }
});

test('opt-in ambiguous retry still does not mark delivered until 2xx', async () => {
  const results = [
    { class: 'ambiguous', status: null, errorCode: 'timeout', errorMessage: 'aborted' },
    { class: 'delivered', status: 200, errorCode: 'http_2xx', errorMessage: '' },
  ];
  const h = harness({
    retryAmbiguous: true,
    post: async () => results.shift(),
  });
  try {
    accept(h.delivery, 'om_retry_timeout');
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
    assert.equal(h.store.getByMessageId('om_retry_timeout').state, 'queued');
    assert.equal(h.store.getByMessageId('om_retry_timeout').delivered_at, null);
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
    h.setTime(h.time() + 1_000);
    await h.delivery.pump();
    assert.equal(h.posts.length, 2);
    assert.equal(h.store.getByMessageId('om_retry_timeout').state, 'delivered');
  } finally {
    h.cleanup();
  }
});

test('wired HTTP 500 and client timeout are not marked delivered', async () => {
  const dir = tempDir();
  try {
    let mode = '500';
    const store = openStore(dir);
    const delivery = createDelivery({
      store,
      now: () => 1_000,
      rand: () => 0.5,
      config: { ...DELIVERY_DEFAULTS, maxAttempts: 3 },
      log: () => {},
      post: (payload, meta) => attemptWebhook(payload, {
        url: 'http://127.0.0.1:9/hook',
        timeoutMs: 30,
        attempt: meta.attempt,
        messageId: meta.messageId,
        fetch: (url, init) => {
          if (mode === '500') {
            return Promise.resolve({ status: 500, ok: false, headers: {}, text: async () => 'down' });
          }
          return new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        },
      }),
    });
    delivery.accept({
      messageId: 'om_wire',
      chatId: 'c',
      payload: { message_id: 'om_wire', content: 'wire' },
    });
    await delivery.pump();
    assert.equal(store.getByMessageId('om_wire').state, 'queued');
    assert.equal(store.getByMessageId('om_wire').delivered_at, null);
    store.update(store.getByMessageId('om_wire').id, { state: 'queued', next_attempt_at: 0, attempts: 0 });
    mode = 'timeout';
    await delivery.pump();
    const job = store.getByMessageId('om_wire');
    assert.equal(job.state, 'ambiguous');
    assert.equal(job.delivered_at, null);
    await delivery.pump();
    assert.equal(store.getByMessageId('om_wire').state, 'ambiguous');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate ingress produces one job and one post', async () => {
  const h = harness();
  try {
    const a = accept(h.delivery, 'om_dup');
    const b = accept(h.delivery, 'om_dup');
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    await h.delivery.pump();
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
    assert.equal(h.store.list().filter((j) => j.kind === 'delivery').length, 1);
  } finally {
    h.cleanup();
  }
});

test('poison HTTP and poison payload are not retried', async () => {
  const h = harness({
    post: async () => ({ class: 'poison', status: 400, errorCode: 'http_400', errorMessage: 'bad request' }),
  });
  try {
    accept(h.delivery, 'om_bad');
    await h.delivery.pump();
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
    assert.equal(h.store.getByMessageId('om_bad').state, 'dead');
    assert.equal(h.store.getByMessageId('om_bad').last_outcome, 'poison');
    const marker = 'UNIQUE_OVERSIZE_MARKER';
    const poison = h.delivery.accept({
      messageId: 'om_big',
      chatId: 'c',
      payload: { message_id: 'om_big', content: marker + 'x'.repeat(300_000) },
    });
    assert.equal(poison.job.state, 'dead');
    assert.equal(poison.job.last_outcome, 'poison_payload');
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
    const dumped = fs.readdirSync(path.join(h.dir, 'jobs')).map((name) => fs.readFileSync(path.join(h.dir, 'jobs', name), 'utf8')).join('\n');
    assert.equal(dumped.includes(marker), false);
    const odd = h.delivery.accept({
      messageId: 'om_bigint',
      chatId: 'c',
      payload: { message_id: 'om_bigint', n: 1n },
    });
    assert.equal(odd.job.state, 'dead');
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
  } finally {
    h.cleanup();
  }
});

test('crash after queueing delivers once; crash in flight does not resend', async () => {
  const dir = tempDir();
  const storeHref = new URL('../src/delivery-store.js', import.meta.url).href;
  const queuedCode = `
    import { openStore } from ${JSON.stringify(storeHref)};
    const s = openStore(${JSON.stringify(dir)});
    s.insertDelivery({ message_id: 'om_queued', chat_id: 'c', payload: { message_id: 'om_queued', content: 'persist-me' }, ready: true });
    s.insertDelivery({ message_id: 'om_flight', chat_id: 'c', payload: { message_id: 'om_flight', content: 'maybe-sent' }, ready: true });
    const flight = s.getByMessageId('om_flight');
    s.update(flight.id, { state: 'inflight', attempts: 1 });
    process.exit(0);
  `;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', queuedCode], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const store = openStore(dir);
    assert.equal(store.getByMessageId('om_queued').state, 'queued');
    assert.equal(store.getByMessageId('om_queued').payload.content, 'persist-me');
    const flight = store.getByMessageId('om_flight');
    assert.equal(flight.state, 'ambiguous');
    assert.equal(flight.delivered_at, null);
    assert.equal(flight.last_outcome, 'crash_inflight');
    const posts = [];
    const delivery = createDelivery({
      store,
      now: () => Date.now(),
      rand: () => 0.5,
      config: { ...DELIVERY_DEFAULTS },
      log: () => {},
      post: async (payload) => {
        posts.push(payload.message_id);
        return { class: 'delivered', status: 200, errorCode: 'http_2xx', errorMessage: '' };
      },
    });
    await delivery.pump();
    assert.deepEqual(posts, ['om_queued']);
    assert.equal(store.getByMessageId('om_queued').state, 'delivered');
    assert.equal(store.getByMessageId('om_flight').state, 'ambiguous');
    await delivery.pump();
    assert.deepEqual(posts, ['om_queued']);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unready job is sent after restart because the request never started', async () => {
  const dir = tempDir();
  try {
    const s1 = openStore(dir);
    s1.insertDelivery({
      message_id: 'om_unready',
      chat_id: 'c',
      payload: { message_id: 'om_unready', content: 'later' },
      ready: false,
    });
    s1.close();
    const store = openStore(dir);
    assert.equal(store.getByMessageId('om_unready').ready, true);
    const posts = [];
    const delivery = createDelivery({
      store,
      now: () => Date.now(),
      rand: () => 0.5,
      config: { ...DELIVERY_DEFAULTS },
      log: () => {},
      post: async () => {
        posts.push(1);
        return { class: 'delivered', status: 200, errorCode: 'http_2xx', errorMessage: '' };
      },
    });
    await delivery.pump();
    assert.equal(posts.length, 1);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('per-chat order holds during backoff and releases after a terminal failure', async () => {
  const h = harness();
  try {
    const first = accept(h.delivery, 'om_a');
    h.store.update(first.job.id, { next_attempt_at: h.time() + 10_000 });
    accept(h.delivery, 'om_b');
    await h.delivery.pump();
    assert.equal(h.posts.length, 0);
    h.store.update(first.job.id, { state: 'dead', last_outcome: 'exhausted' });
    await h.delivery.pump();
    assert.deepEqual(h.posts.map((p) => p.payload.message_id), ['om_b']);
  } finally {
    h.cleanup();
  }
});

test('different chats both send; manual replay and discard obey the command file', async () => {
  const h = harness();
  try {
    accept(h.delivery, 'om_c1', { chatId: 'c1' });
    accept(h.delivery, 'om_c2', { chatId: 'c2' });
    await h.delivery.pump();
    assert.deepEqual(h.posts.map((p) => p.payload.message_id), ['om_c1', 'om_c2']);
    writeCommand(h.dir, { op: 'replay', message_id: 'om_c1' });
    await h.delivery.pump();
    assert.equal(h.posts.length, 2);
    const ambiguous = accept(h.delivery, 'om_hold', { chatId: 'c3' });
    h.store.update(ambiguous.job.id, { state: 'ambiguous', last_outcome: 'timeout', ux_done: true, ux_pending: null });
    writeCommand(h.dir, { op: 'replay', message_id: 'om_hold' });
    await h.delivery.pump();
    assert.equal(h.posts.at(-1).payload.message_id, 'om_hold');
    assert.equal(h.store.getByMessageId('om_hold').state, 'delivered');
    const queued = accept(h.delivery, 'om_drop', { chatId: 'c4' });
    h.store.update(queued.job.id, { next_attempt_at: h.time() + 50_000 });
    const before = h.posts.length;
    writeCommand(h.dir, { op: 'discard', message_id: 'om_drop' });
    await h.delivery.pump();
    assert.equal(h.posts.length, before);
    assert.equal(h.store.getByMessageId('om_drop').state, 'discarded');
  } finally {
    h.cleanup();
  }
});

test('ux failure does not resend a delivered webhook', async () => {
  const h = harness({ uxThrows: 1 });
  try {
    accept(h.delivery, 'om_ux');
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
    assert.equal(h.store.getByMessageId('om_ux').state, 'delivered');
    assert.equal(h.store.getByMessageId('om_ux').ux_done, false);
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
    h.setTime(h.time() + 5_000);
    await h.delivery.pump();
    assert.equal(h.posts.length, 1);
    assert.equal(h.store.getByMessageId('om_ux').ux_done, true);
    assert.equal(h.ux.length, 1);
  } finally {
    h.cleanup();
  }
});

test('store dedupes, keeps 0600 files, and quarantines corrupt jobs', () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jobs', 'bad.json'), '{');
    fs.writeFileSync(path.join(dir, 'META.json'), JSON.stringify({ v: 1 }));
    const store = openStore(dir);
    assert.ok(store.unreadable() >= 1);
    const a = store.insertDelivery({ message_id: 'om_same', chat_id: 'c', payload: { content: 'a' }, ready: true });
    const b = store.insertDelivery({ message_id: 'om_same', chat_id: 'c', payload: { content: 'b' }, ready: true });
    assert.equal(b.duplicate, true);
    assert.equal(a.job.id, b.job.id);
    const mode = fs.statSync(path.join(dir, 'jobs', `${a.job.id}.json`)).mode & 0o777;
    assert.equal(mode, 0o600);
    const future = {
      v: 99,
      id: 'j_future',
      message_id: 'om_future',
      chat_id: 'c',
      kind: 'delivery',
      state: 'queued',
      ready: true,
      seq: 50,
      attempts: 0,
      payload: { content: 'nope' },
    };
    fs.writeFileSync(path.join(dir, 'jobs', 'j_future.json'), JSON.stringify(future));
    store.close();
    const again = openStore(dir);
    assert.equal(again.getByMessageId('om_future').state, 'unsupported');
    const snap = readSnapshot(dir);
    assert.equal(snap.jobs.find((j) => j.message_id === 'om_future').state, 'unsupported');
    assert.equal(JSON.stringify(snap).includes('"content"'), false);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readSnapshot does not rewrite an in-flight job', () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ins = store.insertDelivery({
      message_id: 'om_live',
      chat_id: 'c',
      payload: { content: 'live' },
      ready: true,
    });
    store.update(ins.job.id, { state: 'inflight', attempts: 1 });
    store.close();
    const snap = readSnapshot(dir);
    assert.equal(snap.jobs.find((j) => j.message_id === 'om_live').state, 'inflight');
    const raw = fs.readdirSync(path.join(dir, 'jobs')).map((name) => fs.readFileSync(path.join(dir, 'jobs', name), 'utf8')).join('\n');
    assert.match(raw, /"state":"inflight"/);
    const recovered = openStore(dir);
    assert.equal(recovered.getByMessageId('om_live').state, 'ambiguous');
    recovered.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unsupported store version fails closed', () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'META.json'), JSON.stringify({ v: 2 }));
    assert.throws(() => openStore(dir), /unsupported/);
    const snap = readSnapshot(dir);
    assert.equal(snap.error, 'unsupported_store_version');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
