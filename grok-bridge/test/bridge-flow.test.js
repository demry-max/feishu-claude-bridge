import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, bootLines } from '../src/index.js';
import { DELIVERY_DEFAULTS } from '../src/delivery-policy.js';
import { WEBHOOK_PAYLOAD_KEYS } from '../src/payload.js';

const KEY = 'test-webhook-key-value';

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-bridge-'));
  return {
    root,
    workspaceDir: path.join(root, 'workspace'),
    guestWorkspaceDir: path.join(root, 'workspace-guest'),
    dataDir: path.join(root, 'data'),
    deliveryDir: path.join(root, 'data', 'delivery'),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function bridge(over = {}) {
  const dirs = tree();
  const events = [];
  const logs = [];
  const errors = [];
  let fetchImpl = over.fetch || (async () => ({ status: 200, ok: true, headers: {}, text: async () => '' }));
  const app = createBridge({
    env: {
      GROK_WEBHOOK_URL: 'http://127.0.0.1:9/hook/SECRETTOKEN?token=abcdefghij',
      GROK_WEBHOOK_KEY: KEY,
      OWNER_OPEN_ID: 'ou_owner',
      ALLOW_USERS: over.allowUsers ?? '',
      ALLOW_CHATS: over.allowChats ?? '',
      ACK_EMOJI: 'OnIt',
      DONE_EMOJI: 'DONE',
      ...over.env,
    },
    ...dirs,
    config: { ...DELIVERY_DEFAULTS, ...over.config },
    log: (line) => logs.push(String(line)),
    errlog: (...args) => errors.push(args.map(String).join(' ')),
    fetch: (url, init) => fetchImpl(url, init),
    outbound: {
      react: async (id, emoji) => { events.push(['react', id, emoji]); },
      replyText: async (id, text) => { events.push(['reply', id, text]); return `reply-${events.length}`; },
      createProgress: over.createProgress || (async (id, text) => {
        events.push(['progress', id, text]);
        return { progressMessageId: 'pm_1' };
      }),
      finishProgress: async (id, status, note) => { events.push(['finish', id, status, note || '']); },
    },
  });
  return {
    app,
    dirs,
    events,
    logs,
    errors,
    setFetch: (fn) => { fetchImpl = fn; },
    cleanup() {
      app.close();
      dirs.cleanup();
    },
  };
}

function line(fields) {
  return JSON.stringify({
    message_id: 'om_1',
    chat_id: 'oc_owner',
    chat_type: 'p2p',
    sender_id: 'ou_owner',
    sender_type: 'user',
    message_type: 'text',
    content: 'hello',
    ...fields,
  });
}

test('boot lines keep the webhook key and URL secret', () => {
  const lines = bootLines({
    env: {
      OWNER_OPEN_ID: 'ou_owner',
      GROK_WEBHOOK_URL: 'http://user:supersecretpass@127.0.0.1:9/hook/SECRETTOKEN?token=abcdefghij',
      GROK_WEBHOOK_KEY: KEY,
    },
    dirs: { workspaceDir: '/tmp/workspace', guestWorkspaceDir: '/tmp/guest' },
    config: DELIVERY_DEFAULTS,
    summary: { counts: { queued: 0, ambiguous: 0, dead: 0 } },
  }).join('\n');
  assert.match(lines, /delivery=durable/);
  assert.match(lines, /timeout_ms=15000/);
  assert.match(lines, /key=set/);
  assert.equal(lines.includes(KEY), false);
  assert.equal(lines.includes('supersecretpass'), false);
  assert.equal(lines.includes('SECRETTOKEN'), false);
  assert.equal(lines.includes('abcdefghij'), false);
});

test('owner text matches the deployed payload and only finishes after HTTP 200', async () => {
  let seen;
  const h = bridge({
    fetch: async (url, init) => {
      seen = { url, init };
      return { status: 200, ok: true, headers: {}, text: async () => '' };
    },
  });
  try {
    await h.app.handleLine(line({
      content: `hello ${KEY}`,
      mentions: [{ key: 'bot' }],
      reply_to: 'om_parent',
      root_id: 'om_root',
      thread_id: 'om_thread',
      create_time: '1700000000000',
      event_id: 'evt_1',
    }));
    const body = JSON.parse(seen.init.body);
    assert.deepEqual(Object.keys(body), WEBHOOK_PAYLOAD_KEYS);
    assert.equal(body.source, 'feishu-grok-bridge');
    assert.equal(body.type, 'im.message.receive_v1');
    assert.equal(body.message_id, 'om_1');
    assert.equal(body.session_key, 'oc_owner');
    assert.equal(body.is_owner, true);
    assert.equal(body.progress_message_id, 'pm_1');
    assert.equal(body.reply_to, 'om_parent');
    assert.equal(body.root_id, 'om_root');
    assert.equal(body.thread_id, 'om_thread');
    assert.match(body.memory_hint, /USER\.md/);
    assert.match(body.outbox_dir, /outbox/);
    assert.equal(fs.existsSync(body.outbox_dir), true);
    assert.equal(seen.init.headers['Idempotency-Key'], 'om_1');
    assert.equal(seen.init.headers['User-Agent'], 'feishu-grok-bridge/1.1');
    assert.deepEqual(h.events.map((e) => e[0] === 'react' ? e[2] : e[0]), ['OnIt', 'progress', 'DONE', 'finish']);
    assert.equal(h.events.find((e) => e[0] === 'progress')[2], '🔄 处理中…');
    assert.equal(h.events.find((e) => e[0] === 'finish')[2], 'done');
    assert.equal(h.events.some((e) => e[0] === 'reply'), false);
    assert.equal(h.logs.join('\n').includes(KEY), false);
    assert.equal(h.errors.join('\n').includes(KEY), false);
    assert.match(h.logs.join('\n'), /\[webhook\] ok status=200/);
  } finally {
    h.cleanup();
  }
});

test('duplicate ingress does not repeat progress or the webhook', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = bridge({
    fetch: () => {
      calls += 1;
      return gate.then(() => ({ status: 200, ok: true, headers: {}, text: async () => '' }));
    },
  });
  try {
    const first = h.app.handleLine(line({ message_id: 'om_dup' }));
    const second = h.app.handleLine(line({ message_id: 'om_dup', content: 'again' }));
    await second;
    release();
    await first;
    assert.equal(calls, 1);
    assert.equal(h.events.filter((e) => e[0] === 'progress').length, 1);
  } finally {
    h.cleanup();
  }
});

