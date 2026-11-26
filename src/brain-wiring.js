import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BIZ_ENV_STRIP, ENV_BIN, SRC_DIR } from './biz-wiring.js';

export const BRAIN_INIT_MISMATCH = 'brain_init_mismatch';
export const BRAIN_INIT_STOP = '本轮工具环境异常，已停止';

export function brainMcpServer() {
  const unset = BIZ_ENV_STRIP.flatMap((key) => ['-u', key]);
  return {
    type: 'stdio', command: ENV_BIN,
    args: [...unset, process.execPath, path.join(SRC_DIR, 'mcp-brain.js')], env: {},
  };
}

export function writeBrainMcpConfig(mcpServers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-brain-mcp-'));
  const cleanup = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 已删 */ }
  };
  const file = path.join(dir, 'mcp.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ mcpServers }), { mode: 0o600 });
  } catch (e) {
    cleanup();
    throw e;
  }
  return { file, cleanup };
}

export function brainInitDifference(expected, reported) {
  const missing = new Set(expected);
  let extra = 0;
  for (const server of Array.isArray(reported) ? reported : []) {
    if (!missing.delete(server?.name)) extra++;
  }
  return { extra, missing: missing.size };
}
