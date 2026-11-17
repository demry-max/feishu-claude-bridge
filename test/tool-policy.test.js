// BRIDGE-PERM-1：owner 工具档的纯策略层（src/tool-policy.js）与 45 天用量回放（scripts/replay-tool-usage.js）。
// 这里全是纯函数：不读环境变量、不碰文件（回放夹具除外）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerText, OWNER as O_NAME, YOU as O_YOU } from '../src/owner-name.js'; // BRIDGE-PUB-1：称呼按配置（测试里未设：owner / 你）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LARK_POLICY, STRICT_TOOLS, larkRules, classifyCommand, classifySegments,
  safeName, auditName, detectConfirm, CONFIRM_DEFAULT_PROMPT,
} from '../src/tool-policy.js';
import { replayUsage, formatReplay } from '../scripts/replay-tool-usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const USAGE_FILE = path.join(__dirname, 'fixtures', 'owner-lark-usage-45d.txt');
const USAGE = fs.readFileSync(USAGE_FILE, 'utf8');
const PREFIXES = ['', '--as user ', '--as bot '];

const entryText = (e) => [e.domain, e.cmd, e.method].filter(Boolean).join(' ');
const rulesOf = (e) => PREFIXES.map((p) => `Bash(lark-cli ${p}${entryText(e)}:*)`);
const ofClass = (...cls) => LARK_POLICY.filter((e) => cls.includes(e.class));

