// collect.mjs --publish 검증 — 가짜 gh(PATH 맨 앞)와 가짜 순위판(127.0.0.1 http)만 쓴다.
// 진짜 GitHub·진짜 ~/.token-meter·클립보드는 건드리지 않는다. HOME 은 매번 임시 폴더다.
// 실행: node --test test/publish.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  sanitizeEntry, buildPayload, serializePayload, parseJsonSeq, classifyGh, redact, publish, checkMember, ghRunner, samePublished,
  joinUrl, PublishError, MAX_GIST_BYTES, MAX_MODELS, TOTAL_KEYS, GIST_FILE, GIST_DESCRIPTION, DEFAULT_SITE,
} from '../collect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'collect.mjs');
// 진짜처럼 생긴 가짜 토큰 — 어떤 출력·인자·업로드에도 나오면 안 된다
const FAKE_TOKEN = 'ghp_' + 'Q7w'.repeat(12);
const FAKE_PAT = 'github_pat_' + 'A1b2'.repeat(10);
const LOGIN = 'Tester-One';

// ── 계약: 공개 문서에 허용된 필드 ───────────────────────────────────────
const TOP_KEYS = ['app', 'entries', 'login', 'schema', 'updatedAt'];
const ENTRY_KEYS = ['byDay', 'byModel', 'estimated', 'generatedAt', 'messages', 'range', 'sessions', 'split', 'subagents', 'tool', 'totals', 'tz'];
const RANGE_KEYS = ['activeDays', 'from', 'to'];
const sorted = (o) => Object.keys(o).sort();

/** 공개 문서가 화이트리스트 모양 그대로인지 끝까지 확인한다 */
function assertWhitelisted(doc) {
  assert.deepEqual(sorted(doc), TOP_KEYS);
  assert.equal(doc.schema, 1);
  assert.equal(doc.app, 'token-meter');
  for (const e of doc.entries) {
    assert.deepEqual(sorted(e), ENTRY_KEYS);
    assert.deepEqual(sorted(e.range), RANGE_KEYS);
    assert.deepEqual(sorted(e.totals), [...TOTAL_KEYS].sort());
    for (const v of Object.values(e.byModel)) assert.deepEqual(sorted(v), [...TOTAL_KEYS].sort());
    for (const [d, v] of Object.entries(e.byDay)) {
      assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(v.length, 3);
      for (const n of v) assert.ok(Number.isFinite(n) && n >= 0);
    }
    if (e.split !== null) assert.deepEqual(sorted(e.split), ['main', 'sub']);
  }
}

// ── 가짜 gh ─────────────────────────────────────────────────────────────
// 인자와 표준 입력을 calls.jsonl 에 남기고, scenario.json 대로 GitHub 처럼 답한다.
// gist 상태는 state.json 에 두어 한 실행 안의 여러 호출이 같은 세상을 본다.
const FAKE_GH = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.FAKE_GH_DIR;
let argv = process.argv.slice(2);
// 수집기는 api 호출마다 --hostname github.com 을 붙인다 — 떼어 내고 따로 남긴다
let host = null;
if (argv[0] === 'api' && argv[1] === '--hostname') { host = argv[2]; argv = ['api', ...argv.slice(3)]; }
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({
  argv, host, stdin, ghToken: process.env.GH_TOKEN ? 'set' : null, promptDisabled: process.env.GH_PROMPT_DISABLED || null,
}) + '\n');
const sc = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
const statePath = path.join(dir, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { gists: sc.gists || {}, next: 1 };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const done = (code, out = '', err = '') => { process.stdout.write(out); process.stderr.write(err); process.exitCode = code; };
const notFound = () => done(1, '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}', 'gh: Not Found (HTTP 404)\n');
const view = (id, withContent = true) => {
  const g = state.gists[id];
  return { id, html_url: 'https://gist.github.com/' + id, public: g.public, description: g.description,
    owner: { login: g.owner }, updated_at: g.updated_at,
    files: Object.fromEntries(Object.entries(g.files).map(([n, c]) => [n, { filename: n, size: Buffer.byteLength(c),
      raw_url: 'https://gist.githubusercontent.com/' + g.owner + '/' + id + '/raw/' + n, ...(withContent ? { content: c } : {}) }])) };
};
const key = argv.join(' ');
const mine = (g) => g.owner.toLowerCase() === sc.login.toLowerCase();
const rule = (sc.fail || []).find((f) => key.startsWith(f.match));
const patch = /^api -X PATCH gists\/(\w+) --input -$/.exec(key);
const read = /^api gists\/(\w+)$/.exec(key);   // 고치기 전에 지금 내용을 읽는 GET (남의 공개 gist 도 읽힌다)
if (rule) done(rule.status ?? 1, rule.stdout || '', rule.stderr || '');
else if (key === 'api user --jq .login') done(0, sc.login + '\n');
else if (key === 'api --paginate gists?per_page=100') {
  const list = Object.keys(state.gists).filter((id) => mine(state.gists[id])).map((id) => view(id, false));
  // 옛 gh 처럼 쪽마다 배열을 따로 이어 붙여 낸다
  done(0, sc.pageSplit ? list.map((g) => JSON.stringify([g])).join('') : JSON.stringify(list));
} else if (key === 'api -X POST gists --input -') {
  const body = JSON.parse(stdin);
  const id = 'f00d' + String(state.next++).padStart(28, '0');
  state.gists[id] = { owner: sc.login, public: body.public === true, description: body.description,
    updated_at: new Date().toISOString(), files: Object.fromEntries(Object.entries(body.files).map(([n, f]) => [n, f.content])) };
  save(); done(0, JSON.stringify(view(id)));
} else if (read) {
  if (!state.gists[read[1]]) notFound();
  else done(0, JSON.stringify(view(read[1])));
} else if (patch) {
  const g = state.gists[patch[1]];
  if (!g || !mine(g)) notFound();
  else {
    const body = JSON.parse(stdin);
    for (const [n, f] of Object.entries(body.files)) g.files[n] = f.content;
    g.description = body.description; g.updated_at = new Date().toISOString();
    save(); done(0, JSON.stringify(view(patch[1])));
  }
} else done(1, '', 'fake gh: unexpected call: ' + key + '\n');
`;

// ── 가짜 순위판 (members.json) ──────────────────────────────────────────
let membersDoc = null;   // null 이면 404
const hits = [];
let server, BASE, DEAD_BASE;
// Node 20 은 맨 위 before() 를 첫 시험 전에 다 기다려 주지 않는다 — 그러면 BASE 가 비어 수집기가 진짜 Pages 로 간다.
// run() 은 이것을 기다린 뒤에 띄운다.
let serverReady;
const whenReady = new Promise((r) => { serverReady = r; });
const realHomeCache = path.join(os.homedir(), '.token-meter', 'gist.json');
const statOrNull = (p) => { try { const s = fs.statSync(p); return [s.size, s.mtimeMs]; } catch { return null; } };
const realCacheBefore = statOrNull(realHomeCache);
const repoSubmissionBefore = fs.existsSync(path.join(HERE, '..', 'submission.json'));

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/members.json') && membersDoc) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(membersDoc));
    } else { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}/`;
  // 닫힌 포트 — 순위판에 닿지 못하는 경우
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  DEAD_BASE = `http://127.0.0.1:${tmp.address().port}/`;
  await new Promise((r) => tmp.close(r));
  serverReady();
});

after(async () => {
  await new Promise((r) => server.close(r));
  // 테스트가 진짜 HOME·저장소에 아무것도 쓰지 않았다
  assert.deepEqual(statOrNull(realHomeCache), realCacheBefore, '진짜 ~/.token-meter/gist.json 이 바뀌었다');
  assert.equal(fs.existsSync(path.join(HERE, '..', 'submission.json')), repoSubmissionBefore, '저장소에 submission.json 이 생겼다');
});

