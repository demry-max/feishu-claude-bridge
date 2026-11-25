import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore } from '../src/delivery-store.js';

const cli = new URL('../src/delivery-admin.js', import.meta.url);

function run(args) {
  return spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8' });
}

test('status is read-only and omits message content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-admin-'));
  try {
    const store = openStore(dir);
    const ins = store.insertDelivery({
      message_id: 'om_admin',
      chat_id: 'oc_admin',
      payload: { content: 'UNIQUE_ADMIN_CONTENT' },
      ready: true,
    });
    store.update(ins.job.id, { state: 'inflight', attempts: 1 });
    store.close();
    const status = run(['status', '--dir', dir]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.includes('UNIQUE_ADMIN_CONTENT'), false);
    assert.equal(status.stderr.includes('UNIQUE_ADMIN_CONTENT'), false);
    const snap = JSON.parse(status.stdout);
    assert.equal(snap.jobs.find((j) => j.message_id === 'om_admin').state, 'inflight');
    const raw = fs.readFileSync(path.join(dir, 'jobs', `${ins.job.id}.json`), 'utf8');
    assert.match(raw, /"state":"inflight"/);
    const held = run(['status', '--dir', dir, '--fail-on-held']);
    assert.equal(held.status, 2);
    const missing = run(['status']);
    assert.equal(missing.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replay and discard only queue a command and do not POST', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-admin-'));
  try {
    const replay = run(['replay', '--dir', dir, '--message-id', 'om_admin']);
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stderr, /duplicate/);
    const body = JSON.parse(replay.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.op, 'replay');
    assert.match(body.note, /does not POST/);
    const names = fs.readdirSync(path.join(dir, 'commands'));
    assert.equal(names.length, 1);
    const cmd = JSON.parse(fs.readFileSync(path.join(dir, 'commands', names[0]), 'utf8'));
    assert.deepEqual({ op: cmd.op, message_id: cmd.message_id }, { op: 'replay', message_id: 'om_admin' });
    assert.equal(JSON.stringify(cmd).includes('http'), false);
    const bad = run(['replay', '--dir', dir, '--message-id', '../etc/passwd']);
    assert.equal(bad.status, 2);
    const discard = run(['discard', '--dir', dir, '--message-id', 'om_admin']);
    assert.equal(discard.status, 0, discard.stderr);
    assert.equal(fs.readdirSync(path.join(dir, 'commands')).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
