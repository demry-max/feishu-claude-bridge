// 安装体检的各单项检查（纯函数为主，便于测试）。入口在 scripts/doctor.js。
//
// 2026-09-13 全新机器安装反馈：从 clone 到能用有 9 处要人工介入——Node 没装、npm 警告像报错、
// OWNER_OPEN_ID 没补、scope 没开、memory/ 没建……这些里能自动做的直接做（补 open_id、建目录），
// 做不了的把「下一步该敲什么」打印出来。
import fs from 'node:fs';
import path from 'node:path';
import { patchEnvFile } from './env-file.js';

const major = (v) => Number(String(v).replace(/^v/, '').split('.')[0]);

/** Node ≥ 18；失败时给免 sudo 的官方 tarball 安装命令（很多非开发者机器没有 Homebrew） */
export function checkNode(version = process.version, platform = process.platform, arch = process.arch) {
  const ok = major(version) >= 18;
  const V = 'v24.21.0';
  const plat = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win' : 'linux';
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  const fix = plat === 'win'
    ? `到 https://nodejs.org/dist/${V}/ 下载 node-${V}-${a}.msi 安装`
    : [
        `V=${V}`,
        `curl -fsSL -o node.tar.xz "https://nodejs.org/dist/$V/node-$V-${plat}-${a}.tar.xz"`,
        `mkdir -p ~/.local && tar -xJf node.tar.xz -C ~/.local && mv ~/.local/node-$V-${plat}-${a} ~/.local/node`,
        `echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`,
      ].join('\n');
  return { ok, version, fix: ok ? null : fix };
}

/** npm ≥ 11 默认拦截依赖的 install scripts 并刷 warn，看着像装失败了——说明它是预期的 */
export function checkNpm(version) {
  const ok = Boolean(version);
  const note = version && major(version) >= 11
    ? `npm ${version} 安装依赖时会打印 "npm warn install-scripts …"（@anthropic-ai/claude-code、protobufjs），这是 npm 11 起的默认提示，不是安装失败。`
    : null;
  return { ok, version: version ?? null, note };
}

const readEnvValue = (text, key) => {
  const line = text.split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).replace(/\s+#.*$/, '').trim() : '';
};

/**
 * .env 存在且必填项非空；OWNER_OPEN_ID 为空而 data/owner.json 有值时自动补写
 * （register 老版本只写 owner.json，多数人不会自己再复制一遍）。
 */
export function checkEnvFile(root) {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) {
    return { ok: false, missing: ['.env'], autofilled: null, fix: '先 npm run register（扫码自动创建应用并写入 .env），或 cp .env.example .env 后手工填写' };
  }
  let text = fs.readFileSync(envPath, 'utf8');
  let autofilled = null;
  if (!readEnvValue(text, 'OWNER_OPEN_ID')) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, 'data', 'owner.json'), 'utf8'));
      if (j?.open_id && patchEnvFile(envPath, { OWNER_OPEN_ID: j.open_id })) {
        autofilled = j.open_id;
        text = fs.readFileSync(envPath, 'utf8');
      }
    } catch { /* 没有 owner.json：首次私聊时会登记 */ }
  }
  const missing = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'OWNER_OPEN_ID'].filter((k) => !readEnvValue(text, k));
  return {
    ok: missing.length === 0,
    missing,
    autofilled,
    fix: missing.length ? `补齐 .env 里的 ${missing.join('、')}（OWNER_OPEN_ID 可在首次私聊登记后从 data/owner.json 取）` : null,
  };
}

/** `claude auth status` 输出 JSON；解析不了视为未知（不能把「输出格式变了」当成「没登录」） */
export function parseAuthStatus(stdout) {
  try {
    const j = JSON.parse(stdout);
    return { loggedIn: typeof j.loggedIn === 'boolean' ? j.loggedIn : null, email: j.email ?? null };
  } catch {
    return { loggedIn: null, email: null };
  }
}
