// scripts/join-core.mjs · scripts/join.mjs 검증 — 가짜 fetch·가짜 git 만 쓴다.
// GitHub 에는 아무것도 보내지 않고, 진짜 커밋·push 도 하지 않는다.
// 실행: node --test test/join.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parseAction, extractGistId, inspectGist, checkContent, checkPayload,
  parseMembers, serializeMembers, normalizeMembers, applyJoin, applyLeave,
  commentFor, code, siteFor, isSuccess, RETRY_FOOTER, MAX_BYTES, MAX_MEMBERS, SITE_URL,
} from '../scripts/join-core.mjs';
import { fetchGist, saveMembers, run, realGit, PUSH_ATTEMPTS } from '../scripts/join.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = '0123456789abcdef0123456789abcdef';
const ID2 = 'fedcba9876543210fedcba9876543210';
const SHA = 'a'.repeat(40);
const TOKEN = 'ghs_FAKE_TEST_TOKEN_do_not_print';
const NOW = new Date('2026-10-14T03:00:00.000Z');

// ── 픽스처 ──────────────────────────────────────────────────────────────
function entry(tool = 'claude', over = {}) {
  return {
    tool, generatedAt: '2026-10-14T02:59:00.000Z', tz: 'Asia/Seoul',
    range: { from: '2026-10-01', to: '2026-10-14', activeDays: 2 },
    totals: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40, total: 100, cost: 1.23, messages: 5 },
    messages: 5, sessions: 2, subagents: 1, split: { main: 80, sub: 20 },
    byModel: { 'claude-opus-5': { input: 10, output: 20, cacheWrite: 30, cacheRead: 40, total: 100, cost: 1.23, messages: 5 } },
    byDay: { '2026-10-01': [60, 10, 0.7], '2026-10-14': [40, 10, 0.53] },
    estimated: false,
    ...over,
  };
}
function payload(over = {}) {
  return {
    schema: 1, app: 'token-meter', login: 'Min-heee', updatedAt: '2026-10-14T03:00:00.000Z',
    entries: [entry('claude'), entry('codex', { subagents: 0, split: null })],
    ...over,
  };
}
const rawUrl = (owner = 'Min-heee', id = ID) => `https://gist.githubusercontent.com/${owner}/${id}/raw/${SHA}/token-meter.json`;
function apiGist({ id = ID, owner = 'Min-heee', text = JSON.stringify(payload()), truncated = false, size, files } = {}) {
  return {
    id, public: true,
    owner: owner === null ? null : { login: owner },
    files: files ?? {
      'token-meter.json': {
        filename: 'token-meter.json', size: size ?? Buffer.byteLength(text), truncated,
        content: truncated ? text.slice(0, 10) : text, raw_url: rawUrl(owner ?? 'x', id),
      },
    },
  };
}

/** 주소별로 정해 둔 응답을 돌려주는 가짜 fetch. 정해 두지 않은 주소는 unexpected 에 남긴다. */
function fakeFetch(routes) {
  const calls = [], unexpected = [];
  const f = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, method, headers, body: opts.body ? JSON.parse(opts.body) : undefined });
    const h = routes[`${method} ${url}`];
    if (h === undefined) { unexpected.push(`${method} ${url}`); return new Response('{}', { status: 500 }); }
    const r = typeof h === 'function' ? await h(url, opts) : h;
    if (r instanceof Error) throw r;
    if (r.status === 204) return new Response(null, { status: 204 });
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200 });
  };
  f.calls = calls;
  f.unexpected = unexpected;
  return f;
}
const GIST_API = (id = ID) => `GET https://api.github.com/gists/${id}`;

// ── 제목 → join / leave ─────────────────────────────────────────────────
test('제목: join/leave 는 대소문자·괄호·문장부호와 상관없이 읽는다', () => {
  for (const t of ['join', 'JOIN', 'Join', '  join  ', '[join]', '[Join]', 'join!', 'join.', 'join: Min-heee', 'Join - me', 'join | 참가', '**join**']) {
    assert.equal(parseAction(t), 'join', t);
  }
  for (const t of ['leave', 'LEAVE', '[Leave]', 'leave: bye', 'Leave.']) assert.equal(parseAction(t), 'leave', t);
});

test('제목: 다른 이슈(버그 제보 등)는 건드리지 않는다', () => {
  for (const t of ['Join button is broken', 'joined', 'rejoin', 'joinme', 'leaves', 'bug: join fails', '', null, undefined, '참가', 'how to join?']) {
    assert.equal(parseAction(t), null, String(t));
  }
});

// ── 본문 → gist id ──────────────────────────────────────────────────────
test('본문: 주소 여러 꼴과 id 만 있는 것에서 gist id 를 찾는다', () => {
  const forms = [
    `https://gist.github.com/Min-heee/${ID}`,
    `https://gist.github.com/${ID}`,
    `gist.github.com/min-heee/${ID}#file-token-meter-json`,
    `http://gist.github.com/Min-heee/${ID}?foo=1`,
    `https://gist.github.com/Min-heee/${ID}.git`,
    `https://gist.github.com/Min-heee/${ID}/${SHA}`,                    // 지난 버전 주소
    `https://gist.github.com/Min-heee/${ID}/revisions`,
    rawUrl(),
    `https://api.github.com/gists/${ID}`,
    `git@gist.github.com:${ID}.git`,
    `[내 gist](https://gist.github.com/Min-heee/${ID})`,
    `https://github.com/Min-heee/token-meter/issues/new?template=join.yml&title=join&gist=${ID}`,
    `https://gist.github.com/deadbeefdeadbeefdeadbeef/${ID}`,            // 아이디가 16진수처럼 생겨도
    ID,
    ID.toUpperCase(),
    `### Gist 주소 또는 ID · Gist URL or ID\n\n${ID}\n`,
    `### Gist 주소 또는 ID · Gist URL or ID\n\nhttps://gist.github.com/Min-heee/${ID}\n\n### 다른 칸\n\n_No response_`,
    `여기요 ${ID} 감사합니다`,
    `https://gist.github.com/Min-heee/${ID}\n그리고 같은 것: ${ID}`,       // 같은 id 두 번은 하나로
  ];
  for (const b of forms) assert.deepEqual(extractGistId(b), { ok: true, id: ID }, b);
});

test('본문: 쓸데없는 글·짧은 16진수·커밋 해시에서는 찾지 않는다', () => {
  for (const b of ['', null, undefined, '_No response_', 'hello', 'added faded decade', 'https://gist.github.com/Min-heee',
    SHA, `https://github.com/Min-heee/token-meter/commit/${SHA}`, 'abc123', '0123456789abcdef012', `x${ID}y`]) {
    assert.deepEqual(extractGistId(b), { ok: false, code: 'no_gist' }, String(b));
  }
});

test('본문: 서로 다른 gist 가 둘이면 고르지 않는다', () => {
  assert.deepEqual(extractGistId(`https://gist.github.com/a/${ID}\nhttps://gist.github.com/a/${ID2}`),
    { ok: false, code: 'multiple_gists', ids: [ID, ID2] });
  assert.deepEqual(extractGistId(`${ID} ${ID2.toUpperCase()}`), { ok: false, code: 'multiple_gists', ids: [ID, ID2] });
});

// ── gist API 응답 검사 ──────────────────────────────────────────────────
test('gist 응답: 주인이 이슈 연 사람과 같아야 한다(대소문자 무시)', () => {
  assert.equal(inspectGist(apiGist(), 'min-HEEE').ok, true);
  assert.deepEqual(inspectGist(apiGist({ owner: 'someone-else' }), 'Min-heee'),
    { ok: false, code: 'owner_mismatch', owner: 'someone-else', author: 'Min-heee' });
  assert.deepEqual(inspectGist(apiGist({ owner: null }), 'Min-heee'),    // 익명 gist
    { ok: false, code: 'owner_mismatch', owner: '?', author: 'Min-heee' });
});

test('gist 응답: token-meter.json 이 없으면 missing_file', () => {
  const g = apiGist({ files: { 'notes.md': { filename: 'notes.md', size: 3, content: 'hey' } } });
  assert.deepEqual(inspectGist(g, 'Min-heee'), { ok: false, code: 'missing_file' });
  assert.deepEqual(inspectGist(apiGist({ files: {} }), 'Min-heee'), { ok: false, code: 'missing_file' });
});

