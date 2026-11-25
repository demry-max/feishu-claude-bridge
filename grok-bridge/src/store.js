import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function defaultDataDir() {
  return process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, data) {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error(`[store] write ${path.basename(file)} failed:`, e?.message ?? e);
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

export function loadOwner(dir = defaultDataDir()) {
  const d = readJson(path.join(dir, 'owner.json'), {});
  return (d && typeof d === 'object' ? d.open_id : null) ?? null;
}

export function saveOwner(openId, dir = defaultDataDir()) {
  return writeJsonSafe(path.join(dir, 'owner.json'), { open_id: openId });
}
