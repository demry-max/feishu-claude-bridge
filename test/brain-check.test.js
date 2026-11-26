import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runBrainCheck } from '../scripts/brain-check.js';

async function check(response) {
  const outputs = [], calls = [];
  const status = await runBrainCheck({
    call: async (...args) => { calls.push(args); return response; },
    log: (line) => outputs.push(line),
  });
  assert.deepEqual(calls, [['brain_whoami']]);
  return { outputs, status };
}

test('package.json exposes the brain-check script', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts['brain-check'], 'node scripts/brain-check.js');
});

test('brain-check reports only agent, tier, raw permission and quota', async () => {
  const summary = { agent_id: 'private-assistant-owner', read_max_tier: 'L1', raw_allowed: true,
    remaining: { search: { minute: 8 } } };
  const result = await check({ status: 200, summary, result: { content: [{ type: 'text', text: 'marker-not-for-output' }] } });
  assert.equal(result.status, 0);
  assert.deepEqual(result.outputs, [JSON.stringify(summary)]);
});

test('brain-check uses exit 3 for the global gate and exit 1 for other failures', async () => {
  assert.deepEqual(await check({ status: 404 }), { status: 3, outputs: ['大脑总闸关闭'] });
  for (const status of [200, 401, 403, 429, 500, undefined]) {
    assert.deepEqual(await check({ status, result: { isError: true, content: [{ type: 'text', text: 'marker-not-for-output' }] } }),
      { status: 1, outputs: ['大脑暂时不可用'] });
  }
});