test('gist 응답: 잘린 내용이면 raw 주소(gist 전용 호스트만)를 돌려준다', () => {
  assert.deepEqual(inspectGist(apiGist({ truncated: true }), 'Min-heee'), { ok: true, rawUrl: rawUrl() });
  const g = apiGist({ truncated: true });
  g.files['token-meter.json'].raw_url = 'https://evil.example/token-meter.json';
  assert.deepEqual(inspectGist(g, 'Min-heee'), { ok: false, code: 'unavailable', status: 'raw_url' });
});

test('gist 응답: size 가 256 KB 를 넘으면 내용을 보기 전에 too_large', () => {
  assert.deepEqual(inspectGist(apiGist({ size: MAX_BYTES + 1 }), 'Min-heee'), { ok: false, code: 'too_large', size: MAX_BYTES + 1 });
  assert.equal(inspectGist(apiGist({ size: MAX_BYTES }), 'Min-heee').ok, true);
});

// ── 내용 검사 ───────────────────────────────────────────────────────────
test('내용: 올바른 gist 는 통과(빈 entries, Codex 의 split:null 포함)', () => {
  assert.deepEqual(checkContent(JSON.stringify(payload()), 'Min-heee'), { ok: true });
  assert.deepEqual(checkPayload(payload({ entries: [] }), 'Min-heee'), { ok: true });
  assert.deepEqual(checkPayload(payload({ login: 'MIN-HEEE' }), 'min-heee'), { ok: true });
  assert.deepEqual(checkPayload(payload({ entries: [entry('gemini', { split: null, byModel: {}, byDay: {} })] }), 'Min-heee'), { ok: true });
  // 없어도 되는 칸은 빠져도 된다
  const lean = { tool: 'claude', totals: entry().totals, byDay: {} };
  assert.deepEqual(checkPayload(payload({ entries: [lean], app: undefined, updatedAt: undefined }), 'Min-heee'), { ok: true });
});

test('내용: JSON 이 아니면 bad_json, 256 KB 를 넘으면 too_large', () => {
  assert.deepEqual(checkContent('{"schema":1,', 'Min-heee'), { ok: false, code: 'bad_json' });
  const big = JSON.stringify(payload({ updatedAt: '2026-10-14T03:00:00.000Z' })) + ' '.repeat(MAX_BYTES);
  assert.deepEqual(checkContent(big, 'Min-heee'), { ok: false, code: 'too_large', size: Buffer.byteLength(big) });
  // 한글처럼 여러 바이트 글자는 바이트로 잰다
  const ko = '"' + '가'.repeat(Math.ceil(MAX_BYTES / 3)) + '"';
  assert.equal(checkContent(ko, 'Min-heee').code, 'too_large');
});

test('내용: schema·app·login·updatedAt·모르는 칸', () => {
  const chk = (doc) => checkPayload(doc, 'Min-heee');
  assert.deepEqual(chk(payload({ schema: 2 })), { ok: false, code: 'bad_schema', path: 'schema', why: 'bad_value' });
  assert.deepEqual(chk(payload({ schema: '1' })), { ok: false, code: 'bad_schema', path: 'schema', why: 'bad_value' });
  assert.deepEqual(chk([]), { ok: false, code: 'bad_schema', path: '$', why: 'not_object' });
  assert.deepEqual(chk(null), { ok: false, code: 'bad_schema', path: '$', why: 'not_object' });
  const { schema, ...noSchema } = payload();
  assert.deepEqual(chk(noSchema), { ok: false, code: 'bad_schema', path: 'schema', why: 'missing' });
  assert.deepEqual(chk(payload({ app: 'other' })), { ok: false, code: 'bad_schema', path: 'app', why: 'bad_value' });
  assert.deepEqual(chk(payload({ updatedAt: 'yesterday' })), { ok: false, code: 'bad_schema', path: 'updatedAt', why: 'not_date' });
  assert.deepEqual(chk(payload({ login: 'bad login!' })), { ok: false, code: 'bad_schema', path: 'login', why: 'bad_login' });
  assert.deepEqual(chk(payload({ entries: {} })), { ok: false, code: 'bad_schema', path: 'entries', why: 'not_array' });
  // 이름·닉네임 같은 칸은 공개되면 안 된다
  assert.deepEqual(chk(payload({ name: '홍길동' })), { ok: false, code: 'bad_schema', path: 'name', why: 'unknown_key' });
});

test('내용: gist 안의 login 이 이슈 연 사람과 다르면 login_mismatch', () => {
  assert.deepEqual(checkPayload(payload({ login: 'someone' }), 'Min-heee'),
    { ok: false, code: 'login_mismatch', login: 'someone', author: 'Min-heee' });
});

test('내용: 기록 칸 검사(화이트리스트·숫자·날짜·도구)', () => {
  const bad = (e, path, why) => assert.deepEqual(
    checkPayload(payload({ entries: [e] }), 'Min-heee'), { ok: false, code: 'bad_entries', path, why }, `${path} ${why}`);
  bad('x', 'entries[0]', 'not_object');
  bad(entry('claude', { projects: ['secret-app'] }), 'entries[0].projects', 'unknown_key');
  bad(entry('claude', { projectCount: 3 }), 'entries[0].projectCount', 'unknown_key');
  bad(entry('claude', { name: 'me' }), 'entries[0].name', 'unknown_key');
  bad(entry('claude', { _stats: {} }), 'entries[0]._stats', 'unknown_key');
  bad(entry('claude', { cwd: '/Users/me' }), 'entries[0].cwd', 'unknown_key');
  bad(entry('cursor'), 'entries[0].tool', 'bad_tool');
  bad(entry('claude', { tool: undefined }), 'entries[0].tool', 'missing');
  bad(entry('claude', { totals: undefined }), 'entries[0].totals', 'missing');
  bad(entry('claude', { totals: { ...entry().totals, cost: -1 } }), 'entries[0].totals.cost', 'not_number');
  bad(entry('claude', { totals: { ...entry().totals, total: '100' } }), 'entries[0].totals.total', 'not_number');
  bad(entry('claude', { totals: { ...entry().totals, input: null } }), 'entries[0].totals.input', 'not_number');
  const { messages, ...noMsg } = entry().totals;
  bad(entry('claude', { totals: noMsg }), 'entries[0].totals.messages', 'missing');
  bad(entry('claude', { byDay: undefined }), 'entries[0].byDay', 'missing');
  bad(entry('claude', { byDay: { '2026/10/01': [1, 1, 1] } }), 'entries[0].byDay.…', 'bad_day');   // 남이 정한 이름은 가린다
  bad(entry('claude', { byDay: { '2026-10-01': [1, 1] } }), 'entries[0].byDay.2026-10-01', 'not_day_triple');
  bad(entry('claude', { byDay: { '2026-10-01': [1, -1, 1] } }), 'entries[0].byDay.2026-10-01', 'not_day_triple');
  bad(entry('claude', { byDay: { '2026-10-01': 5 } }), 'entries[0].byDay.2026-10-01', 'not_day_triple');
  bad(entry('claude', { byModel: { m: { total: 'x' } } }), 'entries[0].byModel.m.total', 'not_number');
  bad(entry('claude', { byModel: { m: 5 } }), 'entries[0].byModel.m', 'not_object');
  bad(entry('claude', { byModel: { 'a\nb': {} } }), 'entries[0].byModel', 'bad_model_name');
  bad(entry('claude', { byModel: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`m${i}`, {}])) }), 'entries[0].byModel', 'too_many');
  bad(entry('claude', { range: { from: 'today' } }), 'entries[0].range.from', 'bad_day');
  bad(entry('claude', { range: { from: null, to: null, activeDays: 1, cwd: '/x' } }), 'entries[0].range.cwd', 'unknown_key');
  bad(entry('claude', { split: { main: 1, sub: 2, sessions: ['abc'] } }), 'entries[0].split.sessions', 'unknown_key');
  bad(entry('claude', { split: { main: -5, sub: 0 } }), 'entries[0].split.main', 'not_number');
  bad(entry('claude', { sessions: -1 }), 'entries[0].sessions', 'not_number');
  bad(entry('claude', { generatedAt: 'nope' }), 'entries[0].generatedAt', 'not_date');
  bad(entry('claude', { tz: 'Asia/Seoul; rm -rf' }), 'entries[0].tz', 'bad_tz');
  bad(entry('claude', { estimated: 'yes' }), 'entries[0].estimated', 'not_bool');

  assert.deepEqual(checkPayload(payload({ entries: [entry('claude'), entry('claude')] }), 'Min-heee'),
    { ok: false, code: 'bad_entries', path: 'entries[1].tool', why: 'duplicate_tool' });
  assert.deepEqual(checkPayload(payload({ entries: [entry('claude'), entry('codex'), entry('gemini'), entry('claude')] }), 'Min-heee'),
    { ok: false, code: 'bad_entries', path: 'entries', why: 'too_many' });
});