test('guest, deny, mention, bot, commands, empty text, and files keep current behavior', async () => {
  const fetches = [];
  const h = bridge({
    allowUsers: 'ou_owner,ou_guest',
    fetch: async (url, init) => {
      fetches.push(JSON.parse(init.body));
      return { status: 200, ok: true, headers: {}, text: async () => '' };
    },
  });
  try {
    await h.app.handleLine(line({
      message_id: 'om_guest',
      chat_id: 'oc_g',
      sender_id: 'ou_guest',
      content: 'hi guest',
    }));
    const guest = fetches.at(-1);
    assert.equal(guest.is_owner, false);
    assert.equal(guest.session_key, 'guest:oc_g:ou_guest');
    assert.equal(guest.memory_hint, null);
    assert.match(guest.workspace_dir, /workspace-guest/);
    assert.equal(fs.existsSync(guest.outbox_dir), true);

    await h.app.handleLine(line({
      message_id: 'om_file',
      sender_id: 'ou_guest',
      chat_id: 'oc_g',
      message_type: 'file',
      content: 'report.pdf',
    }));
    assert.equal(fetches.at(-1).message_type, 'file');
    assert.equal(fetches.at(-1).content, 'report.pdf');

    const beforeDeny = fetches.length;
    await h.app.handleLine(line({ message_id: 'om_deny', sender_id: 'ou_stranger' }));
    assert.equal(fetches.length, beforeDeny);
    assert.match(h.logs.join('\n'), /\[deny\]/);

    await h.app.handleLine(line({
      message_id: 'om_group',
      chat_id: 'oc_group',
      chat_type: 'group',
      content: 'no mention',
    }));
    assert.equal(fetches.length, beforeDeny);
    assert.match(h.logs.join('\n'), /group without @mention/);

    await h.app.handleLine(line({
      message_id: 'om_group_ok',
      chat_id: 'oc_group',
      chat_type: 'group',
      sender_id: 'ou_guest',
      content: '@_user_1 hello',
      mentions: [{ key: 'bot' }],
    }));
    assert.equal(fetches.at(-1).content, 'hello');
    assert.equal(fetches.at(-1).mentions.length, 1);

    await h.app.handleLine(line({ message_id: 'om_bot', sender_type: 'bot', content: 'ignore' }));
    await h.app.handleLine(line({ message_id: 'om_ping', content: '/ping' }));
    await h.app.handleLine(line({ message_id: 'om_ping', content: '/ping' }));
    await h.app.handleLine(line({ message_id: 'om_help', content: '/help' }));
    await h.app.handleLine(line({ message_id: 'om_empty', content: '   ' }));
    await h.app.handleLine('not json');
    await h.app.handleLine('[lark] noise');
    assert.equal(fetches.some((b) => b.content === 'pong' || b.content === '/ping' || b.content === '/help'), false);
    assert.equal(h.events.filter((e) => e[0] === 'reply' && e[2] === 'pong').length, 1);
    assert.match(h.events.find((e) => e[0] === 'reply' && String(e[2]).includes('Local commands'))[2], /Local commands/);
  } finally {
    h.cleanup();
  }
});

