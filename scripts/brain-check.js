import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBrainClient } from '../src/mcp-brain.js';

export async function runBrainCheck({ call = createBrainClient({ log: () => {} }), log = console.log } = {}) {
  const { status, summary, result, errorCode } = await call('brain_whoami');
  if (status === 404) {
    log('大脑总闸关闭');
    return 3;
  }
  if (status !== 200 || result?.isError || !summary) {
    log(errorCode ? `大脑暂时不可用（${errorCode}）` : '大脑暂时不可用');
    return 1;
  }
  if (summary.agent_id !== 'private-assistant-owner' || summary.channel !== 'dm'
    || !Array.isArray(summary.read_tiers) || !summary.read_tiers.includes('L1')) {
    log('大脑自检未通过（brain_whoami_unexpected_access）');
    return 1;
  }
  log(JSON.stringify({ ...summary, identity_check: '身份由 Asker 头核验' }));
  return 0;
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  process.exitCode = await runBrainCheck();
}