// ── gist 받아 오기 (가짜 fetch) ─────────────────────────────────────────
test('fetchGist: 인증 없이 api.github.com/gists/<id> 를 부르고 통과하면 id 를 돌려준다', async () => {
  const f = fakeFetch({ [GIST_API()]: { body: apiGist() } });
  assert.deepEqual(await fetchGist(ID, 'Min-heee', { fetch: f }), { ok: true, gist: ID });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `https://api.github.com/gists/${ID}`);
  assert.equal(f.calls[0].headers.authorization, undefined, 'gist 요청에 Authorization 이 붙으면 안 된다');
  assert.deepEqual(f.unexpected, []);
});

test('fetchGist: 잘린 내용은 raw_url 에서 받아 검사한다(이것도 인증 없이)', async () => {
  const text = JSON.stringify(payload());
  const f = fakeFetch({
    [GIST_API()]: { body: apiGist({ truncated: true, text }) },
    [`GET ${rawUrl()}`]: { body: text },
  });
  assert.deepEqual(await fetchGist(ID, 'Min-heee', { fetch: f }), { ok: true, gist: ID });
  assert.deepEqual(f.calls.map((c) => c.url), [`https://api.github.com/gists/${ID}`, rawUrl()]);
  assert.ok(f.calls.every((c) => c.headers.authorization === undefined));

  // raw 원본이 형식에 안 맞으면 그 이유로 거절
  const g = fakeFetch({
    [GIST_API()]: { body: apiGist({ truncated: true, text }) },
    [`GET ${rawUrl()}`]: { body: JSON.stringify(payload({ schema: 9 })) },
  });
  assert.equal((await fetchGist(ID, 'Min-heee', { fetch: g })).code, 'bad_schema');

  // raw 원본이 상한보다 크면 끝까지 읽지 않고 too_large
  const h = fakeFetch({
    [GIST_API()]: { body: apiGist({ truncated: true, text, size: 1000 }) },
    [`GET ${rawUrl()}`]: { body: 'x'.repeat(MAX_BYTES + 10) },
  });
  assert.deepEqual(await fetchGist(ID, 'Min-heee', { fetch: h }), { ok: false, code: 'too_large', size: MAX_BYTES + 1 });

  // raw 를 못 받으면 unavailable
  const k = fakeFetch({ [GIST_API()]: { body: apiGist({ truncated: true, text }) }, [`GET ${rawUrl()}`]: { status: 502, body: '' } });
  assert.deepEqual(await fetchGist(ID, 'Min-heee', { fetch: k }), { ok: false, code: 'unavailable', status: 502 });
});

test('fetchGist: 404·403·네트워크 오류·주인 다름·파일 없음·크기 초과', async () => {
  const one = (resp, author = 'Min-heee') => fetchGist(ID, author, { fetch: fakeFetch({ [GIST_API()]: resp }) });
  assert.deepEqual(await one({ status: 404, body: { message: 'Not Found' } }), { ok: false, code: 'not_found' });
  assert.deepEqual(await one({ status: 403, body: { message: 'API rate limit exceeded' } }), { ok: false, code: 'unavailable', status: 403 });
  assert.deepEqual(await one(new TypeError('fetch failed')), { ok: false, code: 'unavailable', status: 'network' });
  assert.deepEqual(await one({ body: 'not json{' }), { ok: false, code: 'unavailable', status: 'bad response' });
  assert.equal((await one({ body: apiGist({ owner: 'mallory' }) })).code, 'owner_mismatch');
  assert.equal((await one({ body: apiGist({ files: {} }) })).code, 'missing_file');
  // size 칸이 상한을 넘으면 raw 를 받지 않는다(가짜 fetch 에 raw 경로가 없어도 된다)
  const f = fakeFetch({ [GIST_API()]: { body: apiGist({ truncated: true, size: MAX_BYTES * 4 }) } });
  assert.equal((await fetchGist(ID, 'Min-heee', { fetch: f })).code, 'too_large');
  assert.deepEqual(f.unexpected, []);
  assert.equal(f.calls.length, 1);
});

// ── 명단 ────────────────────────────────────────────────────────────────
const M = (login, gist = ID, joinedAt = '2026-10-01T00:00:00.000Z') => ({ login, gist, joinedAt });

test('명단: 처음 파일은 빈 명단이고, 직렬화 결과와 글자까지 같다', () => {
  const text = fs.readFileSync(path.join(HERE, '..', 'docs', 'members.json'), 'utf8');
  assert.deepEqual(parseMembers(text), []);
  assert.equal(serializeMembers([]), '{\n  "schema": 1,\n  "members": []\n}\n');
});

test('명단: 넣으면 login 순(대소문자 무시)으로 정렬된다', () => {
  let ms = [];
  for (const login of ['carol', 'Bob', 'alice', 'Dave']) ms = applyJoin(ms, { login, gist: ID, now: NOW }).members;
  assert.deepEqual(ms.map((m) => m.login), ['alice', 'Bob', 'carol', 'Dave']);
  const r = applyJoin([M('bob')], { login: 'Zed', gist: ID2, now: NOW });
  assert.equal(r.code, 'joined');
  assert.equal(r.changed, true);
  assert.equal(r.gist, ID2);
  assert.deepEqual(r.members.at(-1), { login: 'Zed', gist: ID2, joinedAt: NOW.toISOString() });
});

test('명단: 같은 사람(대소문자 무시)이 새 gist 로 오면 바꾸고, 처음 참가 시각은 지킨다', () => {
  const r = applyJoin([M('alice'), M('Min-heee', ID)], { login: 'min-HEEE', gist: ID2, now: NOW });
  assert.equal(r.code, 'replaced');
  assert.equal(r.changed, true);
  assert.equal(r.prev, ID);
  assert.deepEqual(r.members, [M('alice'), M('min-HEEE', ID2)]);   // 한 줄만, 지금 login 표기로
});

test('명단: 같은 gist 면 바뀐 게 없다(커밋하지 않는다)', () => {
  const ms = [M('Min-heee', ID)];
  const r = applyJoin(ms, { login: 'Min-heee', gist: ID, now: NOW });
  assert.equal(r.code, 'unchanged');
  assert.equal(r.changed, false);
  // login 표기만 바뀌었으면 고쳐 쓰되 "이미 참가 중"으로 알린다
  const r2 = applyJoin(ms, { login: 'MIN-heee', gist: ID, now: NOW });
  assert.equal(r2.code, 'unchanged');
  assert.equal(r2.changed, true);
  assert.equal(r2.members[0].login, 'MIN-heee');
});

test('명단: 2000명이 차면 새 사람은 full, 이미 있는 사람의 gist 바꾸기는 된다', () => {
  const hex = (i) => i.toString(16).padStart(32, '0');
  const ms = normalizeMembers(Array.from({ length: MAX_MEMBERS }, (_, i) => M(`u${i}`, hex(i))));
  assert.equal(ms.length, 2000);
  const full = applyJoin(ms, { login: 'newbie', gist: ID, now: NOW });
  assert.deepEqual([full.code, full.changed, full.members.length, full.max], ['full', false, 2000, 2000]);
  const swap = applyJoin(ms, { login: 'U5', gist: ID, now: NOW });
  assert.deepEqual([swap.code, swap.changed, swap.members.length], ['replaced', true, 2000]);
  assert.equal(applyJoin(ms.slice(1), { login: 'newbie', gist: ID, now: NOW }).code, 'joined');
});

test('명단: 탈퇴는 그 사람만(대소문자 무시) 빼고, 없으면 not_member', () => {
  const ms = [M('alice'), M('Min-heee', ID2), M('zed')];
  const r = applyLeave(ms, { login: 'MIN-HEEE' });
  assert.deepEqual([r.code, r.changed, r.gist], ['left', true, ID2]);
  assert.deepEqual(r.members.map((m) => m.login), ['alice', 'zed']);
  const n = applyLeave(ms, { login: 'nobody' });
  assert.deepEqual([n.code, n.changed, n.members], ['not_member', false, ms]);
});

