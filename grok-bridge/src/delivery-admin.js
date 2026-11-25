#!/usr/bin/env node
/**
 * Read-only queue view, plus replay/discard commands for the running bridge.
 * This process does not open the store for recovery and does not POST.
 *
 * Replay of an ambiguous or crash-inflight job can duplicate downstream work
 * unless the receiver dedupes on message_id. Discard never sends.
 */
import path from 'node:path';
import { readSnapshot, writeCommand } from './delivery-store.js';

function usage() {
  return [
    'usage:',
    '  node src/delivery-admin.js status --dir DIR [--fail-on-held]',
    '  node src/delivery-admin.js replay --dir DIR --message-id ID',
    '  node src/delivery-admin.js discard --dir DIR --message-id ID',
    'DIR defaults to DELIVERY_DIR, or DATA_DIR/delivery.',
  ].join('\n');
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return null;
  const value = argv[i + 1];
  if (value.startsWith('--')) return null;
  return value;
}

function resolveDir(argv) {
  const explicit = flag(argv, '--dir');
  if (explicit) return path.resolve(explicit);
  if (process.env.DELIVERY_DIR) return path.resolve(process.env.DELIVERY_DIR);
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR, 'delivery');
  return null;
}

function checkMessageId(id) {
  if (!id || id.length > 200 || /[/\\\0\s]/.test(id)) {
    console.error('message_id rejected');
    process.exit(2);
  }
}

const argv = process.argv.slice(2);
const op = argv[0];
if (!op || op === '--help' || op === '-h') {
  console.error(usage());
  process.exit(op ? 0 : 2);
}

const dir = resolveDir(argv);
if (!dir) {
  console.error('missing --dir (or DELIVERY_DIR / DATA_DIR)');
  console.error(usage());
  process.exit(2);
}

if (op === 'status') {
  const snap = readSnapshot(dir);
  process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
  if (argv.includes('--fail-on-held')) {
    const c = snap.counts || {};
    if ((c.ambiguous || 0) + (c.dead || 0) + (c.inflight || 0) > 0) process.exit(2);
  }
  process.exit(0);
}

if (op === 'replay' || op === 'discard') {
  const messageId = flag(argv, '--message-id');
  checkMessageId(messageId);
  if (op === 'replay') {
    console.error('replay can duplicate downstream work if the receiver does not dedupe message_id');
  }
  const name = writeCommand(dir, {
    op,
    message_id: messageId,
    requested_at: new Date().toISOString(),
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    op,
    message_id: messageId,
    queued_command: name,
    note: 'applied by the bridge on its next pump; this command does not POST',
  })}\n`);
  process.exit(0);
}

console.error(usage());
process.exit(2);