// ── 임시 세상 ───────────────────────────────────────────────────────────
function listFiles(dir, base = dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listFiles(p, base));
    else out.push(path.relative(base, p));
  }
  return out.sort();
}

function writeClaude(dir, days) {
  const f = path.join(dir, '-Users-someone-SECRET-PROJECT', 'SECRET-SESSION-1111.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines = days.map((d, i) => JSON.stringify({
    type: 'assistant', sessionId: 'SECRET-SESSION-1111', cwd: '/Users/someone/SECRET-PROJECT', timestamp: `${d}T03:00:00.000Z`,
    message: { id: `msg_${i}`, model: 'claude-opus-4-8', role: 'assistant', content: [{ type: 'text', text: 'SECRET-CONVERSATION' }],
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } },
  }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
}

function writeCodex(dir, model = 'gpt-5.5') {
  const f = path.join(dir, 'sessions', '2026', '10', '13', 'rollout-2026-10-13T04-00-00-SECRET.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { id: 'SECRET-CODEX-SESSION', cwd: '/Users/someone/SECRET-CODEX' } },
    { type: 'turn_context', payload: { model, cwd: '/Users/someone/SECRET-CODEX' } },
    { timestamp: '2026-10-13T04:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 300, total_tokens: 1300 },
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 300, total_tokens: 1300 } } } },
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** 테스트 하나의 세상: 임시 HOME, 가짜 gh·pbcopy, 로그 픽스처, collect.mjs 사본(옆에 뭘 쓰는지 보려고) */
function world({ scenario = {}, cache = null, claudeDays = ['2026-10-12', '2026-10-13'], codex = true, codexModel = 'gpt-5.5', gh = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-publish-'));
  const w = {
    root, home: path.join(root, 'home'), bin: path.join(root, 'bin'), ghDir: path.join(root, 'ghdir'),
    ghConfig: path.join(root, 'ghconfig'), app: path.join(root, 'app'), cwd: path.join(root, 'cwd'),
    logs: path.join(root, 'logs'),
  };
  for (const d of [w.home, w.bin, w.ghDir, w.ghConfig, w.app, w.cwd, w.logs]) fs.mkdirSync(d, { recursive: true });
  w.script = path.join(w.app, 'collect.mjs');
  fs.copyFileSync(SRC, w.script);
  fs.writeFileSync(path.join(w.ghDir, 'fake-gh.mjs'), FAKE_GH);
  fs.writeFileSync(path.join(w.ghDir, 'scenario.json'), JSON.stringify({ login: LOGIN, ...scenario }));
  if (gh) {
    fs.writeFileSync(path.join(w.bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(w.ghDir, 'fake-gh.mjs')}" "$@"\n`, { mode: 0o755 });
  }
  // 클립보드를 쓰면 여기에 흔적이 남는다 (진짜 pbcopy 는 PATH 뒤쪽 /usr/bin 에 있다)
  fs.writeFileSync(path.join(w.bin, 'pbcopy'), `#!/bin/sh\necho called >> "${path.join(w.root, 'pbcopy-called')}"\ncat > /dev/null\n`, { mode: 0o755 });
  if (cache) {
    fs.mkdirSync(path.join(w.home, '.token-meter'), { recursive: true });
    fs.writeFileSync(path.join(w.home, '.token-meter', 'gist.json'), JSON.stringify(cache));
  }
  if (claudeDays) writeClaude(path.join(w.logs, 'claude'), claudeDays);
  if (codex) writeCodex(path.join(w.logs, 'codex'), codexModel);
  w.logArgs = ['--dir', path.join(w.logs, 'claude'), '--codex-dir', path.join(w.logs, 'codex'), '--gemini-dir', path.join(w.logs, 'gemini')];
  w.calls = () => {
    const f = path.join(w.ghDir, 'calls.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  w.state = () => JSON.parse(fs.readFileSync(path.join(w.ghDir, 'state.json'), 'utf8'));
  w.homeFiles = () => listFiles(w.home);
  w.cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return w;
}

/**
 * collect.mjs 사본을 자식 프로세스로. 환경은 처음부터 새로 짠다 — 진짜 GH_TOKEN·HOME 이 새지 않게.
 * TOKEN_METER_GH 로 가짜 gh 를 못 박는다: 수집기는 PATH 에 gh 가 없으면 /opt/homebrew/bin 등을 뒤지는데,
 * 진짜 gh 는 GH_CONFIG_DIR 이 비어 있어도 맥 키체인의 진짜 토큰을 꺼내 쓴다(직접 확인함) — 닿으면 진짜로 올라간다.
 */
async function run(w, args, extraEnv = {}) {
  await whenReady;
  const env = {
    PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home, GH_CONFIG_DIR: w.ghConfig, FAKE_GH_DIR: w.ghDir,
    TOKEN_METER_GH: path.join(w.bin, 'gh'),   // gh:false 세상에서는 없는 파일 → gh_missing
    TOKEN_METER_BASE: BASE, LANG: 'ko_KR.UTF-8', TZ: 'Asia/Seoul', ...extraEnv,
  };
  assert.ok(env.TOKEN_METER_GH.startsWith(w.root), '테스트는 가짜 gh 만 불러야 한다');
  // 순위판도 이 시험이 띄운 로컬 서버만 — 비어 있으면 수집기가 진짜 GitHub Pages 를 읽는다
  assert.match(String(env.TOKEN_METER_BASE), /^http:\/\/127\.0\.0\.1:\d+\/$/, '테스트는 가짜 순위판만 읽어야 한다');
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [w.script, ...w.logArgs, ...args], { cwd: w.cwd, env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

/** --json 은 표준 출력에 JSON 객체 정확히 하나 */
function oneJson(out) {
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `표준 출력이 한 줄이 아니다: ${out}`);
  const v = JSON.parse(lines[0]);
  assert.equal(typeof v, 'object');
  assert.ok(!Array.isArray(v));
  return v;
}

const argvOf = (calls) => calls.map((c) => c.argv.join(' '));
const uploaded = (call) => JSON.parse(JSON.parse(call.stdin).files[GIST_FILE].content);

// ── 화이트리스트 ────────────────────────────────────────────────────────
const dirtyEntry = () => ({
  v: 2, tool: 'claude', name: 'SECRET-NICK', generatedAt: '2026-10-13T05:00:00.000Z', tz: 'Asia/Seoul',
  range: { from: '2026-10-12', to: '2026-10-13', activeDays: 2, path: '/Users/someone' },
  totals: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40, total: 100, cost: 1.5, messages: 3, secret: 'x' },
  messages: 3, sessions: 1, subagents: 0, split: { main: 100, sub: 0, cwd: '/Users/someone' },
  projectCount: 7, projects: ['SECRET-PROJECT'], paths: ['/Users/someone/SECRET-PROJECT'], cwd: '/Users/someone',
  sessionIds: ['SECRET-SESSION-1111'], _stats: { files: 9, lines: 99 },
  byModel: {
    'claude-opus-4-8': { input: 10, output: 20, cacheWrite: 30, cacheRead: 40, total: 100, cost: 1.5, messages: 3, file: '/x' },
    'bad"model\nname': { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, total: 2, cost: 0, messages: 1 },
    ['x'.repeat(65)]: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, total: 2, cost: 0, messages: 1 },
  },
  byDay: { '2026-10-12': [40, 10, 0.5, 'extra'], '2026-10-13': [60, 10, 1], '/Users/someone': [1, 1, 1], '2026-10-14': 'nope' },
  estimated: false,
});

test('화이트리스트: name·projectCount·projects·_stats·paths 등은 정확히 허용 필드로 깎인다', () => {
  const s = sanitizeEntry(dirtyEntry());
  assert.deepEqual(sorted(s), ENTRY_KEYS);
  assert.deepEqual(sorted(s.range), RANGE_KEYS);
  assert.deepEqual(sorted(s.totals), [...TOTAL_KEYS].sort());
  assert.deepEqual(s.split, { main: 100, sub: 0 });
  assert.deepEqual(s.byDay, { '2026-10-12': [40, 10, 0.5], '2026-10-13': [60, 10, 1] });
  assert.deepEqual(s.range, { from: '2026-10-12', to: '2026-10-13', activeDays: 2 });
  // 이상한 모델 이름은 "(other)" 로 합쳐진다
  assert.deepEqual(Object.keys(s.byModel), ['claude-opus-4-8', '(other)']);
  assert.equal(s.byModel['(other)'].total, 4);
  const text = JSON.stringify(s);
  for (const bad of ['SECRET', 'someone', 'projectCount', '_stats', '"name"', '"paths"', '"cwd"', '"v"', 'secret', '"file"']) {
    assert.ok(!text.includes(bad), `공개 내용에 ${bad} 가 남았다`);
  }
});

test('화이트리스트: 음수·NaN·Infinity·문자열 숫자는 0, 도구 이름이 이상하면 버린다', () => {
  const e = dirtyEntry();
  e.totals = { input: -5, output: NaN, cacheWrite: Infinity, cacheRead: '40', total: 1, cost: -0.1, messages: null };
  e.sessions = -1; e.estimated = 'yes'; e.tz = '../../etc'; e.generatedAt = 'not a date';
  const s = sanitizeEntry(e);
  assert.deepEqual(s.totals, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 1, cost: 0, messages: 0 });
  assert.equal(s.sessions, 0);
  assert.equal(s.estimated, false);
  assert.equal(s.tz, 'UTC');
  assert.ok(!Number.isNaN(Date.parse(s.generatedAt)));
  assert.equal(sanitizeEntry({ ...dirtyEntry(), tool: 'cursor' }), null);
  assert.equal(sanitizeEntry(null), null);
  // "__proto__" 모델 이름은 순위판(board.mjs)이 기록 전체를 거절하는 이름이다 → "(other)" 로, 원형도 그대로
  const p = sanitizeEntry({ ...dirtyEntry(), byModel: JSON.parse('{"__proto__":{"total":5}}') });
  assert.equal(Object.getPrototypeOf(p.byModel), Object.prototype);
  assert.deepEqual(Object.keys(p.byModel), ['(other)']);
  assert.equal(p.byModel['(other)'].total, 5);
  assert.ok(!serializePayload(buildPayload([{ ...dirtyEntry(), byModel: JSON.parse('{"__proto__":{"total":5}}') }], LOGIN)).includes('__proto__'));
});

test('화이트리스트: 경로·메일 주소처럼 생긴 모델 이름은 "(other)" 로 (흔한 이름은 그대로)', () => {
  const z = { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, total: 2, cost: 0, messages: 1 };
  const leaky = ['/Users/someone/models/qwen2.5-coder.gguf', './models/mine.gguf', 'Users/someone/models/x',
    'home/someone/llama', 'C:/Users/someone/m.gguf', 'models//x', 'a/b/c/d', 'someone.lastname@company.com', 'x@mail.co.kr'];
  const fine = ['claude-opus-4-8', 'gpt-5.5', 'gemini-2.5-pro', 'meta-llama/Llama-3.1-8B-Instruct', 'openrouter/anthropic/claude-sonnet-4',
    'qwen2.5-coder:7b', 'claude-3-5-sonnet-v2@20241022', '(unknown)', '(gemini)'];
  const byModel = Object.fromEntries([...leaky, ...fine].map((n) => [n, z]));
  const s = sanitizeEntry({ ...dirtyEntry(), tool: 'codex', byModel });
  assert.deepEqual(Object.keys(s.byModel).sort(), [...fine, '(other)'].sort());
  assert.equal(s.byModel['(other)'].messages, leaky.length);
  const text = serializePayload(buildPayload([s], LOGIN));
  for (const bad of ['someone', 'Users', 'home/', 'gguf', 'company', 'mail.co']) assert.ok(!text.includes(bad), `공개 내용에 ${bad} 가 남았다`);
});

test('화이트리스트: 모델이 100개를 넘으면 작은 것부터 "(other)" 로 합친다 (순위판이 거절하지 않게)', () => {
  const byModel = {};
  for (let i = 0; i < 150; i++) byModel[`m-${i}`] = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: i + 1, cost: 0, messages: 1 };
  byModel['(other)'] = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 1000, cost: 0, messages: 1 };
  const s = sanitizeEntry({ ...dirtyEntry(), byModel });
  const names = Object.keys(s.byModel);
  assert.equal(names.length, MAX_MODELS);
  assert.ok(names.includes('m-149') && !names.includes('m-0'));
  const sum = (o) => Object.values(o).reduce((a, v) => a + v.total, 0);
  assert.equal(sum(s.byModel), sum(byModel));   // 합은 그대로
  assert.equal(s.byModel['(other)'].messages, 152 - MAX_MODELS);
});