test('명단: 읽을 때 겹치는 login 은 하나로, 정렬, 깨진 줄은 던진다', () => {
  const text = JSON.stringify({ schema: 1, members: [M('bob', ID2), M('Alice'), M('BOB', ID)] });
  assert.deepEqual(parseMembers(text), [M('Alice'), M('bob', ID2)]);
  assert.throws(() => parseMembers('{'), /JSON/);
  assert.throws(() => parseMembers('{"schema":2,"members":[]}'), /형식/);
  assert.throws(() => parseMembers(JSON.stringify({ schema: 1, members: [{ login: 'a b', gist: ID }] })), /이상한 줄/);
  assert.throws(() => parseMembers(JSON.stringify({ schema: 1, members: [{ login: 'ok', gist: 'not-hex' }] })), /이상한 줄/);
  // joinedAt 이 깨졌으면 null 로 둔다(사람을 빼지는 않는다)
  assert.deepEqual(parseMembers(JSON.stringify({ schema: 1, members: [{ login: 'ok', gist: ID, joinedAt: 'x' }] })),
    [{ login: 'ok', gist: ID, joinedAt: null }]);
  // 직렬화 → 다시 읽기 왕복
  const ms = [M('b'), M('A', ID2)];
  assert.deepEqual(parseMembers(serializeMembers(ms)), [M('A', ID2), M('b')]);
  assert.equal(serializeMembers(ms), `{
  "schema": 1,
  "members": [
    {
      "login": "A",
      "gist": "${ID2}",
      "joinedAt": "2026-10-01T00:00:00.000Z"
    },
    {
      "login": "b",
      "gist": "${ID}",
      "joinedAt": "2026-10-01T00:00:00.000Z"
    }
  ]
}
`);
});

// ── 댓글 ────────────────────────────────────────────────────────────────
const SITE = 'https://min-heee.github.io/token-meter/';
const FOOT_KO = '고친 뒤 이 이슈의 제목이나 본문을 수정(Edit)하거나, 닫았다가 다시 열면 다시 확인해요.';
const FOOT_EN = 'Once fixed, edit this issue (or close and reopen it) and it will be checked again.';

test('댓글: 성공 문구(그대로)', () => {
  const d = { login: 'Min-heee', author: 'Min-heee', site: SITE };
  assert.equal(commentFor({ ...d, code: 'joined', gist: ID }),
`참가 완료! \`Min-heee\` 님의 gist(\`${ID}\`)를 순위판 명단에 넣었어요. 사이트에 보이기까지 몇 분 걸릴 수 있어요: ${SITE}
앞으로 \`node collect.mjs --publish\` 로 올릴 때마다 순위판 숫자도 바뀌어요.

You're in! Added \`Min-heee\`'s gist (\`${ID}\`) to the leaderboard members list. It can take a few minutes to show up: ${SITE}
From now on, every \`node collect.mjs --publish\` updates your numbers on the board.

<!-- token-meter-join:joined -->`);

  assert.equal(commentFor({ ...d, code: 'replaced', gist: ID2, prev: ID }),
`gist를 바꿨어요. 이제 \`Min-heee\` 님의 숫자는 \`${ID2}\` 에서 읽어요(전에는 \`${ID}\`).

Switched your gist. \`Min-heee\`'s numbers are now read from \`${ID2}\` (previously \`${ID}\`).

<!-- token-meter-join:replaced -->`);

  assert.equal(commentFor({ ...d, code: 'unchanged', gist: ID }),
`이미 참가 중이에요. \`Min-heee\` 님의 gist(\`${ID}\`)가 명단에 그대로 있어요.

You're already in. \`Min-heee\`'s gist (\`${ID}\`) is already on the members list.

<!-- token-meter-join:unchanged -->`);

  assert.equal(commentFor({ ...d, code: 'left', gist: ID }),
`명단에서 뺐어요. 사이트에서 사라지기까지 몇 분 걸릴 수 있어요.
gist는 직접 지워 주세요: https://gist.github.com/Min-heee/${ID}
지우기 전까지는 gist와 지난 버전(revision)이 모두 공개로 남아요.

Removed you from the members list. It can take a few minutes to disappear from the site.
Please delete the gist yourself: https://gist.github.com/Min-heee/${ID}
Until you delete it, the gist and all its past revisions stay public.

<!-- token-meter-join:left -->`);

  assert.equal(commentFor({ ...d, code: 'not_member' }),
`\`Min-heee\` 님은 명단에 없어서 바꿀 게 없어요. 올려 둔 gist가 있다면 직접 지워 주세요: https://gist.github.com/Min-heee

\`Min-heee\` is not on the members list, so nothing changed. If you published a gist, please delete it yourself: https://gist.github.com/Min-heee

<!-- token-meter-join:not_member -->`);
});

test('댓글: 실패 문구(그대로) — 다시 시도하는 법이 붙는다', () => {
  assert.equal(commentFor({ code: 'owner_mismatch', id: ID, owner: 'mallory', author: 'Min-heee' }),
`이 gist(\`${ID}\`)의 주인(\`mallory\`)과 이슈를 연 사람(\`Min-heee\`)이 달라요. 내 계정에 올린 gist로만 참가할 수 있어요.
${FOOT_KO}

This gist (\`${ID}\`) belongs to \`mallory\`, but this issue was opened by \`Min-heee\`. You can only join with a gist in your own account.
${FOOT_EN}

<!-- token-meter-join:owner_mismatch -->`);

  assert.equal(commentFor({ code: 'no_gist' }),
`본문에서 gist 주소나 ID를 찾지 못했어요. \`node collect.mjs --publish\` 가 보여 주는 참가 링크로 이슈를 열거나, gist 칸에 \`https://gist.github.com/<아이디>/<gist ID>\` 꼴로 적어 주세요.
${FOOT_KO}

Could not find a gist URL or ID in this issue. Open the join link that \`node collect.mjs --publish\` prints, or put something like \`https://gist.github.com/<login>/<gist id>\` in the gist field.
${FOOT_EN}

<!-- token-meter-join:no_gist -->`);

  assert.equal(commentFor({ code: 'bad_entries', path: 'entries[0].projects', why: 'unknown_key' }),
`기록 칸이 잘못됐어요 — \`entries[0].projects\`: 올리면 안 되는 칸이에요. 최신 \`collect.mjs\` 로 다시 올려 주세요.
${FOOT_KO}

An entry is malformed — \`entries[0].projects\`: a field that must not be published. Publish again with the latest \`collect.mjs\`.
${FOOT_EN}

<!-- token-meter-join:bad_entries -->`);

  assert.equal(commentFor({ code: 'too_large', size: 300 * 1024 + 1 }),
`\`token-meter.json\` 파일이 너무 커요(301 KB, 최대 256 KB).
${FOOT_KO}

\`token-meter.json\` is too large (301 KB, max 256 KB).
${FOOT_EN}

<!-- token-meter-join:too_large -->`);

  assert.equal(commentFor({ code: 'unavailable', status: 403 }),
`지금 GitHub에서 gist를 읽지 못했어요(\`HTTP 403\`). 잠시 뒤 다시 시도해 주세요.
${FOOT_KO}

Could not read the gist from GitHub right now (\`HTTP 403\`). Please try again in a little while.
${FOOT_EN}

<!-- token-meter-join:unavailable -->`);

  // 내부 오류에는 "다시 시도"를 붙이지 않는다 — 사용자가 고칠 게 없다
  assert.equal(commentFor({ code: 'internal' }),
`명단을 저장하다 문제가 생겼어요. 관리자가 확인할게요.

Something went wrong while saving the members list. The maintainer will take a look.

<!-- token-meter-join:internal -->`);
});