test('策略表：卡片点名的各级子命令都在，分级正确', () => {
  const cls = (d, c, m) => LARK_POLICY.find((e) => e.domain === d && (e.cmd ?? null) === (c ?? null) && (e.method ?? null) === (m ?? null))?.class;
  for (const c of ['+chat-messages-list', '+messages-mget', '+threads-messages-list', '+messages-search', '+chat-list',
    '+chat-search', '+chat-members-list', '+messages-resources-download', '+messages-resource-download']) {
    assert.equal(cls('im', c), 'read', `im ${c}`);
  }
  for (const [c, m] of [['chats', 'list'], ['chats', 'get'], ['chat.members', 'get'], ['messages', 'list'], ['messages', 'get']]) {
    assert.equal(cls('im', c, m), 'read', `im ${c} ${m}`);
  }
  for (const [c, m] of [['tasks', 'query'], ['instances', 'get'], ['instances', 'initiated'], ['approvals', 'search'], ['approvals', 'get']]) {
    assert.equal(cls('approval', c, m), 'read', `approval ${c} ${m}`);
  }
  for (const [d, c] of [['contact', '+search-user'], ['contact', '+get-user'], ['calendar', '+agenda'], ['calendar', '+freebusy'],
    ['mail', '+message'], ['mail', '+triage'], ['mail', '+thread'], ['docs', '+fetch'], ['sheets', '+workbook-info'],
    ['sheets', '+csv-get'], ['sheets', '+cells-get'], ['sheets', '+info'], ['drive', '+download'], ['drive', '+inspect'],
    ['whiteboard', '+export'], ['auth', 'status']]) {
    assert.equal(cls(d, c), 'read', `${d} ${c}`);
  }
  assert.equal(cls('schema'), 'read');
  for (const [d, c] of [['im', '+messages-send'], ['im', '+messages-reply'], ['drive', '+import'], ['calendar', '+create']]) {
    assert.equal(cls(d, c), 'write', `${d} ${c}`);
  }
  for (const c of ['+reply', '+reply-all', '+send', '+draft-send']) assert.equal(cls('mail', c), 'confirm', `mail ${c}`);
  for (const m of ['approve', 'reject', 'transfer', 'rollback', 'add_sign', 'remind']) assert.equal(cls('approval', 'tasks', m), 'confirm', m);
  for (const m of ['create', 'cancel', 'cc']) assert.equal(cls('approval', 'instances', m), 'confirm', m);
  assert.equal(cls('im', 'messages', 'delete'), 'confirm');
  assert.equal(cls('im', '+chat-create'), 'confirm');
  assert.equal(cls('im', '+chat-update'), 'confirm');
  assert.equal(cls('im', 'chat.members', 'create'), 'confirm');
  assert.equal(cls('im', 'chat.members', 'delete'), 'confirm');
  assert.equal(cls('auth', 'login'), 'chat-only');
  assert.equal(cls('auth', 'qrcode'), 'chat-only');
  assert.equal(cls('api'), 'deny');
  assert.equal(cls('auth', 'logout'), 'deny');
  for (const e of LARK_POLICY) assert.ok(['read', 'write', 'confirm', 'chat-only', 'deny'].includes(e.class), entryText(e));
  assert.deepEqual(STRICT_TOOLS, ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebSearch', 'ToolSearch', 'Skill']);
});

test('classifyCommand：卡片测 6 的五条', () => {
  const r1 = classifyCommand('lark-cli im +chat-messages-list --chat-id oc_x | jq .');
  assert.equal(r1.class, 'read');
  assert.equal(r1.decision, 'allow');
  assert.equal(r1.domain, 'im');
  assert.equal(r1.cmd, '+chat-messages-list');
  assert.deepEqual(r1.profileAllowed, { chat: true, sched: true });

  const r2 = classifyCommand('lark-cli --as user im +messages-send --chat-id oc_x --text "你好"');
  assert.equal(r2.class, 'write');
  assert.equal(r2.decision, 'allow');
  assert.equal(r2.cmd, '+messages-send');
  assert.deepEqual(r2.profileAllowed, { chat: true, sched: false });

  const r3 = classifyCommand('lark-cli api POST /x');
  assert.equal(r3.class, 'deny');
  assert.equal(r3.decision, 'deny');
  assert.deepEqual(r3.profileAllowed, { chat: false, sched: false });

  const r4 = classifyCommand('lark-cli im messages delete --message-id om_x');
  assert.equal(r4.class, 'confirm');
  assert.equal(r4.decision, 'confirm');
  assert.equal(r4.method, 'delete');
  assert.deepEqual(r4.profileAllowed, { chat: false, sched: false });
  const r4b = classifyCommand('lark-cli im messages list --chat-id oc_x');
  assert.equal(r4b.class, 'read');
  assert.equal(r4b.method, 'list');

  const r5 = classifyCommand('lark-cli im +chat-messages-list && lark-cli mail +reply --message-id x');
  assert.equal(r5.class, 'confirm');
  assert.equal(r5.decision, 'confirm');
  assert.equal(r5.domain, 'mail');
  assert.equal(r5.cmd, '+reply');
});

test('classifyCommand：--as 三种写法、全局参数前置、未知子命令一律 deny', () => {
  for (const pre of ['', '--as user ', '--as bot ', '--as=user ', '--as=bot ']) {
    assert.equal(classifyCommand(`lark-cli ${pre}im +messages-send --text x`).class, 'write', pre);
    assert.equal(classifyCommand(`lark-cli ${pre}im +chat-list`).class, 'read', pre);
  }
  for (const cmd of ['lark-cli im +no-such-thing', 'lark-cli foo bar', 'lark-cli im chats create', 'lark-cli approval tasks',
    'lark-cli approval tasks --help', 'lark-cli --format json im +chat-list', 'lark-cli', 'lark-cli auth whoami',
    'lark-cli im --as user +chat-list', '/opt/x/lark-cli im chats delete']) {
    const r = classifyCommand(cmd);
    assert.equal(r.class, 'deny', cmd);
    assert.equal(r.decision, 'deny', cmd);
  }
});

test('classifyCommand：2>&1、2>/dev/null 等重定向不影响判定；; 换行 $( ) 反引号 都分段取最严', () => {
  for (const tail of ['', ' 2>&1', ' 2>/dev/null', ' 2>&1 | head -5', ' > /tmp/out.json', ' >>log.txt 2>&1']) {
    const r = classifyCommand(`lark-cli im +chat-list --page-size 5${tail}`);
    assert.equal(r.class, 'read', tail);
    assert.equal(r.cmd, '+chat-list', tail);
  }
  assert.equal(classifyCommand('lark-cli im +chat-list; lark-cli api GET /x').class, 'deny');
  assert.equal(classifyCommand('lark-cli im +chat-list\nlark-cli mail +send --to a').class, 'confirm');
  assert.equal(classifyCommand('echo $(lark-cli api GET /x)').class, 'deny');
  assert.equal(classifyCommand('echo `lark-cli auth logout`').class, 'deny');
  assert.equal(classifyCommand('lark-cli im +chat-list || lark-cli im +messages-send --text x').class, 'write');
  assert.equal(classifyCommand('FOO=1 lark-cli im +messages-send --text x').class, 'write');
  assert.equal(classifyCommand('lark-cli im +messages-send --text "a | lark-cli api x"').class, 'write', '引号内的管道符不分段');
  assert.equal(classifyCommand("lark-cli im +messages-send --text 'x; lark-cli auth logout'").class, 'write');
  assert.equal(classifyCommand('bash -c "lark-cli api GET /x"').class, 'deny');
});

test('classifyCommand：--help/+help/auth status 是 read；auth login/qrcode 仅对话；auth logout deny；非 lark 命令', () => {
  for (const cmd of ['lark-cli --help', 'lark-cli im --help', 'lark-cli mail --help', 'lark-cli im +help', 'lark-cli auth status',
    'lark-cli schema docx.v1.document.raw_content']) {
    const r = classifyCommand(cmd);
    assert.equal(r.class, 'read', cmd);
    assert.deepEqual(r.profileAllowed, { chat: true, sched: true }, cmd);
  }
  for (const cmd of ['lark-cli auth login', 'lark-cli auth qrcode']) {
    const r = classifyCommand(cmd);
    assert.equal(r.class, 'chat-only', cmd);
    assert.equal(r.decision, 'allow', cmd);
    assert.deepEqual(r.profileAllowed, { chat: true, sched: false }, cmd);
  }
  assert.equal(classifyCommand('lark-cli auth logout').class, 'deny');
  // 非 lark 命令：不在策略表内，不判拒（strict 下是否放行交给 CLI 自己），只有明确禁的几个是 deny
  const echo = classifyCommand('echo hi');
  assert.equal(echo.decision, 'allow');
  assert.equal(echo.domain, null);
  for (const cmd of ['nohup codex exec "x" &', 'codex exec x', 'npx -y whiteboard-cli', 'cd /tmp && nohup node x.js']) {
    assert.equal(classifyCommand(cmd).decision, 'deny', cmd);
  }
  const segs = classifySegments('lark-cli im +chat-list | jq .');
  assert.equal(segs.length, 2);
  assert.equal(segs[0].lark, true);
  assert.equal(segs[1].lark, false);
  assert.equal(segs[1].program, 'jq');
});

test('larkRules：每个子命令三种前缀；chat 无确认级；确认轮加上；sched 只读；帮助规则两档都有', () => {
  const chat = larkRules('chat');
  const chatC = larkRules('chat', { confirm: true });
  const sched = larkRules('sched');
  for (const list of [chat, chatC, sched]) {
    assert.equal(new Set(list).size, list.length, '无重复');
    for (const r of list) assert.match(r, /^Bash\(lark-cli [^(),]+(:\*)?\)$/, r);
    assert.ok(list.includes('Bash(lark-cli --help)'));
    for (const d of ['im', 'contact', 'approval', 'calendar', 'mail', 'docs', 'sheets', 'drive', 'whiteboard', 'auth']) {
      assert.ok(list.includes(`Bash(lark-cli ${d} --help:*)`), d);
    }
    assert.ok(!list.includes('Bash(lark-cli:*)'));
    for (const e of ofClass('deny')) for (const r of rulesOf(e)) assert.ok(!list.includes(r), r);
  }
  for (const e of ofClass('read', 'write', 'chat-only')) for (const r of rulesOf(e)) assert.ok(chat.includes(r), r);
  for (const e of ofClass('confirm')) for (const r of rulesOf(e)) {
    assert.ok(!chat.includes(r), r);
    assert.ok(chatC.includes(r), r);
    assert.ok(!sched.includes(r), r);
  }
  for (const e of ofClass('read')) for (const r of rulesOf(e)) assert.ok(sched.includes(r), r);
  for (const e of ofClass('write', 'chat-only')) for (const r of rulesOf(e)) assert.ok(!sched.includes(r), r);
  assert.ok(chat.includes('Bash(lark-cli im +messages-send:*)'));
  assert.ok(chat.includes('Bash(lark-cli --as user im +messages-send:*)'));
  assert.ok(chat.includes('Bash(lark-cli --as bot im +messages-send:*)'));
  assert.ok(sched.includes('Bash(lark-cli --as user im +chat-messages-list:*)'));
});

test('larkRules：放行的前缀不会按字面前缀误覆盖更高一级的命令', () => {
  // 防「前缀规则是否按词边界」未验证：任何一条放行规则都不能是更严命令的字符串前缀
  const strictCmds = (cls) => ofClass(...cls).flatMap((e) => PREFIXES.map((p) => `lark-cli ${p}${entryText(e)}`));
  const check = (rules, stricter) => {
    for (const r of rules) {
      const p = r.replace(/^Bash\(/, '').replace(/(:\*)?\)$/, '');
      for (const c of stricter) assert.ok(!c.startsWith(p), `${r} 覆盖了 ${c}`);
    }
  };
  check(larkRules('chat'), strictCmds(['confirm', 'deny']));
  check(larkRules('chat', { confirm: true }), strictCmds(['deny']));
  check(larkRules('sched'), strictCmds(['write', 'confirm', 'chat-only', 'deny']));
});

test('safeName：只放行 ^\\+?[a-z][a-z0-9._-]{0,40}$，其余一律 <其他>', () => {
  for (const ok of ['+messages-send', 'approval', 'chat.members', 'add_sign', 'a', 'a'.repeat(41), '+help']) {
    assert.equal(safeName(ok), ok);
  }
  for (const bad of ['ZZ_SECRET_MARK', '/x', '', '中文', '+Help', '--chat-id', 'a'.repeat(42), '1abc', 'a b', 'a/b', null, undefined, 42]) {
    assert.equal(safeName(bad), '<其他>', String(bad));
  }
  // 审计名再多挡一层 ID 形状（卡片的 safeName 正则本身放得过 oc_xxx）
  for (const id of ['oc_leak42', 'ou_abc', 'om_x1', 'cli_a1b2c3', 'zz_secret_mark', 'x12345']) assert.equal(auditName(id), '<其他>', id);
  for (const e of LARK_POLICY) for (const n of [e.domain, e.cmd, e.method].filter(Boolean)) assert.equal(auditName(n), n, n);
  assert.equal(auditName('python3'), 'python3');
  assert.equal(auditName('ZZ_SECRET_MARK'), '<其他>');
});

test('detectConfirm：只认 owner 私聊、句首「确认」或 /confirm；其余原样', () => {
  assert.deepEqual(detectConfirm('确认 发吧', 'p2p', true), { confirmed: true, prompt: '发吧' });
  assert.deepEqual(detectConfirm('确认，发吧', 'p2p', true), { confirmed: true, prompt: '发吧' });
  assert.deepEqual(detectConfirm('确认', 'p2p', true), { confirmed: true, prompt: CONFIRM_DEFAULT_PROMPT });
  assert.deepEqual(detectConfirm('确认。', 'p2p', true), { confirmed: true, prompt: CONFIRM_DEFAULT_PROMPT });
  assert.deepEqual(detectConfirm('/confirm', 'p2p', true), { confirmed: true, prompt: CONFIRM_DEFAULT_PROMPT });
  assert.deepEqual(detectConfirm('/confirm 改成下午三点再发', 'p2p', true), { confirmed: true, prompt: '改成下午三点再发' });
  assert.equal(CONFIRM_DEFAULT_PROMPT, ownerText`（${O_NAME}已确认上一轮的草稿，请执行）`);
  for (const [t, ct, own] of [['确认 发吧', 'group', true], ['确认 发吧', 'topic_group', true], ['确认 发吧', 'p2p', false],
    ['确认一下进度', 'p2p', true], ['我确认', 'p2p', true], ['确认？', 'p2p', true], ['确认?', 'p2p', true],
    ['/confirmed', 'p2p', true], ['好的', 'p2p', true], ['', 'p2p', true]]) {
    const r = detectConfirm(t, ct, own);
    assert.equal(r.confirmed, false, `${t}/${ct}/${own}`);
    assert.equal(r.prompt, t, '不确认时提示词原样返回');
  }
});

test('回放 45 天用量（测 9）：读零拒绝、邮件回复要确认、写只在对话放行、两类含糊有标注、总数守恒', () => {
  const { rows, totals } = replayUsage(USAGE);
  const sum = USAGE.split('\n').map((l) => /^(\d+)\s+\S/.exec(l)?.[1]).filter(Boolean).reduce((a, n) => a + Number(n), 0);
  assert.equal(sum, 761);
  assert.equal(totals.count, 761);
  assert.equal(rows.reduce((a, r) => a + r.count, 0), 761);
  assert.equal(rows.length, 44);
  const row = (line) => rows.find((r) => r.line === line);
  const reads = rows.filter((r) => r.class === 'read');
  assert.ok(reads.length >= 19);
  for (const r of reads) assert.ok(r.chat && r.sched, `读被拒：${r.line}`);
  for (const l of ['im +chat-messages-list', 'calendar +agenda', 'contact +search-user', 'sheets +workbook-info', 'docs +fetch',
    'mail +message', 'im +messages-resources-download', 'im +messages-resource-download', 'schema docx.v1.document.raw_content',
    'im +help', 'whiteboard +export', 'drive +inspect']) {
    assert.equal(row(l)?.class, 'read', l);
  }
  assert.equal(row('mail +reply').class, 'confirm');
  assert.equal(row('mail +reply-all').class, 'confirm');
  for (const l of ['im +messages-send', 'drive +import', 'calendar +create']) {
    assert.equal(row(l).class, 'write', l);
    assert.equal(row(l).chat, true, l);
    assert.equal(row(l).sched, false, l);
  }
  assert.equal(row('auth login').class, 'chat-only');
  assert.equal(row('user im').ambiguous, 'global-flag-first');
  assert.equal(row('approval tasks').ambiguous, 'method');
  assert.equal(row('approval instances').ambiguous, 'method');
  assert.equal(row('im +chat-messages-list').ambiguous, null);
  const byClass = Object.values(totals.byClass).reduce((a, n) => a + n, 0);
  assert.equal(byClass, 761);
  const text = formatReplay({ rows, totals });
  assert.match(text, /761/);
  assert.match(text, /ambiguous:global-flag-first/);
  assert.match(text, /ambiguous:method/);
});

test('回放脚本可直接跑：node scripts/replay-tool-usage.js <usage.txt>', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'replay-tool-usage.js'), USAGE_FILE], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /im \+chat-messages-list/);
  assert.match(r.stdout, /761/);
  const bad = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'replay-tool-usage.js')], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0, '缺参数要报错退出');
});