test('buildPayload: 정해진 최상위 필드만, 도구마다 하나, claude→codex→gemini 순', () => {
  const now = new Date('2026-10-14T00:00:00.000Z');
  const codex = { ...dirtyEntry(), tool: 'codex', split: null };
  const older = { ...dirtyEntry(), totals: { ...dirtyEntry().totals, total: 1 } };
  const doc = buildPayload([codex, older, dirtyEntry(), { tool: 'cursor' }], LOGIN, now);
  assertWhitelisted(doc);
  assert.equal(doc.login, LOGIN);
  assert.equal(doc.updatedAt, now.toISOString());
  assert.deepEqual(doc.entries.map((e) => e.tool), ['claude', 'codex']);
  assert.equal(doc.entries[0].totals.total, 100);   // 같은 도구는 뒤에 온 것
  assert.equal(doc.entries[1].split, null);
  assertWhitelisted(buildPayload(dirtyEntry(), LOGIN, now));   // 하나만 넘겨도
});

test('serializePayload: 되읽으면 같고, 날짜 배열은 한 줄, 256KB 상한', () => {
  const doc = buildPayload([dirtyEntry()], LOGIN);
  const s = serializePayload(doc);
  assert.deepEqual(JSON.parse(s), doc);
  assert.ok(s.includes('"2026-10-12": [40,10,0.5]'), s);

  // 날짜가 많아 줄 나눈 꼴은 넘지만 접은 꼴은 안 넘는 경우 → 접은 꼴로
  const many = (n) => {
    const byDay = {};
    for (let i = 0; i < n; i++) byDay[`${1000 + Math.floor(i / 336)}-${String(1 + Math.floor((i % 336) / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`] = [123456, 7890, 12.34];
    return buildPayload([{ ...dirtyEntry(), byDay }], LOGIN);
  };
  const mid = many(7300);
  const prettyLen = Buffer.byteLength(JSON.stringify(mid, null, 1).replace(/\[\n\s*(-?[\d.eE+-]+(?:,\n\s*-?[\d.eE+-]+)*)\n\s*\]/g, (_, x) => '[' + x.replace(/\s+/g, '') + ']'));
  const compactLen = Buffer.byteLength(JSON.stringify(mid));
  assert.ok(prettyLen > MAX_GIST_BYTES && compactLen <= MAX_GIST_BYTES, `전제가 틀렸다: ${prettyLen} / ${compactLen}`);
  assert.equal(serializePayload(mid), JSON.stringify(mid));

  assert.throws(() => serializePayload(many(12000)), (e) => e instanceof PublishError && e.code === 'gist_too_large' && /256KB/.test(e.ko));
});