test('댓글: 모든 코드가 한국어 → 영어 순서이고, 실패에만 다시 시도 안내가 붙는다', () => {
  const samples = {
    joined: { gist: ID }, replaced: { gist: ID, prev: ID2 }, unchanged: { gist: ID }, left: { gist: ID }, not_member: {},
    no_gist: {}, multiple_gists: { ids: [ID, ID2] }, not_found: { id: ID }, owner_mismatch: { id: ID, owner: 'x' },
    missing_file: { id: ID }, too_large: { size: 999999 }, bad_json: {}, bad_schema: { path: 'schema', why: 'bad_value' },
    login_mismatch: { login: 'x' }, bad_entries: { path: 'entries[0].tool', why: 'bad_tool' }, full: { max: 2000 },
    unavailable: { status: 'network' }, internal: {},
  };
  for (const [c, extra] of Object.entries(samples)) {
    const text = commentFor({ code: c, login: 'Min-heee', author: 'Min-heee', ...extra });
    const [ko, en, marker] = text.split('\n\n');
    assert.match(ko, /[가-힣]/, c);
    assert.doesNotMatch(en, /[가-힣]/, c);
    assert.equal(marker, `<!-- token-meter-join:${c} -->`);
    const failing = !isSuccess(c) && c !== 'internal';
    assert.equal(ko.endsWith(RETRY_FOOTER[0]), failing, c);
    assert.equal(en.endsWith(RETRY_FOOTER[1]), failing, c);
    assert.doesNotMatch(text, /undefined|NaN|\[object/, c);
  }
  // 모르는 코드는 내부 오류로
  assert.equal(commentFor({ code: 'what' }), commentFor({ code: 'internal' }));
  assert.equal(commentFor({ code: 'multiple_gists', ids: [ID, ID2] }).split('\n')[0],
    `gist가 여러 개 적혀 있어요: \`${ID}\`, \`${ID2}\`. 하나만 남겨 주세요.`);
});

test('댓글: 남이 정한 글자는 인라인 코드 안에 가둔다(백틱·줄바꿈 제거, 80자)', () => {
  assert.equal(code('a`b\nc@d'), '`a b c@d`');
  assert.equal(code('x'.repeat(200)).length, 82);
  const text = commentFor({ code: 'bad_entries', path: 'entries[0].byModel.`@octocat`\n# 제목', why: 'not_number' });
  assert.ok(text.includes('`entries[0].byModel. @octocat  # 제목`'));
  assert.equal(siteFor('Min-heee/token-meter'), SITE);
  assert.equal(siteFor('Someone/fork'), 'https://someone.github.io/fork/');
  assert.equal(siteFor(''), SITE_URL);
});

// ── 명단 저장 (가짜 git — 원격 하나를 흉내 낸다) ─────────────────────────
const cmdOf = (args) => args.filter((a, i) => a !== '-c' && args[i - 1] !== '-c')[0];

/**
 * 원격 저장소 흉내: reset 하면 원격 명단이 작업 폴더로, push 가 되면 작업 폴더 명단이 원격으로.
 * beforePush 로 "그사이 다른 실행이 먼저 push" 를 만든다.
 */
function fakeRemote(membersPath, { beforePush = [], alwaysReject = false } = {}) {
  let remote = fs.readFileSync(membersPath, 'utf8');
  const calls = [];
  const git = (args) => {
    calls.push(args);
    const c = cmdOf(args);
    if (c === 'reset') fs.writeFileSync(membersPath, remote);
    if (c === 'push') {
      const race = beforePush.shift();
      if (race) { remote = race(remote); return { ok: false, stderr: '! [rejected] main -> main (fetch first)' }; }
      if (alwaysReject) return { ok: false, stderr: '! [rejected]' };
      remote = fs.readFileSync(membersPath, 'utf8');
    }
    return { ok: true, stdout: '' };
  };
  return { git, calls, get remote() { return remote; } };
}

function tempRepo(members = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-join-'));
  fs.mkdirSync(path.join(dir, 'docs'));
  const membersPath = path.join(dir, 'docs', 'members.json');
  fs.writeFileSync(membersPath, serializeMembers(members));
  return { dir, membersPath };
}
const rmrf = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('saveMembers: 언제나 원격 최신으로 맞춘 뒤 고치고, 커밋은 github-actions[bot] 이름으로', async () => {
  const { dir, membersPath } = tempRepo([M('alice')]);
  try {
    const r = fakeRemote(membersPath);
    const out = await saveMembers({
      change: (ms) => applyJoin(ms, { login: 'Min-heee', gist: ID, now: NOW }), message: 'members: join Min-heee (#7)',
      branch: 'main', git: r.git, read: (p) => fs.readFileSync(p, 'utf8'), write: (p, s) => fs.writeFileSync(p, s),
      membersPath, relPath: 'docs/members.json', log: () => {}, sleep: async () => {},
    });
    assert.deepEqual([out.code, out.committed, out.attempts], ['joined', true, 1]);
    assert.deepEqual(r.calls, [
      ['fetch', '--quiet', 'origin', 'main'],
      ['reset', '--quiet', '--hard', 'FETCH_HEAD'],
      ['add', '--', 'docs/members.json'],
      ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '--quiet', '-m', 'members: join Min-heee (#7)'],
      ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'],
    ]);
    assert.ok(!r.calls.some((a) => a.includes('--force') || a.includes('-f')), '강제 push 금지');
    assert.deepEqual(parseMembers(r.remote).map((m) => m.login), ['alice', 'Min-heee']);
  } finally { rmrf(dir); }
});

test('saveMembers: push 가 거절되면 다시 받아서 처음부터 고친다(남의 변경을 덮지 않는다)', async () => {
  const { dir, membersPath } = tempRepo([M('alice')]);
  try {
    // 첫 push 직전에 다른 실행이 bob 을 넣고 먼저 push 했다
    const r = fakeRemote(membersPath, {
      beforePush: [(remote) => serializeMembers(applyJoin(parseMembers(remote), { login: 'bob', gist: ID2, now: NOW }).members)],
    });
    const logs = [];
    const out = await saveMembers({
      change: (ms) => applyJoin(ms, { login: 'Min-heee', gist: ID, now: NOW }), message: 'm',
      branch: 'main', git: r.git, read: (p) => fs.readFileSync(p, 'utf8'), write: (p, s) => fs.writeFileSync(p, s),
      membersPath, relPath: 'docs/members.json', log: (s) => logs.push(s), sleep: async () => {},
    });
    assert.deepEqual([out.code, out.attempts], ['joined', 2]);
    assert.deepEqual(parseMembers(r.remote).map((m) => m.login), ['alice', 'bob', 'Min-heee']);
    assert.equal(r.calls.filter((a) => cmdOf(a) === 'push').length, 2);
    assert.match(logs.join('\n'), /push 가 거절됐어요\(1\/5\)/);
  } finally { rmrf(dir); }
});

test('saveMembers: 바뀐 게 없으면 커밋하지 않고, push 가 끝내 안 되면 던진다', async () => {
  const { dir, membersPath } = tempRepo([M('Min-heee', ID)]);
  try {
    const base = {
      branch: 'main', read: (p) => fs.readFileSync(p, 'utf8'), write: (p, s) => fs.writeFileSync(p, s),
      membersPath, relPath: 'docs/members.json', log: () => {}, sleep: async () => {},
    };
    const r = fakeRemote(membersPath);
    const same = await saveMembers({ ...base, git: r.git, message: 'm', change: (ms) => applyJoin(ms, { login: 'Min-heee', gist: ID, now: NOW }) });
    assert.deepEqual([same.code, same.committed], ['unchanged', false]);
    assert.ok(!r.calls.some((a) => ['add', 'commit', 'push'].includes(cmdOf(a))));

    const stuck = fakeRemote(membersPath, { alwaysReject: true });
    await assert.rejects(saveMembers({ ...base, git: stuck.git, message: 'm', change: (ms) => applyLeave(ms, { login: 'Min-heee' }) }),
      /5번 올려 봤지만/);
    assert.equal(stuck.calls.filter((a) => cmdOf(a) === 'push').length, PUSH_ATTEMPTS);
  } finally { rmrf(dir); }
});

test('realGit: 실패해도 던지지 않고 ok:false 를 돌려준다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-git-'));
  try {
    const git = realGit(dir);
    assert.equal(git(['--version']).ok, true);
    assert.equal(git(['no-such-subcommand-xyz']).ok, false);
  } finally { rmrf(dir); }
});

// ── 전체 실행 (가짜 GitHub · 가짜 git) ──────────────────────────────────
const ISSUE_API = (n = 7) => `https://api.github.com/repos/Min-heee/token-meter/issues/${n}`;
const PAGES_API = 'https://api.github.com/repos/Min-heee/token-meter/pages/builds';

