import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBrainClient } from '../src/mcp-brain.js';

export async function runBrainCheck({ call = createBrainClient({ log: () => {} }), log = console.log } = {}) {
  const { status, summary, result } = await call('brain_whoami');
  if (status === 404) {
    log('大脑总闸关闭');
    return 3;
  }
  if (status !== 200 || result?.isError || !summary) {
    log('大脑暂时不可用');
    return 1;
  }
  log(JSON.stringify(summary));
  return 0;
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  process.exitCode = await runBrainCheck();
}