test('parseJsonSeq: 한 덩어리·이어 붙은 쪽·문자열 안의 괄호', () => {
  assert.deepEqual(parseJsonSeq('[1,2]'), [[1, 2]]);
  assert.deepEqual(parseJsonSeq('[{"a":"]["}][{"b":"}{\\"}"}]\n'), [[{ a: '][' }], [{ b: '}{"}' }]]);
  assert.deepEqual(parseJsonSeq(' [1]\n[2] [3]').flat(), [1, 2, 3]);
  assert.throws(() => parseJsonSeq('[1,'));
});

test('classifyGh: gh 실패를 계약된 오류 코드로', () => {
  const r = (status, stderr, error = null) => ({ status, stdout: '', stderr, error });
  assert.equal(classifyGh(r(null, '', 'ENOENT')), 'gh_missing');
  assert.equal(classifyGh(r(4, 'To get started with GitHub CLI, please run:  gh auth login\n')), 'gh_not_logged_in');
  assert.equal(classifyGh(r(1, 'gh: Bad credentials (HTTP 401)\n')), 'gh_not_logged_in');
  assert.equal(classifyGh(r(1, 'gh: Not Found (HTTP 404)\ngh: This API operation needs the "gist" scope. To request it, run:  gh auth refresh -h github.com -s gist\n')), 'gh_no_gist_scope');
  assert.equal(classifyGh(r(1, 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n')), 'network');
  assert.equal(classifyGh(r(1, 'Post "https://api.github.com/gists": dial tcp: lookup api.github.com: no such host\n')), 'network');
  assert.equal(classifyGh(r(null, '', 'ETIMEDOUT')), 'network');
  assert.equal(classifyGh(r(1, 'gh: Server Error (HTTP 502)\n')), 'network');
  // 쓰기에서 인증은 됐는데 404/403 = gist 권한 없음, 읽기라면 모름
  assert.equal(classifyGh(r(1, 'gh: Not Found (HTTP 404)\n'), { write: true }), 'gh_no_gist_scope');
  assert.equal(classifyGh(r(1, 'gh: Not Found (HTTP 404)\n')), 'unknown');
  assert.equal(classifyGh(r(1, 'gh: API rate limit exceeded (HTTP 403)\n'), { write: true }), 'unknown');
  assert.equal(classifyGh(r(1, 'gh: Validation Failed (HTTP 422)\n'), { write: true }), 'unknown');
});

test('redact: 토큰처럼 생긴 것과 Authorization 값은 가린다', () => {
  const s = redact(`x ${FAKE_TOKEN} y Authorization: token ${FAKE_PAT} z authorization=Bearer abc.def`);
  assert.ok(!s.includes(FAKE_TOKEN) && !s.includes(FAKE_PAT) && !s.includes('abc.def'), s);
  const e = new PublishError('unknown', { detail: `boom ${FAKE_TOKEN}` });
  assert.ok(!e.ko.includes(FAKE_TOKEN) && !e.en.includes(FAKE_TOKEN) && !e.message.includes(FAKE_TOKEN));
});

// ── gh 찾기·호스트 ──────────────────────────────────────────────────────
test('ghRunner: PATH 에 gh 가 없으면(앱이 launchd PATH 로 띄운 경우) 흔한 설치 위치에서 찾는다', () => {
  const w = world();
  try {
    const env = { PATH: '/usr/bin:/bin', FAKE_GH_DIR: w.ghDir, HOME: w.home };
    // 진짜 /opt/homebrew/bin 대신 가짜 gh 가 있는 폴더만 뒤지게 한다
    const gh = ghRunner({ env, fallbackDirs: [path.join(w.root, 'nowhere'), w.bin] });
    const r = gh(['api', 'user', '--jq', '.login']);
    assert.deepEqual([r.status, r.stdout.trim(), r.error], [0, LOGIN, null]);
    gh(['api', 'user', '--jq', '.login']);   // 두 번째도 같은 gh
    assert.equal(w.calls().length, 2);
    // 어디에도 없으면 ENOENT → gh_missing
    const none = ghRunner({ env, fallbackDirs: [path.join(w.root, 'nowhere')] })(['api', 'user']);
    assert.equal(none.error, 'ENOENT');
    assert.equal(classifyGh(none), 'gh_missing');
    // bin 을 못 박으면 그것만 쓴다(없어도 다른 데를 뒤지지 않는다)
    const pinned = ghRunner({ env, bin: path.join(w.root, 'nowhere', 'gh'), fallbackDirs: [w.bin] })(['api', 'user']);
    assert.equal(pinned.error, 'ENOENT');
    assert.equal(w.calls().length, 2);
  } finally { w.cleanup(); }
});

test('ghRunner: api 호출은 GH_HOST 와 상관없이 늘 github.com 으로 (회사 GHE 에 공개 gist 가 생기지 않게)', () => {
  const w = world();
  try {
    const gh = ghRunner({ env: { PATH: '/usr/bin:/bin', FAKE_GH_DIR: w.ghDir, GH_HOST: 'ghe.example.invalid' }, bin: path.join(w.bin, 'gh') });
    gh(['api', 'user', '--jq', '.login']);
    gh(['api', '-X', 'POST', 'gists', '--input', '-'], JSON.stringify({ public: true, description: 'd', files: { [GIST_FILE]: { content: '{}' } } }));
    assert.deepEqual(w.calls().map((c) => [c.host, c.argv.join(' ')]),
      [['github.com', 'api user --jq .login'], ['github.com', 'api -X POST gists --input -']]);
  } finally { w.cleanup(); }
});

test('joinUrl 은 계약대로', () => {
  assert.equal(joinUrl('abc123'), 'https://github.com/Min-heee/token-meter/issues/new?template=join.yml&title=join&gist=abc123');
  assert.equal(DEFAULT_SITE, 'https://min-heee.github.io/token-meter/');
});

// ── 참가 여부 (가짜 fetch) ──────────────────────────────────────────────
test('checkMember: 로그인 대소문자 무시·gist 까지 같아야 true, 못 읽으면 null', async () => {
  const seen = [];
  const fakeFetch = (doc, status = 200) => async (url) => {
    seen.push(String(url));
    return { ok: status === 200, status, json: async () => doc };
  };
  const members = { schema: 1, members: [{ login: 'tester-one', gist: 'g1', joinedAt: '2026-10-01T00:00:00Z' }] };
  assert.equal(await checkMember({ fetch: fakeFetch(members), site: 'https://example.test/tm', login: LOGIN, gist: 'g1' }), true);
  assert.match(seen[0], /^https:\/\/example\.test\/tm\/members\.json\?t=\d+$/);   // 캐시를 피하는 쿼리
  assert.equal(await checkMember({ fetch: fakeFetch(members), site: DEFAULT_SITE, login: LOGIN, gist: 'other' }), false);
  assert.equal(await checkMember({ fetch: fakeFetch({ schema: 1, members: [] }), login: LOGIN, gist: 'g1' }), false);
  assert.equal(await checkMember({ fetch: fakeFetch(null, 404), login: LOGIN, gist: 'g1' }), null);
  assert.equal(await checkMember({ fetch: fakeFetch({ nope: 1 }), login: LOGIN, gist: 'g1' }), null);
  assert.equal(await checkMember({ fetch: async () => { throw new TypeError('fetch failed'); }, login: LOGIN, gist: 'g1' }), null);
});

test('publish(): 주입한 가짜 gh·fetch·home 만 쓴다 (쪽이 나뉜 목록에서 내 공개 gist 찾기)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-publish-home-'));
  try {
    const calls = [];
    const listed = [
      [{ id: 'secret1', public: false, owner: { login: LOGIN }, files: { [GIST_FILE]: {} }, updated_at: '2026-10-13T00:00:00Z' }],
      [{ id: 'other1', public: true, owner: { login: LOGIN }, files: { 'notes.md': {} }, updated_at: '2026-10-13T00:00:00Z' }],
      [{ id: 'old1', public: true, owner: { login: LOGIN }, files: { [GIST_FILE]: {} }, updated_at: '2026-01-01T00:00:00Z' },
       { id: 'new1', public: true, owner: { login: LOGIN }, files: { [GIST_FILE]: {} }, updated_at: '2026-10-01T00:00:00Z' }],
    ];
    const gh = (args, input) => {
      calls.push({ args, input });
      const k = args.join(' ');
      if (k === 'api user --jq .login') return { status: 0, stdout: LOGIN + '\n', stderr: '', error: null };
      if (k === 'api --paginate gists?per_page=100') return { status: 0, stdout: listed.map((p) => JSON.stringify(p)).join(''), stderr: '', error: null };
      if (k === 'api -X PATCH gists/new1 --input -') return { status: 0, stdout: JSON.stringify({ id: 'new1', html_url: 'https://gist.github.com/new1' }), stderr: '', error: null };
      return { status: 1, stdout: '', stderr: 'unexpected ' + k, error: null };
    };
    const r = await publish({ entries: [dirtyEntry()], gh, fetch: async () => { throw new Error('offline'); }, home, now: new Date('2026-10-14T00:00:00Z') });
    assert.deepEqual({ ...r }, { ok: true, login: LOGIN, gist: 'new1', url: 'https://gist.github.com/new1', member: null, joinUrl: joinUrl('new1'), created: false });
    // 고치기 전에 지금 내용을 읽는다 — 못 읽으면(여기서는 모르는 호출 → 실패) 그냥 고친다
    assert.deepEqual(calls.map((c) => c.args.join(' ')), ['api user --jq .login', 'api --paginate gists?per_page=100', 'api gists/new1', 'api -X PATCH gists/new1 --input -']);
    const body = JSON.parse(calls[3].input);
    assert.deepEqual(sorted(body), ['description', 'files']);   // 고칠 때는 public 을 보내지 않는다
    assertWhitelisted(JSON.parse(body.files[GIST_FILE].content));
    assert.deepEqual(listFiles(home), ['.token-meter/gist.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.token-meter', 'gist.json'), 'utf8')),
      { login: LOGIN, gist: 'new1', updatedAt: '2026-10-14T00:00:00.000Z' });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── 끝에서 끝까지: 자식 프로세스 + 가짜 gh ─────────────────────────────
test('처음 올리기: gist 를 새로 만들고(public), 숫자만 올리고, id 를 HOME 에만 기억한다', async () => {
  const w = world();
  try {
    membersDoc = { schema: 1, members: [] };
    const res = await run(w, ['--publish', '--json', '--name', 'SECRET-NICK', '--projects'], { GH_TOKEN: FAKE_TOKEN });
    assert.equal(res.code, 0, res.err);
    const j = oneJson(res.out);
    assert.deepEqual(sorted(j), ['gist', 'joinUrl', 'login', 'member', 'ok', 'url']);
    assert.equal(j.ok, true);
    assert.equal(j.login, LOGIN);
    assert.match(j.gist, /^f00d0+1$/);
    assert.equal(j.url, `https://gist.github.com/${j.gist}`);
    assert.equal(j.member, false);
    assert.equal(j.joinUrl, `https://github.com/Min-heee/token-meter/issues/new?template=join.yml&title=join&gist=${j.gist}`);

    const calls = w.calls();
    assert.deepEqual(argvOf(calls), ['api user --jq .login', 'api --paginate gists?per_page=100', 'api -X POST gists --input -']);
    const body = JSON.parse(calls[2].stdin);
    assert.equal(body.public, true);
    assert.equal(body.description, GIST_DESCRIPTION);
    assert.deepEqual(Object.keys(body.files), [GIST_FILE]);
    const doc = uploaded(calls[2]);
    assertWhitelisted(doc);
    assert.equal(doc.login, LOGIN);
    assert.deepEqual(doc.entries.map((e) => e.tool), ['claude', 'codex']);
    assert.equal(doc.entries[0].totals.total, 2 * (100 + 50 + 200 + 1000));
    assert.deepEqual(doc.entries[0].byDay['2026-10-13'].slice(0, 2), [1350, 50]);
    for (const bad of ['SECRET', 'someone', 'projectCount', 'projects', '_stats', '"name"', 'cwd']) {
      assert.ok(!calls[2].stdin.includes(bad), `업로드에 ${bad} 가 들어갔다`);
    }
    // gh 에는 사용자 환경(GH_TOKEN)이 그대로 가고, 묻는 창은 꺼진다. 호스트는 늘 github.com
    assert.ok(calls.every((c) => c.ghToken === 'set' && c.promptDisabled === '1'));
    assert.ok(calls.every((c) => c.host === 'github.com'), JSON.stringify(calls.map((c) => c.host)));

    // 쓴 곳: HOME/.token-meter/gist.json 하나뿐. 스크립트 옆·작업 폴더·클립보드는 그대로
    assert.deepEqual(w.homeFiles(), ['.token-meter/gist.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.home, '.token-meter', 'gist.json'), 'utf8')).gist, j.gist);
    assert.deepEqual(listFiles(w.app), ['collect.mjs']);
    assert.deepEqual(listFiles(w.cwd), []);
    assert.ok(!fs.existsSync(path.join(w.root, 'pbcopy-called')));
    assert.ok(hits.some((u) => /^\/members\.json\?t=\d+$/.test(u)));

    const all = res.out + res.err + JSON.stringify(calls);
    assert.ok(!all.includes(FAKE_TOKEN), '토큰이 출력이나 gh 인자·입력에 나왔다');
  } finally { w.cleanup(); }
});

test('Codex 모델 이름이 로컬 파일 경로여도 경로는 올라가지 않는다', async () => {
  const w = world({ codexModel: '/Users/someone/models/qwen2.5-coder-32b.gguf' });
  try {
    const res = await run(w, ['--publish', '--json']);
    assert.equal(res.code, 0, res.err);
    const post = w.calls().find((c) => c.argv.includes('POST'));
    const codex = uploaded(post).entries.find((e) => e.tool === 'codex');
    assert.deepEqual(Object.keys(codex.byModel), ['(other)']);
    assert.equal(codex.byModel['(other)'].total, 1300);
    for (const bad of ['someone', 'Users', 'gguf']) assert.ok(!post.stdin.includes(bad), `업로드에 ${bad} 가 들어갔다`);
  } finally { w.cleanup(); }
});

test('올린 내용은 순위판(board.mjs)과 참가 검사(join-core.mjs)를 그대로 통과한다', async (t) => {
  // 두 파일은 다른 담당이 고친다 — 아직 없거나 꼴이 다르면 이 대조만 건너뛴다
  let board, join;
  try {
    board = await import('../docs/board.mjs');
    join = await import('../scripts/join-core.mjs');
  } catch { return t.skip('board.mjs / join-core.mjs 를 불러오지 못함'); }
  if (typeof board.validatePayload !== 'function' || typeof join.checkContent !== 'function') return t.skip('검사 함수가 없음');
  const weird = {
    ...dirtyEntry(), tool: 'codex', split: null,
    byModel: { ...JSON.parse('{"__proto__":{"total":5}}'), '/Users/someone/m.gguf': { total: 1 }, 'gpt-5.5': { total: 9, cost: 0.12 } },
  };
  const gemini = { ...dirtyEntry(), tool: 'gemini', tz: undefined, generatedAt: undefined };
  const text = serializePayload(buildPayload([dirtyEntry(), weird, gemini], LOGIN));
  const v = board.validatePayload(JSON.parse(text), { login: LOGIN.toLowerCase() });
  assert.deepEqual(v.entries.map((e) => e.tool), ['claude', 'codex', 'gemini']);
  assert.deepEqual(join.checkContent(text, LOGIN.toUpperCase()), { ok: true });
});

test('기억한 gist 가 있으면 목록을 뒤지지 않고 바로 고친다 (참가 중이면 member: true)', async () => {
  const id = 'abc0000000000000000000000000cafe';
  const w = world({
    cache: { login: LOGIN.toLowerCase(), gist: id },   // 로그인 대소문자는 무시
    scenario: { gists: { [id]: { owner: LOGIN, public: true, description: GIST_DESCRIPTION, updated_at: '2026-10-01T00:00:00Z', files: { [GIST_FILE]: '{}' } } } },
  });
  try {
    membersDoc = { schema: 1, members: [{ login: 'TESTER-ONE', gist: id, joinedAt: '2026-10-01T00:00:00Z' }] };
    const res = await run(w, ['--publish', '--json']);
    assert.equal(res.code, 0, res.err);
    const j = oneJson(res.out);
    assert.equal(j.gist, id);
    assert.equal(j.member, true);
    assert.deepEqual(argvOf(w.calls()), ['api user --jq .login', `api gists/${id}`, `api -X PATCH gists/${id} --input -`]);
    const body = JSON.parse(w.calls()[2].stdin);
    assert.equal(body.public, undefined);
    assertWhitelisted(JSON.parse(w.state().gists[id].files[GIST_FILE]));
  } finally { w.cleanup(); }
});

test('기억이 없으면 내 gist 목록에서 token-meter.json 이 든 공개 gist 를 찾아 고친다', async () => {
  const mineId = '1111111111111111111111111111aaaa';
  const gists = {
    [mineId]: { owner: LOGIN, public: true, description: GIST_DESCRIPTION, updated_at: '2026-10-01T00:00:00Z', files: { [GIST_FILE]: '{}' } },
    '2222222222222222222222222222bbbb': { owner: LOGIN, public: false, description: 'secret', updated_at: '2026-10-10T00:00:00Z', files: { [GIST_FILE]: '{}' } },
    '3333333333333333333333333333cccc': { owner: LOGIN, public: true, description: 'notes', updated_at: '2026-10-11T00:00:00Z', files: { 'notes.md': 'hi' } },
    '4444444444444444444444444444dddd': { owner: 'someone-else', public: true, description: GIST_DESCRIPTION, updated_at: '2026-10-12T00:00:00Z', files: { [GIST_FILE]: '{}' } },
  };
  const w = world({ scenario: { gists, pageSplit: true } });
  try {
    membersDoc = null;   // 순위판이 아직 배포 전(404) → 모름
    const res = await run(w, ['--publish', '--json']);
    assert.equal(res.code, 0, res.err);
    const j = oneJson(res.out);
    assert.equal(j.gist, mineId);
    assert.equal(j.member, null);
    assert.deepEqual(argvOf(w.calls()), ['api user --jq .login', 'api --paginate gists?per_page=100', `api gists/${mineId}`, `api -X PATCH gists/${mineId} --input -`]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.home, '.token-meter', 'gist.json'), 'utf8')).gist, mineId);
  } finally { w.cleanup(); }
});