function scenario({ title = 'join', body = `### Gist 주소 또는 ID · Gist URL or ID\n\nhttps://gist.github.com/Min-heee/${ID}`,
  author = 'Min-heee', state = 'open', liveState, members = [], gistResp, routes = {} } = {}) {
  const { dir, membersPath } = tempRepo(members);
  const issue = { number: 7, title, body, state, user: { login: author } };
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({
    action: 'opened', issue, repository: { full_name: 'Min-heee/token-meter', default_branch: 'main' },
  }));
  const comments = [];
  const fetch = fakeFetch({
    [`GET ${ISSUE_API()}`]: { body: { ...issue, state: liveState ?? state } },
    [GIST_API()]: gistResp ?? { body: apiGist() },
    [`POST ${ISSUE_API()}/comments`]: (url, opts) => { comments.push(JSON.parse(opts.body).body); return { status: 201, body: { id: 1 } }; },
    [`PATCH ${ISSUE_API()}`]: { body: { state: 'closed' } },
    [`POST ${PAGES_API}`]: { status: 201, body: { status: 'queued' } },
    ...routes,
  });
  const remote = fakeRemote(membersPath);
  const logs = [];
  const env = {
    GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'Min-heee/token-meter',
    GITHUB_TOKEN: TOKEN, GITHUB_API_URL: 'https://api.github.com',
  };
  const go = (over = {}) => run({
    env, fetch, git: remote.git, repoRoot: dir, membersPath, now: () => NOW,
    log: (...a) => logs.push(a.join(' ')), sleep: async () => {}, ...over,
  });
  return { dir, membersPath, fetch, origin: remote, comments, logs, go };
}

test('run: 참가 성공 → 명단 커밋·push, 댓글, 닫기. 토큰은 이슈 API 에만 붙고 어디에도 찍히지 않는다', async () => {
  const s = scenario({ members: [M('alice')] });
  try {
    const r = await s.go();
    assert.deepEqual(r, { action: 'join', code: 'joined', closed: true, exitCode: 0 });
    assert.deepEqual(parseMembers(s.origin.remote), [M('alice'), M('Min-heee', ID, NOW.toISOString())]);
    assert.deepEqual(s.comments, [commentFor({ code: 'joined', login: 'Min-heee', gist: ID, site: SITE })]);
    const commit = s.origin.calls.find((a) => cmdOf(a) === 'commit');
    assert.equal(commit.at(-1), 'members: join Min-heee (#7)');

    const byUrl = (u) => s.fetch.calls.filter((c) => c.url.startsWith(u));
    assert.equal(byUrl('https://api.github.com/gists/').length, 1);
    assert.equal(byUrl('https://api.github.com/gists/')[0].headers.authorization, undefined);
    for (const c of byUrl(ISSUE_API())) assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
    const close = s.fetch.calls.find((c) => c.method === 'PATCH');
    assert.deepEqual(close.body, { state: 'closed', state_reason: 'completed' });
    // GITHUB_TOKEN 으로 한 push 는 Pages 빌드를 일으키지 않는다 → 명단을 바꿨으면 빌드를 직접 부탁한다
    const builds = s.fetch.calls.filter((c) => c.url === PAGES_API);
    assert.deepEqual(builds.map((c) => [c.method, c.headers.authorization]), [['POST', `Bearer ${TOKEN}`]]);
    assert.deepEqual(s.fetch.unexpected, []);
    assert.ok(!s.logs.join('\n').includes(TOKEN), '로그에 토큰이 찍히면 안 된다');
    assert.ok(!s.comments.join('\n').includes(TOKEN));
  } finally { rmrf(s.dir); }
});

test('run: 검사 실패 → 이유를 댓글로, 이슈는 열어 두고, 명단은 그대로', async () => {
  const cases = [
    [{ gistResp: { body: apiGist({ owner: 'mallory' }) } }, 'owner_mismatch'],
    [{ gistResp: { body: apiGist({ files: {} }) } }, 'missing_file'],
    [{ gistResp: { status: 404, body: {} } }, 'not_found'],
    [{ gistResp: { body: apiGist({ text: JSON.stringify(payload({ schema: 3 })) }) } }, 'bad_schema'],
    [{ gistResp: { body: apiGist({ text: JSON.stringify(payload({ login: 'mallory' })) }) } }, 'login_mismatch'],
    [{ gistResp: { body: apiGist({ size: MAX_BYTES + 1 }) } }, 'too_large'],
    [{ body: '_No response_' }, 'no_gist'],
    [{ body: `${ID} ${ID2}` }, 'multiple_gists'],
  ];
  for (const [opts, expected] of cases) {
    const s = scenario({ members: [M('alice')], ...opts });
    try {
      const before = s.origin.remote;
      const r = await s.go();
      assert.deepEqual(r, { action: 'join', code: expected, closed: false, exitCode: 0 }, expected);
      assert.equal(s.comments.length, 1, expected);
      assert.match(s.comments[0], new RegExp(`token-meter-join:${expected} -->$`), expected);
      assert.ok(s.comments[0].includes(FOOT_KO) && s.comments[0].includes(FOOT_EN), expected);
      assert.ok(!s.fetch.calls.some((c) => c.method === 'PATCH'), `${expected}: 닫으면 안 된다`);
      assert.ok(!s.origin.calls.some((a) => ['commit', 'push'].includes(cmdOf(a))), `${expected}: 커밋하면 안 된다`);
      assert.equal(s.origin.remote, before);
    } finally { rmrf(s.dir); }
  }
});

test('run: 주인 다름 댓글에는 gist id·주인·이슈 연 사람이 그대로 나온다', async () => {
  const s = scenario({ gistResp: { body: apiGist({ owner: 'mallory' }) } });
  try {
    await s.go();
    assert.equal(s.comments[0], commentFor({ code: 'owner_mismatch', id: ID, owner: 'mallory', author: 'Min-heee' }));
  } finally { rmrf(s.dir); }
});

test('run: 탈퇴 → 명단에서 빼고 닫는다. 명단에 없으면 그렇게 알리고 닫는다', async () => {
  const s = scenario({ title: 'Leave', body: '### 확인 · Confirm\n\n- [X] 순위판 명단에서 저를 빼 주세요', members: [M('alice'), M('min-heee', ID2)] });
  try {
    const r = await s.go();
    assert.deepEqual(r, { action: 'leave', code: 'left', closed: true, exitCode: 0 });
    assert.deepEqual(parseMembers(s.origin.remote), [M('alice')]);
    assert.equal(s.comments[0], commentFor({ code: 'left', login: 'Min-heee', gist: ID2 }));
    assert.equal(s.origin.calls.find((a) => cmdOf(a) === 'commit').at(-1), 'members: leave Min-heee (#7)');
    assert.ok(!s.fetch.calls.some((c) => c.url.includes('/gists/')), '탈퇴는 gist 를 보지 않는다');
  } finally { rmrf(s.dir); }

  const t = scenario({ title: 'leave', members: [M('alice')] });
  try {
    const r = await t.go();
    assert.deepEqual(r, { action: 'leave', code: 'not_member', closed: true, exitCode: 0 });
    assert.ok(!t.origin.calls.some((a) => cmdOf(a) === 'commit'));
  } finally { rmrf(t.dir); }
});

test('run: 이미 참가 중이면 커밋 없이 알리고 닫는다', async () => {
  const s = scenario({ members: [M('Min-heee', ID)] });
  try {
    const r = await s.go();
    assert.deepEqual(r, { action: 'join', code: 'unchanged', closed: true, exitCode: 0 });
    assert.ok(!s.origin.calls.some((a) => cmdOf(a) === 'commit'));
  } finally { rmrf(s.dir); }
});

test('run: 보통 이슈·이미 닫힌 이슈는 아무것도 하지 않는다', async () => {
  const a = scenario({ title: 'Join button is broken on mobile' });
  try {
    assert.deepEqual(await a.go(), { skipped: 'not_join_or_leave', exitCode: 0 });
    assert.deepEqual(a.comments, []);
    assert.deepEqual(a.origin.calls, []);
    assert.ok(a.fetch.calls.every((c) => c.method === 'GET' && c.url === ISSUE_API()));
  } finally { rmrf(a.dir); }

  // 이벤트는 열림이었지만, 줄 서 있던 사이 닫혔다
  const b = scenario({ state: 'open', liveState: 'closed' });
  try {
    assert.deepEqual(await b.go(), { skipped: 'closed', exitCode: 0 });
    assert.deepEqual(b.comments, []);
    assert.deepEqual(b.origin.calls, []);
  } finally { rmrf(b.dir); }
});