test('definite webhook failure and timeout do not mark delivered or claim DONE', async () => {
  const h = bridge();
  try {
    h.setFetch(async () => ({ status: 400, ok: false, headers: {}, text: async () => `no ${KEY}` }));
    await h.app.handleLine(line({ message_id: 'om_400' }));
    assert.equal(h.app.store.getByMessageId('om_400').state, 'dead');
    assert.equal(h.app.store.getByMessageId('om_400').delivered_at, null);
    assert.equal(h.events.some((e) => e[2] === 'DONE'), false);
    assert.equal(h.events.some((e) => e[0] === 'finish' && e[2] === 'failed'), true);
    assert.match(h.events.find((e) => e[0] === 'reply')[2], /唤醒 Grok 失败/);
    assert.equal(JSON.stringify(h.events).includes(KEY), false);
    assert.equal(h.errors.join('\n').includes(KEY), false);

    h.events.length = 0;
    h.setFetch((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error(`timeout ${KEY} ${url}`);
        err.name = 'AbortError';
        reject(err);
      });
    }));
    const slow = bridge({
      config: { timeoutMs: 40 },
      fetch: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error(`timeout ${KEY} ${url}`);
          err.name = 'AbortError';
          reject(err);
        });
      }),
    });
    try {
      await slow.app.handleLine(line({ message_id: 'om_timeout' }));
      const job = slow.app.store.getByMessageId('om_timeout');
      assert.equal(job.state, 'ambiguous');
      assert.equal(job.delivered_at, null);
      assert.equal(slow.events.some((e) => e[2] === 'DONE'), false);
      assert.equal(slow.events.some((e) => e[0] === 'finish' && e[2] === 'uncertain'), true);
      assert.match(slow.events.find((e) => e[0] === 'reply')[2], /结果不确定/);
      assert.equal(JSON.stringify(slow.events).includes(KEY), false);
      assert.equal(slow.errors.join('\n').includes('SECRETTOKEN'), false);
      await slow.app.handleLine(line({ message_id: 'om_timeout', content: 'again' }));
      assert.equal(slow.app.store.getByMessageId('om_timeout').state, 'ambiguous');
    } finally {
      slow.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test('accept stays serial per chat while a progress reply is in flight', async () => {
  let started = 0;
  let release;
  const h = bridge({
    createProgress: (id) => {
      started += 1;
      if (started === 1) {
        return new Promise((resolve) => {
          release = () => resolve({ progressMessageId: 'pm_a' });
        });
      }
      return Promise.resolve({ progressMessageId: 'pm_b' });
    },
  });
  try {
    const first = h.app.handleLine(line({ message_id: 'om_a' }));
    await new Promise((r) => setImmediate(r));
    assert.equal(started, 1);
    const second = h.app.handleLine(line({ message_id: 'om_b' }));
    await new Promise((r) => setImmediate(r));
    assert.equal(started, 1);
    release();
    await first;
    await second;
    assert.equal(started, 2);
    const ids = h.app.store.list().filter((j) => j.kind === 'delivery').map((j) => j.message_id);
    assert.deepEqual(ids, ['om_a', 'om_b']);
  } finally {
    h.cleanup();
  }
});

test('missing webhook URL fails before a store is required', () => {
  assert.throws(
    () => createBridge({
      env: { GROK_WEBHOOK_URL: '' },
      workspaceDir: '/tmp/unused-ws',
      guestWorkspaceDir: '/tmp/unused-guest',
      dataDir: '/tmp/unused-data',
      deliveryDir: '/tmp/unused-delivery',
    }),
    (err) => err.code === 'MISSING_WEBHOOK',
  );
});