test('기억한 gist 가 지워졌으면(404) 목록을 다시 뒤지고, 없으면 새로 만든다', async () => {
  const stale = 'dead000000000000000000000000beef';
  const w = world({ cache: { login: LOGIN, gist: stale } });
  try {
    membersDoc = { schema: 1, members: [{ login: LOGIN, gist: stale, joinedAt: '2026-10-01T00:00:00Z' }] };
    const res = await run(w, ['--publish', '--json']);
    assert.equal(res.code, 0, res.err);
    const j = oneJson(res.out);
    assert.notEqual(j.gist, stale);
    assert.equal(j.member, false);   // 순위판은 옛 gist 를 들고 있다 → 다시 참가해야 한다
    assert.deepEqual(argvOf(w.calls()), ['api user --jq .login', `api gists/${stale}`, `api -X PATCH gists/${stale} --input -`,
      'api --paginate gists?per_page=100', 'api -X POST gists --input -']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.home, '.token-meter', 'gist.json'), 'utf8')).gist, j.gist);
  } finally { w.cleanup(); }
});

test('기억한 gist 가 지워졌고 다른 gist 가 목록에 있으면 그걸 고친다', async () => {
  const stale = 'dead000000000000000000000000beef', other = '5555555555555555555555555555eeee';
  const w = world({
    cache: { login: LOGIN, gist: stale },
    scenario: { gists: { [other]: { owner: LOGIN, public: true, description: GIST_DESCRIPTION, updated_at: '2026-10-01T00:00:00Z', files: { [GIST_FILE]: '{}' } } } },
  });
  try {
    const res = await run(w, ['--publish', '--json']);
    assert.equal(res.code, 0, res.err);
    assert.equal(oneJson(res.out).gist, other);
    assert.deepEqual(argvOf(w.calls()), ['api user --jq .login', `api gists/${stale}`, `api -X PATCH gists/${stale} --input -`,
      'api --paginate gists?per_page=100', `api gists/${other}`, `api -X PATCH gists/${other} --input -`]);
  } finally { w.cleanup(); }
});