test('run: 저장이 끝내 안 되면 내부 오류 댓글, 이슈는 열어 두고 exitCode 1', async () => {
  const s = scenario();
  try {
    const stuck = fakeRemote(s.membersPath, { alwaysReject: true });
    const r = await s.go({ git: stuck.git });
    assert.deepEqual(r, { action: 'join', code: 'internal', closed: false, exitCode: 1 });
    assert.deepEqual(s.comments, [commentFor({ code: 'internal' })]);
    assert.ok(!s.fetch.calls.some((c) => c.method === 'PATCH'));
    assert.ok(!s.logs.join('\n').includes(TOKEN));
  } finally { rmrf(s.dir); }
});

test('run: 이슈를 다시 읽지 못해도 이벤트 내용으로 처리한다', async () => {
  const s = scenario({ routes: { [`GET ${ISSUE_API()}`]: { status: 502, body: {} } } });
  try {
    const r = await s.go();
    assert.equal(r.code, 'joined');
    assert.match(s.logs.join('\n'), /이벤트에 담긴 내용으로/);
  } finally { rmrf(s.dir); }
});

test('run: 진짜 git 은 깃허브 액션 안에서만 쓴다(내 작업 폴더를 reset --hard 하지 않게)', async () => {
  const s = scenario();
  try {
    await assert.rejects(s.go({ git: null }), /깃허브 액션 밖에서는/);
    assert.deepEqual(s.fetch.calls, [], '막히기 전에 아무 요청도 보내지 않는다');
  } finally { rmrf(s.dir); }
});

test('join.mjs 를 이벤트 없이 직접 실행하면 아무것도 하지 않고 1 로 끝난다', () => {
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'scripts', 'join.mjs')], {
    env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GITHUB_EVENT_PATH/);
});

// ── 검토에서 찾은 구멍 (회귀 테스트) ────────────────────────────────────
test('본문: 주소 뒤에 문장부호·한글·굵게 표시가 붙어도 gist id 를 찾는다', () => {
  const url = `https://gist.github.com/Min-heee/${ID}`;
  for (const b of [
    `내 gist: ${url}.`, `${url}, 감사합니다`, `${url}입니다`, `${url}!`, `${url}?`, `${url}。`,
    `**${url}**`, `*${url}*`, `'${url}'`, `${url};`, `https://gist.github.com/${ID}.`,
    `${url}.git.`, `${rawUrl()}.`, `https://api.github.com/gists/${ID}입니다`,
  ]) assert.deepEqual(extractGistId(b), { ok: true, id: ID }, b);
  // 주소 속 아이디가 16진수처럼 생겨도 여전히 id 로 오인하지 않는다
  assert.deepEqual(extractGistId(`https://gist.github.com/deadbeefdeadbeefdeadbeef/${ID}입니다`), { ok: true, id: ID });
  assert.deepEqual(extractGistId('https://gist.github.com/Min-heee.'), { ok: false, code: 'no_gist' });
});

test('내용: totals·모델별 칸에도 화이트리스트 — 칸 이름도 공개되므로 모르는 칸은 거절', () => {
  const bad = (e, path, why) => assert.deepEqual(
    checkPayload(payload({ entries: [e] }), 'Min-heee'), { ok: false, code: 'bad_entries', path, why }, `${path} ${why}`);
  bad(entry('claude', { totals: { ...entry().totals, '/Users/me/secret-project': 5 } }),
    'entries[0].totals.…', 'unknown_key');
  bad(entry('claude', { byModel: { 'claude-opus-5': { ...entry().totals, 'client-acme': 1 } } }),
    'entries[0].byModel.claude-opus-5.…', 'unknown_key');
  // 아는 칸만 일부 있는 모델(옛 꼴)은 그대로 받는다
  assert.deepEqual(checkPayload(payload({ entries: [entry('claude', { byModel: { m: { total: 3, output: 1 } } })] }), 'Min-heee'), { ok: true });
});

test('내용: 모델 이름 __proto__ 는 거절한다(JSON 으로 받은 그대로 — 수집기는 (other) 로 바꿔 올린다)', () => {
  const text = JSON.stringify(payload()).replace('"claude-opus-5"', '"__proto__"');
  assert.match(text, /"__proto__"/);
  assert.deepEqual(checkContent(text, 'Min-heee'), { ok: false, code: 'bad_entries', path: 'entries[0].byModel', why: 'bad_model_name' });
});

test('교차 확인: 참가 검사를 통과하는 gist 는 순위판(board.mjs)도 받는다', async () => {
  const { validatePayload } = await import('../docs/board.mjs');
  const samples = [
    payload(), payload({ entries: [] }), payload({ login: 'MIN-HEEE' }),
    payload({ entries: [entry('gemini', { split: null, byModel: {}, byDay: {} })] }),
    payload({ entries: [{ tool: 'claude', totals: entry().totals, byDay: {} }], app: undefined, updatedAt: undefined }),
    payload({ entries: [entry('codex', { byModel: { '(other)': entry().totals } })] }),
  ];
  for (const doc of samples) {
    const text = JSON.stringify(doc);
    assert.deepEqual(checkContent(text, 'Min-heee'), { ok: true }, text.slice(0, 80));
    assert.doesNotThrow(() => validatePayload(JSON.parse(text), { login: 'Min-heee' }), text.slice(0, 80));
  }
});

test('saveMembers: 다시 읽을 수 없는 명단은 쓰지 않는다(한 번 들어가면 다음 실행부터 전부 멈춘다)', async () => {
  const { dir, membersPath } = tempRepo([M('alice')]);
  try {
    const before = fs.readFileSync(membersPath, 'utf8');
    const r = fakeRemote(membersPath);
    for (const bogus of [{ login: 'Min-heee', gist: '../../x' }, { login: 'bad login', gist: ID }]) {
      await assert.rejects(saveMembers({
        change: (ms) => applyJoin(ms, { ...bogus, now: NOW }), message: 'm',
        branch: 'main', git: r.git, read: (p) => fs.readFileSync(p, 'utf8'), write: (p, s) => fs.writeFileSync(p, s),
        membersPath, relPath: 'docs/members.json', log: () => {}, sleep: async () => {},
      }), /이상한 줄/);
    }
    assert.ok(!r.calls.some((a) => ['add', 'commit', 'push'].includes(cmdOf(a))));
    assert.equal(r.remote, before);
    assert.equal(fs.readFileSync(membersPath, 'utf8'), before);
  } finally { rmrf(dir); }
});

test('run: Pages 빌드는 명단을 바꿨을 때만 부탁하고, 실패해도 참가는 성공으로 끝난다', async () => {
  const builds = (s) => s.fetch.calls.filter((c) => c.url === PAGES_API).length;

  const same = scenario({ members: [M('Min-heee', ID)] });          // 이미 참가 중 → 커밋 없음
  try { assert.equal((await same.go()).code, 'unchanged'); assert.equal(builds(same), 0); } finally { rmrf(same.dir); }

  const bad = scenario({ gistResp: { body: apiGist({ owner: 'mallory' }) } });
  try { assert.equal((await bad.go()).code, 'owner_mismatch'); assert.equal(builds(bad), 0); } finally { rmrf(bad.dir); }

  const leave = scenario({ title: 'leave', members: [M('Min-heee', ID)] });
  try { assert.equal((await leave.go()).code, 'left'); assert.equal(builds(leave), 1); } finally { rmrf(leave.dir); }

  // Pages 가 꺼져 있거나 Actions 배포 방식이면 4xx — 경고만 남기고 댓글·닫기는 그대로
  const off = scenario({ routes: { [`POST ${PAGES_API}`]: { status: 404, body: { message: 'Not Found' } } } });
  try {
    assert.deepEqual(await off.go(), { action: 'join', code: 'joined', closed: true, exitCode: 0 });
    assert.equal(builds(off), 1);
    assert.match(off.logs.join('\n'), /::warning::Pages 빌드를 부탁하지 못했어요/);
    assert.equal(off.comments.length, 1);
    assert.ok(off.fetch.calls.some((c) => c.method === 'PATCH'));
    assert.ok(!off.logs.join('\n').includes(TOKEN));
  } finally { rmrf(off.dir); }
});

