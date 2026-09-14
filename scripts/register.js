// 一键注册飞书应用（移植自 OpenClaw 的设备码注册流程）：
// 扫码授权后，飞书官方接口直接返回 appId + appSecret + 用户 open_id，
// 自动写入 .env 与 data/owner.json —— 无需进开发者后台建应用。
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECOMMENDED_SCOPES } from '../src/feishu-scopes.js';
import { patchEnvFile } from '../src/env-file.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// FEISHU_DOMAIN=lark 时走国际版 Lark 注册端点
const REG_URL =
  process.env.FEISHU_DOMAIN === 'lark'
    ? 'https://accounts.larksuite.com/oauth/v1/app/registration'
    : 'https://accounts.feishu.cn/oauth/v1/app/registration';

async function post(body) {
  const res = await fetch(REG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return res.json(); // pending/error 状态也带 JSON body
}

const ENV_PATH = path.join(ROOT, '.env');

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const init = await post({ action: 'init' });
if (!init.supported_auth_methods?.includes('client_secret')) {
  console.error('当前环境不支持 client_secret 注册方式:', JSON.stringify(init).slice(0, 200));
  process.exit(1);
}

const begin = await post({
  action: 'begin',
  archetype: 'PersonalAgent',
  auth_method: 'client_secret',
  request_user_info: 'open_id',
});
if (!begin.device_code) {
  console.error('注册启动失败:', JSON.stringify(begin).slice(0, 300));
  process.exit(1);
}

const qrUrl = begin.verification_uri_complete;
try {
  const qr = await import('qrcode-terminal');
  qr.default.generate(qrUrl, { small: true });
} catch {
  /* 未安装 qrcode-terminal 时仅打印链接 */
}
console.log('\n请用飞书 App 扫上方二维码，或在手机浏览器打开：\n' + qrUrl + '\n');
console.log(`等待授权（${begin.expire_in || 600} 秒内有效）…`);

let interval = begin.interval || 5;
const deadline = Date.now() + (begin.expire_in || 600) * 1000;

while (Date.now() < deadline) {
  await sleep(interval);
  let p;
  try {
    p = await post({ action: 'poll', device_code: begin.device_code, tp: 'ob_cli_app' });
  } catch {
    continue; // 网络抖动继续轮询
  }
  if (p.client_id && p.client_secret) {
    const openId = p.user_info?.open_id;
    // open_id 同时写进 .env：只写 data/owner.json 的话，盘故障/误删后 owner 身份就丢了，
    // 而多数人不会自己再去把它复制进 OWNER_OPEN_ID
    patchEnvFile(ENV_PATH, {
      FEISHU_APP_ID: p.client_id,
      FEISHU_APP_SECRET: p.client_secret,
      ...(openId ? { OWNER_OPEN_ID: openId } : {}),
    });
    if (openId) {
      const ownerPath = path.join(ROOT, 'data', 'owner.json');
      if (!fs.existsSync(ownerPath)) {
        fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
        fs.writeFileSync(ownerPath, JSON.stringify({ open_id: openId }, null, 2));
        console.log(`✅ 已将扫码人设为 owner（${openId}）`);
      }
      console.log(`✅ OWNER_OPEN_ID=${openId} 已写入 .env`);
    }
    console.log(`✅ 应用创建成功：${p.client_id}，凭据已写入 .env`);
    // 注册接口创建出来的应用是零权限状态：文档/多维表格/电子表格工具会静默失效，
    // 而这一步只能在开发者后台手工做（接口不提供开通 scope 的能力）
    console.log('\n⚠️ 还差一步（必须手工）：应用目前是零权限，飞书文档/多维表格/电子表格工具用不了。');
    console.log('   开发者后台 https://open.feishu.cn/app → 该应用 → 权限管理 → 批量导入，粘贴：');
    console.log('   ' + JSON.stringify({ scopes: { tenant: RECOMMENDED_SCOPES, user: [] } }));
    console.log('   然后「创建版本」→ 发布。之后 npm start 的启动日志会自检并告诉你哪些工具已可用。');
    console.log('\n下一步：npm start 启动机器人，到飞书私聊它发「你好」。');
    process.exit(0);
  }
  if (p.error === 'authorization_pending') continue;
  if (p.error === 'slow_down') { interval += 2; continue; }
  if (p.error) {
    console.error(`注册失败: ${p.error} ${p.error_description ?? ''}`);
    process.exit(1);
  }
}
console.error('授权超时，请重新运行 npm run register');
process.exit(1);