test('다른 계정으로 기억된 gist 는 쓰지 않는다 (gh 계정을 바꾼 경우)', async () => {
  const theirs = '6666666666666666666666666666ffff';
  const w = world({ cache: { login: 'old-account', gist: theirs } });
  try {
    const res = await run(w, ['--publish', '--json']);
    assert.equal(res.code, 0, res.err);
    assert.deepEqual(argvOf(w.calls()), ['api user --jq .login', 'api --paginate gists?per_page=100', 'api -X POST gists --input -']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.home, '.token-meter', 'gist.json'), 'utf8')).login, LOGIN);
  } finally { w.cleanup(); }
});

// ── 실패: 오류 코드와 종료 상태 ─────────────────────────────────────────
async function expectError(w, code, extraEnv = {}) {
  const res = await run(w, ['--publish', '--json'], extraEnv);
  assert.equal(res.code, 1, `종료 상태 1 이어야 한다: ${res.out} ${res.err}`);
  const j = oneJson(res.out);
  assert.deepEqual(sorted(j), ['error', 'ok']);
  assert.equal(j.ok, false);
  assert.deepEqual(sorted(j.error), ['code', 'message']);
  assert.equal(j.error.code, code);
  assert.ok(j.error.message.length > 0);
  return { res, j };
}
const noWrites = (w) => assert.ok(!argvOf(w.calls()).some((a) => a.includes('POST') || a.includes('PATCH')), 'gist 를 건드리면 안 된다');

test('gh 가 없으면 gh_missing (설치 안내), 사람용 출력도 종료 상태 1', async () => {
  const w = world({ gh: false });
  try {
    const { j } = await expectError(w, 'gh_missing');
    assert.match(j.error.message, /brew install gh/);
    assert.deepEqual(w.homeFiles(), []);
    const human = await run(w, ['--publish']);
    assert.equal(human.code, 1);
    assert.match(human.err, /brew install gh/);
  } finally { w.cleanup(); }
});