test('join.mjs 를 심볼릭 링크로 불러도 그냥 0 으로 끝나지 않는다(실행 여부 판정)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-link-'));
  try {
    fs.symlinkSync(path.join(HERE, '..', 'scripts'), path.join(dir, 's'));
    const r = spawnSync(process.execPath, [path.join(dir, 's', 'join.mjs')], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /GITHUB_EVENT_PATH/);
  } finally { rmrf(dir); }
});

// ── 워크플로·이슈 폼 (글자로 확인 — YAML 해석기 없이) ────────────────────
const readRepo = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');

test('워크플로: 이슈 글을 ${{ }} 로 끼워 넣지 않고, 권한·줄 세우기·버전 고정이 그대로다', () => {
  const wf = readRepo('.github/workflows/join.yml');
  const body = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');   // 주석 빼고
  const exprs = [...body.matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => m[1].trim());
  assert.deepEqual(exprs, ['secrets.GITHUB_TOKEN'], '이슈 제목·본문 같은 남의 글을 식으로 넣으면 셸 주입이 된다');
  assert.match(body, /^on:\n\s+issues:\n\s+types: \[opened, edited, reopened\]$/m);
  for (const p of ['contents: write', 'issues: write', 'pages: write']) assert.match(body, new RegExp(`^\\s+${p}\\b`, 'm'), p);
  assert.doesNotMatch(body, /pull_request_target|workflow_run/);
  assert.match(body, /^\s+cancel-in-progress: false$/m);
  assert.match(body, /^\s+queue: max$/m);
  const uses = [...body.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 1);
  for (const u of uses) assert.match(u, /^actions\/[a-z-]+@v\d+$/, u);
  assert.match(body, /run: node scripts\/join\.mjs$/m);
});

test('이슈 폼: 제목과 gist 칸 id 가 수집기의 참가 링크(?template=join.yml&title=join&gist=)와 맞는다', () => {
  const join = readRepo('.github/ISSUE_TEMPLATE/join.yml');
  assert.match(join, /^title: join$/m);
  assert.match(join, /^\s+- type: input\n\s+id: gist$/m);
  assert.match(join.slice(join.indexOf('id: gist')), /validations:\n\s+required: true/);
  assert.equal(parseAction('join'), 'join');
  const leave = readRepo('.github/ISSUE_TEMPLATE/leave.yml');
  assert.match(leave, /^title: leave$/m);
  assert.equal(parseAction('leave'), 'leave');
  // 폼 본문 꼴로 미리 채워진 id 를 찾는다
  assert.deepEqual(extractGistId(`### Gist 주소 또는 ID · Gist URL or ID\n\n${ID}`), { ok: true, id: ID });
});

test('saveMembers: 진짜 git(임시 폴더의 가짜 원격)으로 얕은 복제·늦게 받은 커밋에서도 커밋·push 된다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-realgit-'));
  // 이 컴퓨터의 git 설정(서명 강제 등)이 끼어들지 않게 빈 설정으로 — 끝나면 되돌린다
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
  const restore = () => {
    for (const [k, v] of [['GIT_CONFIG_GLOBAL', saved.g], ['GIT_CONFIG_NOSYSTEM', saved.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  try {
    fs.writeFileSync(path.join(root, 'gitconfig'), '');
    process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
    const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r.stdout; };
    const bare = path.join(root, 'remote.git');
    ok(g(root, 'init', '--quiet', '--bare', bare));
    ok(g(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'));
    const seed = path.join(root, 'seed');
    ok(g(root, 'clone', '--quiet', bare, seed));
    ok(g(seed, 'checkout', '--quiet', '-b', 'main'));
    fs.mkdirSync(path.join(seed, 'docs'));
    fs.writeFileSync(path.join(seed, 'docs', 'members.json'), serializeMembers([]));
    ok(g(seed, 'add', '.')); ok(g(seed, 'commit', '--quiet', '-m', 'init'));
    fs.writeFileSync(path.join(seed, 'README'), 'x');
    ok(g(seed, 'add', '.')); ok(g(seed, 'commit', '--quiet', '-m', 'two'));
    ok(g(seed, 'push', '--quiet', 'origin', 'main'));
    // 액션처럼 얕게(depth 1) 받아 둔 뒤, 그 사이 다른 실행이 bob 을 넣고 먼저 push 했다
    const work = path.join(root, 'work');
    ok(g(root, 'clone', '--quiet', '--depth', '1', '--branch', 'main', `file://${bare}`, work));
    fs.writeFileSync(path.join(seed, 'docs', 'members.json'), serializeMembers([M('bob', ID2)]));
    ok(g(seed, 'commit', '--quiet', '-am', 'bob')); ok(g(seed, 'push', '--quiet', 'origin', 'main'));

    const membersPath = path.join(work, 'docs', 'members.json');
    const base = {
      branch: 'main', git: realGit(work), read: (p) => fs.readFileSync(p, 'utf8'), write: (p, s) => fs.writeFileSync(p, s),
      membersPath, relPath: 'docs/members.json', log: () => {}, sleep: async () => {},
    };
    const j = await saveMembers({ ...base, message: 'members: join Min-heee (#1)', change: (ms) => applyJoin(ms, { login: 'Min-heee', gist: ID, now: NOW }) });
    assert.deepEqual([j.code, j.committed], ['joined', true]);
    const l = await saveMembers({ ...base, message: 'members: leave bob (#2)', change: (ms) => applyLeave(ms, { login: 'BOB' }) });
    assert.deepEqual([l.code, l.committed], ['left', true]);

    assert.deepEqual(parseMembers(ok(g(bare, 'show', 'main:docs/members.json'))), [M('Min-heee', ID, NOW.toISOString())]);
    const logLines = ok(g(bare, 'log', '--format=%an <%ae>|%s', 'main')).trim().split('\n');
    assert.deepEqual(logLines.slice(0, 2), [
      'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|members: leave bob (#2)',
      'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|members: join Min-heee (#1)',
    ]);
    assert.equal(logLines.length, 5, 'bob 커밋을 덮지 않고 그 위에 쌓는다(강제 push 없음)');
  } finally { restore(); rmrf(root); }
});

test('댓글: gist 안의 낯선 칸 이름·모델 이름·날짜 키는 댓글(영구 공개)에 옮기지 않는다', async () => {
  const secrets = ['/Users/hong/client-acme', 'hong.gildong@example.com', '/Users/me/models/x.gguf', 'my-secret-app'];
  const docs = [
    payload({ [secrets[3]]: 1 }),                                                       // 맨 위 낯선 칸
    payload({ entries: [entry('claude', { [secrets[0]]: 1 })] }),                        // 기록 안 낯선 칸
    payload({ entries: [entry('claude', { totals: { ...entry().totals, [secrets[0]]: 1 } })] }),
    payload({ entries: [entry('claude', { byModel: { [secrets[2]]: { total: 'x' } } })] }),   // 경로꼴 모델 이름
    payload({ entries: [entry('claude', { byModel: { [secrets[1]]: 5 } })] }),               // 메일꼴 모델 이름
    payload({ entries: [entry('claude', { byDay: { [secrets[0]]: [1, 1, 1] } })] }),         // 날짜가 아닌 키
    payload({ entries: [entry('claude', { range: { from: null, [secrets[3]]: 1 } })] }),
  ];
  for (const doc of docs) {
    const s = scenario({ gistResp: { body: apiGist({ text: JSON.stringify(doc) }) } });
    try {
      const r = await s.go();
      assert.equal(r.closed, false);
      assert.match(r.code, /^bad_(schema|entries)$/);
      const all = s.comments.join('\n') + '\n' + s.logs.join('\n');
      for (const x of secrets) assert.ok(!all.includes(x), `${r.code}: ${x} 가 댓글·로그에 나왔다`);
      assert.match(s.comments[0], /…/);
    } finally { rmrf(s.dir); }
  }
  // 아는 이름(계약이 '올리지 말 것'으로 꼽은 칸)과 흔한 모델 이름은 그대로 보여 준다 — 무엇을 고칠지 알 수 있게
  assert.equal(checkPayload(payload({ entries: [entry('claude', { projects: ['x'] })] }), 'Min-heee').path, 'entries[0].projects');
  assert.equal(checkPayload(payload({ entries: [entry('claude', { byModel: { 'gpt-5.1-codex': { total: -1 } } })] }), 'Min-heee').path,
    'entries[0].byModel.gpt-5.1-codex.total');
});