test('gh 로그인이 안 돼 있으면 gh_not_logged_in', async () => {
  const w = world({ scenario: { fail: [{ match: 'api user', status: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n' }] } });
  try {
    const { j } = await expectError(w, 'gh_not_logged_in');
    assert.match(j.error.message, /gh auth login/);
    noWrites(w);
    assert.deepEqual(w.homeFiles(), []);
  } finally { w.cleanup(); }
});

test('gist 권한이 없으면 gh_no_gist_scope — gh 가 알려 주는 경우', async () => {
  const w = world({ scenario: { fail: [{ match: 'api -X POST gists', status: 1,
    stdout: '{"message":"Not Found","status":"404"}',
    stderr: 'gh: Not Found (HTTP 404)\ngh: This API operation needs the "gist" scope. To request it, run:  gh auth refresh -h github.com -s gist\n' }] } });
  try {
    const { j } = await expectError(w, 'gh_no_gist_scope');
    assert.match(j.error.message, /gh auth refresh -s gist/);
    assert.deepEqual(w.homeFiles(), []);   // 실패하면 기억도 안 남긴다
  } finally { w.cleanup(); }
});

test('gist 권한이 없으면 gh_no_gist_scope — 있는 gist 인데 고치기가 404', async () => {
  const id = '7777777777777777777777777777abcd';
  const w = world({
    cache: { login: LOGIN, gist: id },
    scenario: {
      gists: { [id]: { owner: LOGIN, public: true, description: GIST_DESCRIPTION, updated_at: '2026-10-01T00:00:00Z', files: { [GIST_FILE]: '{}' } } },
      fail: [{ match: 'api -X PATCH', status: 1, stderr: 'gh: Not Found (HTTP 404)\n' }],
    },
  });
  try {
    await expectError(w, 'gh_no_gist_scope');
    // 처음 404 는 "지워졌나" 로 보고 다시 찾지만, 찾은 gist 도 404 면 권한 문제다
    // 같은 gist 는 한 번만 읽는다
    assert.deepEqual(argvOf(w.calls()), ['api user --jq .login', `api gists/${id}`, `api -X PATCH gists/${id} --input -`,
      'api --paginate gists?per_page=100', `api -X PATCH gists/${id} --input -`]);
  } finally { w.cleanup(); }
});

test('GitHub 에 닿지 못하면 network', async () => {
  const w = world({ scenario: { fail: [{ match: 'api user', status: 1, stderr: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n' }] } });
  try {
    await expectError(w, 'network');
    noWrites(w);
  } finally { w.cleanup(); }
});

test('순위판(members.json)에 닿지 못해도 공개는 성공, member: null', async () => {
  const w = world();
  try {
    const res = await run(w, ['--publish', '--json'], { TOKEN_METER_BASE: DEAD_BASE });
    assert.equal(res.code, 0, res.err);
    const j = oneJson(res.out);
    assert.equal(j.ok, true);
    assert.equal(j.member, null);
  } finally { w.cleanup(); }
});

test('256KB 를 넘으면 gist_too_large, gist 는 건드리지 않는다', async () => {
  // 1990-01-01 부터 12000일 — 날짜별 배열만으로 상한을 넘긴다
  const days = Array.from({ length: 12000 }, (_, i) => new Date(Date.UTC(1990, 0, 1 + i)).toISOString().slice(0, 10));
  const w = world({ claudeDays: days, codex: false });
  try {
    const { j } = await expectError(w, 'gist_too_large');
    assert.match(j.error.message, /256KB/);
    noWrites(w);
    assert.deepEqual(w.homeFiles(), []);
  } finally { w.cleanup(); }
});

test('gh 오류 문구에 토큰이 섞여도 출력에는 절대 나오지 않는다', async () => {
  const w = world({ scenario: { fail: [{ match: 'api user', status: 1,
    stderr: `gh: weird failure Authorization: token ${FAKE_TOKEN}\nsecond ${FAKE_PAT} line ${FAKE_TOKEN}\n` }] } });
  try {
    const { res, j } = await expectError(w, 'unknown', { GH_TOKEN: FAKE_TOKEN });
    assert.match(j.error.message, /second \*\*\* line \*\*\*/);
    const human = await run(w, ['--publish'], { GH_TOKEN: FAKE_TOKEN, LANG: 'en_US.UTF-8' });
    assert.equal(human.code, 1);
    for (const s of [res.out, res.err, human.out, human.err]) {
      assert.ok(!s.includes(FAKE_TOKEN) && !s.includes(FAKE_PAT), `토큰이 출력에 나왔다: ${s}`);
    }
    assert.ok(!JSON.stringify(w.calls().map((c) => [c.argv, c.stdin])).includes(FAKE_TOKEN));
  } finally { w.cleanup(); }
});

test('gist 응답을 해석하지 못하면 unknown, id 를 기억하지 않는다', async () => {
  const w = world({ scenario: { fail: [{ match: 'api -X POST gists', status: 0, stdout: '<html>oops</html>' }] } });
  try {
    await expectError(w, 'unknown');
    assert.deepEqual(w.homeFiles(), []);
  } finally { w.cleanup(); }
});

test('--tool 로 일부만 올리면 경고하고, 그 도구만 올라간다', async () => {
  const w = world();
  try {
    const res = await run(w, ['--publish', '--tool', 'claude']);
    assert.equal(res.code, 0, res.err);
    assert.match(res.err, /그 부분만 올라갑니다/);
    const post = w.calls().find((c) => c.argv.includes('POST'));
    assert.deepEqual(uploaded(post).entries.map((e) => e.tool), ['claude']);
    const bad = await run(w, ['--publish', '--json', '--tool', 'cursor']);
    assert.equal(bad.code, 1);
    assert.equal(oneJson(bad.out).error.code, 'unknown');
  } finally { w.cleanup(); }
});

test('로그가 하나도 없으면 --json 도 ok:false 한 줄 + 종료 상태 1', async () => {
  const w = world({ claudeDays: null, codex: false });
  try {
    const { j } = await expectError(w, 'unknown');
    assert.match(j.error.message, /로그를 못 찾았습니다/);
    assert.deepEqual(w.calls(), []);
  } finally { w.cleanup(); }
});

// ── 올리지 않는 모드 ────────────────────────────────────────────────────
test('--json-only: 수집 결과 JSON 만, gh·클립보드·파일은 건드리지 않는다', async () => {
  const w = world();
  try {
    const res = await run(w, ['--json-only']);
    assert.equal(res.code, 0, res.err);
    const lines = res.out.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const v = JSON.parse(lines[0]);
    assert.deepEqual(v.map((e) => e.tool), ['claude', 'codex']);
    assert.equal(v[0].totals.total, 2700);
    assert.deepEqual(w.calls(), []);
    assert.ok(!fs.existsSync(path.join(w.root, 'pbcopy-called')));
    assert.deepEqual(w.homeFiles(), []);
    assert.deepEqual(listFiles(w.app), ['collect.mjs']);
    assert.deepEqual(listFiles(w.cwd), []);
  } finally { w.cleanup(); }
});

test('옵션 없이: 표와 "--publish" 안내만, 아무것도 올리거나 쓰지 않는다', async () => {
  const w = world();
  try {
    const res = await run(w, []);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /Claude Code/);
    assert.match(res.out, /node collect\.mjs --publish/);
    assert.deepEqual(w.calls(), []);
    assert.ok(!fs.existsSync(path.join(w.root, 'pbcopy-called')));
    assert.deepEqual(w.homeFiles(), []);
    assert.deepEqual(listFiles(w.app), ['collect.mjs']);
  } finally { w.cleanup(); }
});

test('--publish (사람용): 표 + gist 주소 + 참가 링크', async () => {
  const w = world();
  try {
    membersDoc = { schema: 1, members: [] };
    const res = await run(w, ['--publish'], { GH_TOKEN: FAKE_TOKEN });
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /Claude Code/);
    assert.match(res.out, /gist\s+https:\/\/gist\.github\.com\/f00d/);
    assert.match(res.out, /새 공개 gist 를 만들었어요/);
    assert.match(res.out, /issues\/new\?template=join\.yml&title=join&gist=f00d/);
    assert.ok(!(res.out + res.err).includes(FAKE_TOKEN));
  } finally { w.cleanup(); }
});

// ── 바뀐 것이 없으면 gist 를 고치지 않는다 (공개 수정 기록이 쌓이지 않게) ──
test('samePublished: 시각(updatedAt·generatedAt)과 키 순서만 다르면 같고, 다른 칸이 하나라도 다르면 다르다', () => {
  const a = buildPayload([dirtyEntry()], LOGIN, new Date('2026-10-14T00:00:00Z'));
  const later = JSON.parse(serializePayload(buildPayload([{ ...dirtyEntry(), generatedAt: '2026-10-14T09:00:00Z' }], LOGIN, new Date('2026-10-14T09:00:00Z'))));
  assert.notEqual(later.updatedAt, a.updatedAt);
  assert.notEqual(later.entries[0].generatedAt, a.entries[0].generatedAt);
  assert.equal(samePublished(later, a), true);
  // 키 순서가 달라도 (사람이 gist 를 손으로 고쳐 다시 저장한 경우 등)
  const reordered = JSON.parse(JSON.stringify(a, Object.keys(a).sort()));
  reordered.entries = a.entries.map((e) => Object.fromEntries(Object.entries(e).reverse()));
  assert.equal(samePublished(reordered, a), true);
  // 숫자 하나 · 날짜 하나 · 모르는 칸 하나 · 계정
  const bump = structuredClone(a); bump.entries[0].byDay['2026-10-13'][0] += 1;
  const day = structuredClone(a); day.entries[0].byDay['2026-10-15'] = [1, 0, 0];
  const extra = structuredClone(a); extra.name = 'SECRET-NICK';
  const extraEntry = structuredClone(a); extraEntry.entries[0].projects = ['SECRET-PROJECT'];
  const other = structuredClone(a); other.login = 'someone-else';
  for (const d of [bump, day, extra, extraEntry, other]) assert.equal(samePublished(d, a), false);
  for (const junk of [null, undefined, 'x', 1, [], {}]) assert.equal(samePublished(junk, a), false);
});

test('다시 올렸는데 바뀐 것이 없으면 고치지 않고 unchanged: true (종료 0, 참가 여부도 다시 본다)', async () => {
  const w = world();
  try {
    membersDoc = { schema: 1, members: [] };
    const first = oneJson((await run(w, ['--publish', '--json'])).out);
    assert.equal(first.unchanged, undefined, '처음 만든 것은 바뀐 것');
    const revisionAt = w.state().gists[first.gist].updated_at;
    const before = w.calls().length;

    membersDoc = { schema: 1, members: [{ login: LOGIN, gist: first.gist, joinedAt: '2026-10-14T00:00:00Z' }] };
    const res = await run(w, ['--publish', '--json']);
    assert.equal(res.code, 0, res.err);
    const j = oneJson(res.out);
    assert.deepEqual(sorted(j), ['gist', 'joinUrl', 'login', 'member', 'ok', 'unchanged', 'url']);
    assert.deepEqual([j.ok, j.unchanged, j.gist, j.member], [true, true, first.gist, true]);
    assert.equal(j.url, first.url);
    assert.equal(j.joinUrl, joinUrl(first.gist));
    // 읽기만 했다: 로그인 확인 + 지금 내용 읽기. 고치기(PATCH)·만들기(POST)는 없다
    assert.deepEqual(argvOf(w.calls().slice(before)), ['api user --jq .login', `api gists/${first.gist}`]);
    assert.equal(w.state().gists[first.gist].updated_at, revisionAt, 'gist 수정 기록이 새로 생기면 안 된다');

    // 사람용 출력도 그렇게 말한다
    const human = await run(w, ['--publish']);
    assert.equal(human.code, 0, human.err);
    assert.match(human.out, /바뀐 것이 없어 gist 를 그대로 뒀어요/);
    assert.ok(!argvOf(w.calls()).some((a) => a.includes('PATCH')));

    // 새 기록이 생기면 그때는 고친다
    writeClaude(path.join(w.logs, 'claude'), ['2026-10-12', '2026-10-13', '2026-10-14']);
    const changed = oneJson((await run(w, ['--publish', '--json'])).out);
    assert.equal(changed.unchanged, undefined);
    assert.equal(argvOf(w.calls()).at(-1), `api -X PATCH gists/${first.gist} --input -`);
    assert.ok(uploaded(w.calls().at(-1)).entries[0].byDay['2026-10-14']);
  } finally { w.cleanup(); }
});

test('숫자가 같아도 gist 에 화이트리스트 밖의 칸이 있으면 고쳐서 지운다', async () => {
  const w = world();
  try {
    const first = oneJson((await run(w, ['--publish', '--json'])).out);
    // 누군가(또는 옛 판 수집기가) gist 에 이름을 넣어 두었다
    const st = w.state();
    const doc = JSON.parse(st.gists[first.gist].files[GIST_FILE]);
    st.gists[first.gist].files[GIST_FILE] = JSON.stringify({ ...doc, name: 'SECRET-NICK', entries: doc.entries.map((e) => ({ ...e, cwd: '/Users/someone' })) });
    fs.writeFileSync(path.join(w.ghDir, 'state.json'), JSON.stringify(st));
    const j = oneJson((await run(w, ['--publish', '--json'])).out);
    assert.equal(j.unchanged, undefined);
    const now = w.state().gists[first.gist].files[GIST_FILE];
    assert.ok(!now.includes('SECRET-NICK') && !now.includes('someone'));
    assertWhitelisted(JSON.parse(now));
  } finally { w.cleanup(); }
});

test('지금 내용을 못 읽으면(실패·잘림·깨짐·남의 gist) 비교하지 않고 그냥 고친다', async () => {
  for (const [why, rule] of [
    ['읽기 실패', { status: 1, stderr: 'gh: Server Error (HTTP 500)\n' }],
    ['잘림', { status: 0, stdout: (id) => JSON.stringify({ id, owner: { login: LOGIN }, files: { [GIST_FILE]: { truncated: true, content: '{"sch' } } }) }],
    ['깨진 JSON', { status: 0, stdout: () => '<html>oops</html>' }],
    ['남의 gist', { status: 0, stdout: (id, content) => JSON.stringify({ id, owner: { login: 'someone-else' }, files: { [GIST_FILE]: { content } } }) }],
  ]) {
    const w = world();
    try {
      const first = oneJson((await run(w, ['--publish', '--json'])).out);
      const content = w.state().gists[first.gist].files[GIST_FILE];
      const sc = JSON.parse(fs.readFileSync(path.join(w.ghDir, 'scenario.json'), 'utf8'));
      sc.fail = [{ match: `api gists/${first.gist}`, status: rule.status, stderr: rule.stderr || '', stdout: rule.stdout ? rule.stdout(first.gist, content) : '' }];
      fs.writeFileSync(path.join(w.ghDir, 'scenario.json'), JSON.stringify(sc));
      const res = await run(w, ['--publish', '--json']);
      assert.equal(res.code, 0, `${why}: ${res.out} ${res.err}`);
      const j = oneJson(res.out);
      assert.equal(j.unchanged, undefined, why);
      assert.equal(argvOf(w.calls()).at(-1), `api -X PATCH gists/${first.gist} --input -`, why);
    } finally { w.cleanup(); }
  }
});
