// 순위판 공용 모듈(docs/board.mjs)과 사이트(docs/index.html) 시험.
// 실제 네트워크는 쓰지 않는다: 가짜 fetch 를 넣거나, 이 시험이 띄운 로컬 서버만 부른다
// (CLI 는 preload 로 fetch 를 바꿔 gist 주소를 로컬로 돌리고, 그 밖의 주소는 막는다).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  loadBoard, measure, rank, periodRange, staleDays, summarize, validatePayload,
  BoardError, DEFAULT_BASE, MAX_BYTES,
} from '../docs/board.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const BOARD = path.join(DOCS, 'board.mjs');
const BASE = 'https://example.test/site/';

// ── 재료 ────────────────────────────────────────────────────────────────
const GID = (n) => String(n).padStart(32, 'a');   // 32자리 16진수 gist id

function entry(tool, over = {}) {
  return {
    tool,
    generatedAt: '2026-10-14T01:00:00.000Z',
    tz: 'Asia/Seoul',
    range: { from: '2026-10-01', to: '2026-10-14', activeDays: 3 },
    totals: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40, total: 100, cost: 1.5, messages: 5 },
    messages: 5, sessions: 2, subagents: 1,
    split: { main: 80, sub: 20 },
    byModel: { 'claude-opus-4-6': { input: 10, output: 20, cacheWrite: 30, cacheRead: 40, total: 100, cost: 1.5, messages: 5 } },
    byDay: { '2026-10-01': [40, 5, 0.5], '2026-10-14': [60, 15, 1] },
    estimated: false,
    ...over,
  };
}
const payload = (login, entries, over = {}) => ({
  schema: 1, app: 'token-meter', login, updatedAt: '2026-10-14T02:00:00.000Z', entries, ...over,
});
const members = (list) => ({ schema: 1, members: list.map(([login, gist]) => ({ login, gist, joinedAt: '2026-10-01T00:00:00Z' })) });
const rawKey = (login, gist) => `https://gist.githubusercontent.com/${login}/${gist}/raw/token-meter.json`;

/** 가짜 fetch: 주소(쿼리 빼고) → 응답 본문(객체면 JSON, 문자열이면 그대로, 함수면 직접 Response). 없으면 404. */
function fakeFetch(routes, { delay = 0 } = {}) {
  let inFlight = 0, maxInFlight = 0;
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const u = new URL(String(url));
      const h = routes[u.origin + u.pathname];
      if (h === undefined) return new Response('Not Found', { status: 404 });
      if (typeof h === 'function') return h(u, init);
      return new Response(typeof h === 'string' ? h : JSON.stringify(h), { status: 200 });
    } finally { inFlight--; }
  };
  f.calls = calls;
  f.max = () => maxInFlight;
  return f;
}

// ── loadBoard ───────────────────────────────────────────────────────────
test('loadBoard: 좋은 gist 는 도구별 줄로, 깨진·없는·남의 gist 는 failed 로만 간다', async () => {
  const routes = {
    'https://example.test/site/members.json': members([
      ['alice', GID(1)], ['Bob', GID(2)], ['carol', GID(3)], ['dave', GID(4)], ['eve', GID(5)],
      ['frank', GID(6)], ['grace', GID(7)], ['heidi', GID(8)], ['ivan', GID(9)], ['judy', GID(10)],
      ['bad login!', GID(11)], ['ALICE', GID(12)], ['kim', 'not-hex'],
    ]),
    // alice: 화이트리스트 밖의 칸(이름·프로젝트·경로·_stats)을 섞어 올렸다 → 받아들이되 버린다
    [rawKey('alice', GID(1))]: payload('alice', [
      entry('codex', { name: '홍길동', projects: ['secret'], projectCount: 3, cwd: '/Users/x', sessionIds: ['s1'], _stats: { files: 9 } }),
      entry('claude'),
    ], { name: '홍길동' }),
    [rawKey('Bob', GID(2))]: payload('bob', [entry('gemini')]),           // 대소문자만 다름 → 통과
    [rawKey('carol', GID(3))]: '{ not json',
    // dave: 없음 → 404
    [rawKey('eve', GID(5))]: payload('mallory', [entry('claude')]),
    [rawKey('frank', GID(6))]: payload('frank', [entry('claude', { totals: { ...entry('claude').totals, output: -5 } })]),
    [rawKey('grace', GID(7))]: '{"schema":1,"app":"token-meter","login":"grace","updatedAt":"2026-10-14T00:00:00Z","entries":[{"tool":"claude","totals":{"input":1,"output":1e999,"cacheWrite":0,"cacheRead":0,"total":1,"cost":0}}]}',
    [rawKey('heidi', GID(8))]: payload('heidi', [entry('claude', { byDay: { '2026-10-14': ['60', 1, 0] } })]),
    [rawKey('ivan', GID(9))]: payload('ivan', [entry('claude')], { schema: 2 }),
    [rawKey('judy', GID(10))]: payload('judy', [entry('claude'), entry('claude')]),
  };
  const fetch = fakeFetch(routes);
  const b = await loadBoard({ base: BASE, fetch });

  assert.deepEqual(b.rows.map((r) => `${r.login}/${r.tool}`), ['alice/claude', 'alice/codex', 'Bob/gemini']);
  assert.equal(b.rows[2].login, 'Bob', '줄의 이름은 명단의 login 을 쓴다');
  assert.equal(b.rows[0].updatedAt, '2026-10-14T02:00:00.000Z');
  assert.equal(b.rows[0].gist, GID(1));
  assert.ok(!Number.isNaN(Date.parse(b.fetchedAt)));
  assert.deepEqual(b.members.map((m) => m.login), ['alice', 'Bob', 'carol', 'dave', 'eve', 'frank', 'grace', 'heidi', 'ivan', 'judy']);

  const why = Object.fromEntries(b.failed.map((f) => [f.login, f.reason]));
  assert.deepEqual(why, {
    'bad login!': 'bad_member', ALICE: 'duplicate_member', kim: 'bad_member',
    carol: 'not_json', dave: 'not_found', eve: 'login_mismatch',
    frank: 'bad_entries', grace: 'bad_entries', heidi: 'bad_entries', ivan: 'bad_schema', judy: 'bad_entries',
  });

  // 화이트리스트: 정해진 칸만 남는다
  const e = b.rows.find((r) => r.tool === 'codex').entry;
  assert.deepEqual(Object.keys(e).sort(), ['byDay', 'byModel', 'estimated', 'generatedAt', 'messages', 'range', 'sessions', 'split', 'subagents', 'tool', 'totals', 'tz']);
  assert.deepEqual(Object.keys(e.totals).sort(), ['cacheRead', 'cacheWrite', 'cost', 'input', 'messages', 'output', 'total']);
  const text = JSON.stringify(b);
  for (const leak of ['홍길동', 'secret', '/Users/x', 'projectCount', 'sessionIds', '_stats']) assert.ok(!text.includes(leak), `${leak} 가 새면 안 된다`);
});

test('loadBoard: members.json 은 캐시를 깨서 받고, gist 는 정해진 raw 주소로 받는다', async () => {
  const fetch = fakeFetch({
    'https://example.test/site/members.json': members([['alice', GID(1)]]),
    [rawKey('alice', GID(1))]: payload('alice', [entry('claude')]),
  });
  await loadBoard({ base: 'https://example.test/site', fetch });   // 끝 슬래시 없어도 폴더로 본다
  const [m, g] = fetch.calls;
  const mu = new URL(m.url);
  assert.equal(mu.origin + mu.pathname, 'https://example.test/site/members.json');
  assert.match(mu.searchParams.get('t') || '', /^\d+$/);
  assert.equal(m.init.cache, 'no-store');
  assert.equal(g.url, rawKey('alice', GID(1)));
  assert.equal(fetch.calls.length, 2);
  assert.equal(DEFAULT_BASE, 'https://min-heee.github.io/token-meter/');
});

test('loadBoard: 명단 자체를 못 읽으면 code 가 붙은 오류를 던진다', async () => {
  await assert.rejects(loadBoard({ base: BASE, fetch: fakeFetch({}) }), (e) => e instanceof BoardError && e.code === 'members_missing');
  await assert.rejects(loadBoard({ base: BASE, fetch: async () => { throw new TypeError('fetch failed'); } }), (e) => e.code === 'network');
  await assert.rejects(loadBoard({ base: BASE, fetch: fakeFetch({ 'https://example.test/site/members.json': '<html>' }) }), (e) => e.code === 'members_invalid');
  await assert.rejects(loadBoard({ base: BASE, fetch: fakeFetch({ 'https://example.test/site/members.json': { schema: 2, members: [] } }) }), (e) => e.code === 'members_invalid');
  // 빈 명단은 정상
  const b = await loadBoard({ base: BASE, fetch: fakeFetch({ 'https://example.test/site/members.json': { schema: 1, members: [] } }) });
  assert.deepEqual([b.rows, b.failed, b.members], [[], [], []]);
});

test('loadBoard: 256KB 넘는 gist·네트워크 실패·HTTP 오류도 failed 로 간다', async () => {
  const big = JSON.stringify(payload('big', [entry('claude', { tz: 'x'.repeat(10) })])).replace('"schema"', `"pad":"${'x'.repeat(MAX_BYTES)}","schema"`);
  const fetch = fakeFetch({
    'https://example.test/site/members.json': members([['big', GID(1)], ['net', GID(2)], ['oops', GID(3)], ['ok', GID(4)]]),
    [rawKey('big', GID(1))]: big,
    [rawKey('net', GID(2))]: () => { throw new TypeError('fetch failed'); },
    [rawKey('oops', GID(3))]: () => new Response('err', { status: 502 }),
    [rawKey('ok', GID(4))]: payload('ok', [entry('claude')]),
  });
  const b = await loadBoard({ base: BASE, fetch });
  assert.deepEqual(Object.fromEntries(b.failed.map((f) => [f.login, f.reason])), { big: 'too_large', net: 'network', oops: 'http_error' });
  assert.deepEqual(b.rows.map((r) => r.login), ['ok']);
});

test('loadBoard: 동시 요청 수 한도를 지킨다(그리고 실제로 그만큼 나란히 받는다)', async () => {
  const list = Array.from({ length: 20 }, (_, i) => [`u${i}`, GID(i + 1)]);
  const routes = { 'https://example.test/site/members.json': members(list) };
  for (const [login, gist] of list) routes[rawKey(login, gist)] = payload(login, [entry('claude')]);

  const f3 = fakeFetch(routes, { delay: 15 });
  const b3 = await loadBoard({ base: BASE, fetch: f3, concurrency: 3 });
  assert.equal(f3.max(), 3);
  assert.equal(b3.rows.length, 20);
  assert.deepEqual(b3.rows.map((r) => r.login), list.map(([l]) => l), '결과 순서는 명단 순서');

  const f8 = fakeFetch(routes, { delay: 15 });
  await loadBoard({ base: BASE, fetch: f8 });
  assert.equal(f8.max(), 8, '기본 한도 8');

  const f1 = fakeFetch(routes, { delay: 2 });
  await loadBoard({ base: BASE, fetch: f1, concurrency: 0 });
  assert.equal(f1.max(), 1, '0 이하도 최소 1개씩은 받는다');
});

// ── validatePayload ─────────────────────────────────────────────────────
test('validatePayload: 빠져도 되는 칸은 채우고, 숫자가 아닌 값은 어디에 있든 거절한다', () => {
  const min = { schema: 1, login: 'min', entries: [{ tool: 'codex', totals: { input: 1, output: 2, cacheWrite: 0, cacheRead: 3, total: 6, cost: 0.01 } }] };
  const ok = validatePayload(min, { login: 'MIN' });
  assert.equal(ok.updatedAt, null);
  assert.deepEqual(ok.entries[0].range, { from: null, to: null, activeDays: 0 });
  assert.equal(ok.entries[0].split, null);
  assert.deepEqual(ok.entries[0].byDay, {});

  const withDay = (byDay) => ({ ...min, entries: [{ ...min.entries[0], byDay }] });
  const reason = (doc) => { try { validatePayload(doc); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(reason(withDay({ '2026-10-14': [1, 2, 3] })), 'ok');
  assert.equal(reason(withDay({ '2026-10-14': [1, null, 3] })), 'bad_entries');
  assert.equal(reason(withDay({ '2026-10-14': [1, 2] })), 'bad_entries');
  assert.equal(reason(withDay({ 'yesterday': [1, 2, 3] })), 'bad_entries');
  assert.equal(reason(withDay({ '2026-10-14': 5 })), 'bad_entries');
  assert.equal(reason({ ...min, entries: [{ ...min.entries[0], byModel: { m: { total: -1 } } }] }), 'bad_entries');
  assert.equal(reason({ ...min, entries: [{ ...min.entries[0], byModel: { m: { total: 1, note: 'hi' } } }] }), 'bad_entries');
  assert.equal(reason({ ...min, entries: [{ ...min.entries[0], sessions: 'NaN' }] }), 'bad_entries');
  assert.equal(reason({ ...min, entries: [{ ...min.entries[0], tool: 'cursor' }] }), 'bad_entries');
  assert.equal(reason({ ...min, entries: [{ ...min.entries[0], totals: { ...min.entries[0].totals, cost: Number.NaN } }] }), 'bad_entries');
  assert.equal(reason({ ...min, app: 'other' }), 'bad_schema');
  assert.equal(reason({ ...min, entries: {} }), 'bad_schema');
  assert.equal(reason([]), 'bad_schema');
  assert.throws(() => validatePayload(min, { login: 'someone' }), (e) => e.code === 'login_mismatch');
});

// ── measure · periodRange ───────────────────────────────────────────────
// 2026-10-14 는 수요일. 이번 주 = 10/12(월) ~ 10/18(일). 날짜마다 2의 거듭제곱을 넣어 합만 보고도 어느 날이 들어갔는지 안다.
const DAYS = {
  '2026-09-28': [1, 1, 0.01], '2026-09-30': [2, 2, 0.02], '2026-10-01': [4, 4, 0.04],
  '2026-10-11': [8, 8, 0.08], '2026-10-12': [16, 16, 0.16], '2026-10-14': [32, 32, 0.32],
  '2026-10-18': [64, 64, 0.64], '2026-10-19': [128, 128, 1.28], '2026-10-31': [256, 256, 2.56],
  '2026-11-01': [512, 512, 5.12],
};
const E = { tool: 'claude', totals: { total: 9999, output: 999, cost: 99.99 }, byDay: DAYS };
const at = (y, mo, d, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);   // 보는 사람(이 프로세스) 시간대의 벽시계
const all4 = (now, unit = 'total') => Object.fromEntries(['all', 'today', 'week', 'month'].map((p) => [p, measure(E, p, unit, { now })]));

test('measure: 보는 사람 달력으로 오늘·이번 주(월요일 시작)·이번 달을 자른다', () => {
  assert.deepEqual(all4(at(2026, 10, 14)), { all: 9999, today: 32, week: 16 + 32 + 64, month: 4 + 8 + 16 + 32 + 64 + 128 + 256 });
  // 월요일 0시 — 그날부터 새 주
  assert.deepEqual(all4(at(2026, 10, 12, 0, 0, 0)).week, 112);
  assert.equal(all4(at(2026, 10, 12, 0, 0, 0)).today, 16);
  // 일요일 23:59:59 — 아직 같은 주
  assert.equal(all4(at(2026, 10, 18, 23, 59, 59)).week, 112);
  assert.equal(all4(at(2026, 10, 18, 23, 59, 59)).today, 64);
  // 다음 월요일 0시 — 새 주
  assert.equal(all4(at(2026, 10, 19, 0, 0, 0)).week, 128);
  // 달이 바뀌는 주: 10/1(목)의 이번 주는 9/28 ~ 10/4, 이번 달은 10/1부터
  assert.deepEqual(all4(at(2026, 10, 1, 0, 0, 0)), { all: 9999, today: 4, week: 1 + 2 + 4, month: 508 });
  // 9월 30일 밤 — 아직 9월
  assert.equal(all4(at(2026, 9, 30, 23, 59, 59)).month, 1 + 2);
  // 출력·환산 단위는 byDay 의 둘째·셋째 칸, 금액은 센트로 맞춘다
  assert.equal(measure(E, 'week', 'output', { now: at(2026, 10, 14) }), 112);
  assert.equal(measure(E, 'week', 'cost', { now: at(2026, 10, 14) }), 1.12);
  assert.equal(measure(E, 'all', 'cost'), 99.99);
  assert.equal(measure({ byDay: { '2026-10-14': [0, 0, 0.1], '2026-10-15': [0, 0, 0.2] } }, 'week', 'cost', { now: at(2026, 10, 14) }), 0.3);
  // 기록이 비어 있으면 0
  assert.equal(measure({}, 'today', 'total'), 0);
  assert.equal(measure({}, 'all', 'total'), 0);
  assert.throws(() => measure(E, 'year', 'total'));
  assert.throws(() => measure(E, 'all', 'tokens'));
});

test('periodRange: 연말·윤년 경계', () => {
  assert.equal(periodRange('all'), null);
  assert.deepEqual(periodRange('week', { now: at(2027, 1, 1) }), { from: '2026-12-28', to: '2027-01-03' });
  assert.deepEqual(periodRange('month', { now: at(2027, 1, 1) }), { from: '2027-01-01', to: '2027-01-31' });
  assert.deepEqual(periodRange('month', { now: at(2028, 2, 10) }), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(periodRange('today', { now: at(2026, 10, 14, 0, 0, 1) }), { from: '2026-10-14', to: '2026-10-14' });
  assert.deepEqual(periodRange('week', { now: at(2026, 10, 18, 23, 0) }), { from: '2026-10-12', to: '2026-10-18' });
});

test('staleDays: 보는 사람 달력으로 며칠 전에 올렸는지', () => {
  const now = at(2026, 10, 14, 8, 0);
  assert.equal(staleDays(at(2026, 10, 14, 0, 1).toISOString(), { now }), 0);
  assert.equal(staleDays(at(2026, 10, 13, 23, 0).toISOString(), { now }), 1);
  assert.equal(staleDays(at(2026, 10, 4, 9, 0).toISOString(), { now }), 10);
  assert.equal(staleDays(at(2026, 10, 15, 9, 0).toISOString(), { now }), 0, '미래 시각은 0');
  assert.equal(staleDays('nope', { now }), null);
  assert.equal(staleDays(null, { now }), null);
});

// ── rank ────────────────────────────────────────────────────────────────
const R = (login, tool, total, cost = 0, updatedAt = '2026-10-14T00:00:00Z') => ({
  login, tool, updatedAt, entry: { tool, totals: { total, output: total / 10, cost }, byDay: {} },
});

test('rank: 큰 값부터, 같은 값은 같은 순위(1, 1, 3), 사람별 합도 낸다', () => {
  const rows = [R('carol', 'claude', 130), R('bob', 'gemini', 100), R('alice', 'codex', 30, 0, '2026-10-14T09:00:00Z'), R('alice', 'claude', 100)];
  const { rows: rr, people } = rank(rows, 'all', 'total');
  assert.deepEqual(rr.map((r) => [r.login, r.tool, r.value, r.rank]), [
    ['carol', 'claude', 130, 1], ['alice', 'claude', 100, 2], ['bob', 'gemini', 100, 2], ['alice', 'codex', 30, 4],
  ]);
  assert.deepEqual(people.map((p) => [p.login, p.value, p.rank, p.tools]), [
    ['alice', 130, 1, ['claude', 'codex']], ['carol', 130, 1, ['claude']], ['bob', 100, 3, ['gemini']],
  ]);
  assert.equal(people[0].updatedAt, '2026-10-14T09:00:00Z', '사람의 기준 시각은 가장 늦은 것');
  assert.equal(people[0].rows.length, 2);
  // 원본 줄은 건드리지 않는다
  assert.equal(rows[0].rank, undefined);
});

test('rank: 대소문자만 다른 login 은 한 사람, 금액의 부동소수 꼬리는 같은 값으로 본다', () => {
  const rows = [R('Min', 'claude', 0, 0.1), R('min', 'codex', 0, 0.2), R('zed', 'claude', 0, 0.3)];
  const { rows: rr, people } = rank(rows, 'all', 'cost');
  assert.equal(people.length, 2);
  assert.deepEqual(people.map((p) => [p.login.toLowerCase(), p.value, p.rank]), [['min', 0.3, 1], ['zed', 0.3, 1]]);
  assert.deepEqual(rr.map((r) => r.rank), [1, 2, 3]);
  assert.deepEqual(rank([], 'week', 'total'), { rows: [], people: [] });
});

test('summarize: 사람마다 기간 4 × 단위 3, 이번 주 총 토큰 순', () => {
  const now = at(2026, 10, 14);
  const board = {
    fetchedAt: '2026-10-14T03:00:00.000Z', failed: [{ login: 'x', reason: 'not_found', detail: null }],
    rows: [
      { login: 'a', tool: 'claude', updatedAt: '2026-10-13T00:00:00Z', entry: { totals: { total: 1000, output: 100, cost: 10 }, byDay: { '2026-10-14': [5, 1, 0.1] } } },
      { login: 'b', tool: 'codex', updatedAt: '2026-10-14T00:00:00Z', entry: { totals: { total: 10, output: 1, cost: 0.1 }, byDay: { '2026-10-13': [7, 2, 0.2], '2026-10-14': [3, 1, 0.1] } } },
    ],
  };
  const s = summarize(board, { now });
  assert.deepEqual(s.people.map((p) => [p.login, p.rank, p.total.week]), [['b', 1, 10], ['a', 2, 5]]);
  assert.deepEqual(s.people[0].cost, { all: 0.1, today: 0.1, week: 0.3, month: 0.3 });
  assert.deepEqual(s.people[1].total, { all: 1000, today: 5, week: 5, month: 5 });
});

// ── 로컬 서버 · CLI ─────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

/** routes(경로 → 본문) 먼저, 없으면 dir 아래 파일. 127.0.0.1 의 아무 포트. */
function serve({ routes = {}, dir = null } = {}) {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p in routes) {
      res.writeHead(200, { 'content-type': MIME['.json'], 'access-control-allow-origin': '*' });
      return res.end(typeof routes[p] === 'string' ? routes[p] : JSON.stringify(routes[p]));
    }
    if (dir) {
      const rel = p.endsWith('/') ? p + 'index.html' : p;
      const file = path.join(dir, path.normalize(rel).replace(/^([/\\])+/, ''));
      if (file.startsWith(dir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        return res.end(fs.readFileSync(file));
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    resolve({ origin: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) });
  }));
}

// CLI 자식 프로세스에 끼우는 preload: gist 주소만 로컬 서버로 돌리고, 바깥 주소는 막는다
function writePreload() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-board-'));
  const file = path.join(dir, 'route-fetch.mjs');
  fs.writeFileSync(file, `
const real = globalThis.fetch;
const local = process.env.TM_TEST_ORIGIN;
globalThis.fetch = (url, init) => {
  const u = String(url);
  if (u.startsWith('https://gist.githubusercontent.com/')) return real(local + '/gist/' + u.slice('https://gist.githubusercontent.com/'.length), init);
  if (u.startsWith(local + '/')) return real(u, init);
  return Promise.reject(new TypeError('시험 중 바깥 주소 차단: ' + u));
};
`);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function runCli(args, { origin, preload, tz }) {
  const env = { ...process.env, TM_TEST_ORIGIN: origin, TZ: tz };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', pathToFileURL(preload).href, BOARD, ...args], { env, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

test('CLI: node docs/board.mjs --json 은 앱이 읽는 꼴 하나를 찍고, 기간은 보는 사람 시간대로 자른다', async () => {
  const day = { '2026-10-12': [100, 10, 1], '2026-10-13': [1000, 100, 10], '2026-10-14': [10000, 1000, 100] };
  const srv = await serve({
    routes: {
      '/site/members.json': members([['alice', GID(1)], ['Bob', GID(2)], ['ghost', GID(3)]]),
      [`/gist/alice/${GID(1)}/raw/token-meter.json`]: payload('alice', [
        entry('claude', { byDay: day, totals: { input: 0, output: 1110, cacheWrite: 0, cacheRead: 0, total: 11110, cost: 111, messages: 3 } }),
        entry('codex', { byDay: { '2026-10-13': [5, 1, 0.05] } }),
      ]),
      [`/gist/Bob/${GID(2)}/raw/token-meter.json`]: payload('bob', [entry('gemini', { byDay: { '2026-10-14': [20000, 1, 0.5] } })], { updatedAt: '2026-10-10T00:00:00Z' }),
    },
  });
  const pre = writePreload();
  try {
    const base = `${srv.origin}/site/`;
    // 2026-10-13 16:30 UTC = 서울 10/14 01:30, 로스앤젤레스 10/13 09:30
    const seoul = await runCli(['--json', '--base', base, '--now', '2026-10-13T16:30:00Z'], { origin: srv.origin, preload: pre.file, tz: 'Asia/Seoul' });
    assert.equal(seoul.code, 0, seoul.stderr);
    const lines = seoul.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'stdout 에는 JSON 한 줄만');
    const out = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(out).sort(), ['failed', 'fetchedAt', 'ok', 'people']);
    assert.equal(out.ok, true);
    assert.ok(!Number.isNaN(Date.parse(out.fetchedAt)));
    assert.deepEqual(out.failed.map((f) => [f.login, f.reason]), [['ghost', 'not_found']]);
    for (const p of out.people) {
      assert.deepEqual(Object.keys(p).sort(), ['cost', 'login', 'output', 'rank', 'tools', 'total', 'updatedAt']);
      for (const u of ['total', 'output', 'cost']) assert.deepEqual(Object.keys(p[u]).sort(), ['all', 'month', 'today', 'week']);
    }
    // 이번 주(서울): alice 100+1000+10000+5 = 11105, Bob 20000 → Bob 1위
    assert.deepEqual(out.people.map((p) => [p.login, p.rank, p.tools, p.total.week, p.total.today]), [
      ['Bob', 1, ['gemini'], 20000, 20000], ['alice', 2, ['claude', 'codex'], 11105, 10000],
    ]);
    assert.equal(out.people[0].updatedAt, '2026-10-10T00:00:00.000Z', '기준 시각은 표준 ISO 꼴로 다시 쓴다');
    assert.equal(out.people[1].total.all, 11110 + 100);
    assert.equal(out.people[1].cost.week, 111.05);

    // 같은 순간, 로스앤젤레스에서 보면 아직 10/13 — 오늘 값이 다르다
    const la = await runCli(['--json', '--base', base, '--now', '2026-10-13T16:30:00Z'], { origin: srv.origin, preload: pre.file, tz: 'America/Los_Angeles' });
    assert.equal(la.code, 0, la.stderr);
    const outLa = JSON.parse(la.stdout);
    assert.deepEqual(outLa.people.map((p) => [p.login, p.total.today]), [['Bob', 0], ['alice', 1005]]);

    // 사람이 읽는 표도 깨지지 않는다
    const human = await runCli(['--base', base], { origin: srv.origin, preload: pre.file, tz: 'Asia/Seoul' });
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /alice/);
    assert.match(human.stdout, /ghost\(not_found\)/);

    // 명단이 없으면 ok:false 와 code, 종료 코드 1
    const miss = await runCli(['--json', '--base', `${srv.origin}/nowhere/`], { origin: srv.origin, preload: pre.file, tz: 'Asia/Seoul' });
    assert.equal(miss.code, 1);
    const err = JSON.parse(miss.stdout);
    assert.equal(err.ok, false);
    assert.equal(err.error.code, 'members_missing');
    assert.equal(typeof err.error.message, 'string');
  } finally {
    pre.cleanup();
    await srv.close();
  }
});

test('모듈을 import 만 하면 CLI 가 돌지 않는다', async () => {
  // 이 시험 파일이 이미 import 했다 — CLI 가 돌았다면 DEFAULT_BASE 로 실제 요청을 보내고 stdout 에 JSON 을 찍었을 것
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-import-'));
  try {
    const file = path.join(dir, 'imp.mjs');
    fs.writeFileSync(file, `globalThis.fetch = () => { throw new Error('불리면 안 됨'); };\nawait import(${JSON.stringify(pathToFileURL(BOARD).href)});\nsetTimeout(() => console.log('quiet'), 50);\n`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = await new Promise((resolve) => execFile(process.execPath, [file], { env }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr })));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'quiet');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 사이트 ──────────────────────────────────────────────────────────────
test('사이트: docs/ 를 로컬에서 띄우면 index.html 의 모듈 import 가 board.mjs 로 풀린다', async () => {
  const srv = await serve({ dir: DOCS, routes: { '/members.json': { schema: 1, members: [] } } });
  try {
    const res = await fetch(`${srv.origin}/`);
    assert.equal(res.status, 200);
    const html = await res.text();

    // 서버 시절 흔적이 없어야 한다
    for (const gone of ['/api/', '/auth/', 'submission.json', ':8787', '--submit', '--token']) assert.ok(!html.includes(gone), `${gone} 가 남아 있다`);
    // 남아야 하는 것: 기간·단위·언어·상세·이만큼이면·참가하기·개인정보 링크
    for (const keep of ['누적', '오늘', '이번 주', '이번 달', '총 토큰', '출력 토큰', 'API 환산', 'English', '이만큼이면', '참가하기',
      'collect.mjs --publish', 'gh auth login', 'issues/new?template=join.yml', 'privacy.html']) assert.ok(html.includes(keep), `${keep} 가 없다`);

    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    const modules = scripts.filter((m) => /type=["']module["']/.test(m[1]));
    assert.equal(modules.length, 1, '모듈 스크립트 하나');
    assert.equal(scripts.length, 1, '다른 스크립트 없음');
    const imports = [...modules[0][2].matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)];
    assert.ok(imports.length >= 1);
    for (const [, names, spec] of imports) {
      const url = new URL(spec, `${srv.origin}/`);
      const r = await fetch(url);
      assert.equal(r.status, 200, `${spec} 를 받지 못함`);
      assert.match(r.headers.get('content-type'), /javascript/);
      const mod = await import(pathToFileURL(path.join(DOCS, url.pathname)).href);
      for (const n of names.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        assert.equal(typeof mod[n], 'function', `${spec} 에 ${n} 이 없음`);
      }
    }

    // 개인정보 안내 · .nojekyll
    const pr = await fetch(`${srv.origin}/privacy.html`);
    assert.equal(pr.status, 200);
    const privacy = await pr.text();
    for (const keep of ['gist', 'token-meter.json', 'byDay', 'template=leave.yml', 'English', '수집하지 않습니다', 'collect nothing']) {
      assert.ok(privacy.includes(keep), `privacy.html 에 ${keep} 가 없다`);
    }
    assert.equal(fs.statSync(path.join(DOCS, '.nojekyll')).size, 0);
  } finally { await srv.close(); }
});

// ── 검토에서 찾은 구멍들(회귀 시험) ──────────────────────────────────────
const reasonOf = (doc, login) => { try { validatePayload(doc, { login }); return 'ok'; } catch (e) { return e.code; } };
const one = (over = {}, top = {}) => ({ schema: 1, login: 'min', ...top, entries: [{ ...entry('claude'), ...over }] });

test('검토: 유한하지만 터무니없이 큰 숫자는 거절한다 — 더해서 Infinity → JSON null 이 되어 앱이 순위판을 못 읽던 문제', async () => {
  const huge = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 1e308, cost: 1e307, messages: 0 };
  assert.equal(reasonOf(one({ totals: huge })), 'bad_entries');
  assert.equal(reasonOf(one({ byDay: { '2026-10-13': [1e308, 0, 0], '2026-10-14': [1e308, 0, 0] } })), 'bad_entries');
  assert.equal(reasonOf(one({ sessions: Number.MAX_SAFE_INTEGER + 2 })), 'bad_entries');
  assert.equal(reasonOf(one({ sessions: Number.MAX_SAFE_INTEGER })), 'ok', '상한 그 자체는 받는다');
  try { validatePayload(one({ totals: huge })); } catch (e) { assert.match(e.message, /너무 큼/); }

  // 상한 안의 값끼리는 아무리 더해도 유한하다 — 앱이 읽는 JSON 에 null 이 생기지 않는다
  const M = Number.MAX_SAFE_INTEGER;
  const big = { input: M, output: M, cacheWrite: M, cacheRead: M, total: M, cost: M, messages: M };
  const fetch = fakeFetch({
    'https://example.test/site/members.json': members([['a', GID(1)], ['b', GID(2)], ['c', GID(3)]]),
    [rawKey('a', GID(1))]: payload('a', ['claude', 'codex', 'gemini'].map((t) => entry(t, { totals: big, byDay: { '2026-10-13': [M, M, M], '2026-10-14': [M, M, M] } }))),
    [rawKey('b', GID(2))]: payload('b', [entry('claude', { totals: big, byDay: { '2026-10-14': [M, M, M] } })]),
    [rawKey('c', GID(3))]: payload('c', [entry('claude', { totals: huge })]),
  });
  const board = await loadBoard({ base: BASE, fetch });
  assert.deepEqual(board.failed.map((f) => [f.login, f.reason]), [['c', 'bad_entries']]);
  const out = summarize(board, { now: at(2026, 10, 14) });
  const nums = [];
  JSON.parse(JSON.stringify(out), (k, v) => { if (typeof v === 'number' || v === null) nums.push(v); return v; });
  assert.ok(nums.length > 0 && nums.every((v) => typeof v === 'number' && Number.isFinite(v)), 'JSON 의 숫자 칸은 모두 유한한 숫자');
});

test('검토: 시각 칸은 표준 ISO 로 다시 써서 넘긴다 — Date.parse 가 받아 주는 아무 글이 앱·사이트로 새지 않게', () => {
  const v = validatePayload(one({ generatedAt: '홍길동 2026' }, { updatedAt: 'hello 2020' }));
  assert.match(v.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(v.entries[0].generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(!JSON.stringify(v).includes('홍길동') && !JSON.stringify(v).includes('hello'));
  // 이미 표준 꼴이면 같은 값
  assert.equal(validatePayload(one({}, { updatedAt: '2026-10-14T02:00:00.000Z' })).updatedAt, '2026-10-14T02:00:00.000Z');
  // 올린 시각이 없으면 기록의 수집 시각 중 가장 늦은 것(역시 표준 꼴)
  const two = { schema: 1, login: 'min', entries: [entry('claude', { generatedAt: '2026-10-13T01:00:00Z' }), entry('codex', { generatedAt: '2026-10-14T01:00:00+09:00' })] };
  assert.equal(validatePayload(two).updatedAt, '2026-10-13T16:00:00.000Z');
});

test('검토: 시간대는 수집기·참가 검사와 같은 IANA 꼴만 받는다', () => {
  assert.equal(reasonOf(one({ tz: 'America/Argentina/ComodRivadavia' })), 'ok');
  assert.equal(reasonOf(one({ tz: 'Etc/GMT+9' })), 'ok');
  assert.equal(reasonOf(one({ tz: null })), 'ok');
  assert.equal(reasonOf(one({ tz: '<b>x</b>' })), 'bad_entries');
  assert.equal(reasonOf(one({ tz: 'visit my site' })), 'bad_entries');
  assert.equal(reasonOf(one({ tz: 'A'.repeat(65) })), 'bad_entries');
});

test('검토: "__proto__" 라는 모델 이름도 평범한 칸으로 받는다(수집기가 그렇게 올린다) — 원형은 그대로', () => {
  const doc = JSON.parse('{"schema":1,"login":"min","entries":[{"tool":"codex","totals":{"input":1,"output":2,"cacheWrite":0,"cacheRead":3,"total":6,"cost":0},"byModel":{"__proto__":{"total":1},"gpt-5":{"total":5}}}]}');
  const v = validatePayload(doc);
  const bm = v.entries[0].byModel;
  assert.equal(Object.getPrototypeOf(bm), Object.prototype);
  assert.ok(Object.hasOwn(bm, '__proto__'));
  assert.deepEqual(Object.keys(bm), ['__proto__', 'gpt-5']);
  assert.equal(bm.__proto__ === Object.prototype, false);
  assert.equal(({}).total, undefined, 'Object.prototype 이 오염되지 않는다');
  assert.equal(bm['gpt-5'].total, 5);
});

test('검토: 실패 사유 글은 짧게 자르고 제어 문자를 지운다 — 남이 만든 글이 앱·터미널로 그대로 가지 않게', async () => {
  const key = '\u001b]0;pwned\u0007' + 'k'.repeat(5000);
  const fetch = fakeFetch({
    'https://example.test/site/members.json': { schema: 1, members: [
      { login: 'ok', gist: GID(1) }, { login: '\u001b[31mred', gist: GID(2) }, { login: 'x'.repeat(500), gist: GID(3) },
      { login: 'net', gist: GID(4) },
    ] },
    [rawKey('ok', GID(1))]: payload('ok', [entry('claude', { byModel: { m: { total: 1, [key]: 'nope' } } })]),
    // 실행 환경이 만든 오류 글도 그대로 넘기지 않는다(길이·제어 문자)
    [rawKey('net', GID(4))]: () => { throw new TypeError('\u001b[2J' + 'z'.repeat(1000)); },
  });
  const b = await loadBoard({ base: BASE, fetch });
  assert.equal(b.failed.length, 4);
  assert.equal(b.failed.find((f) => f.login === 'net').reason, 'network');
  for (const f of b.failed) {
    assert.ok(!/[\u0000-\u001f\u007f]/.test(f.login), '이름에 제어 문자 없음');
    assert.ok(f.login.length <= 40);
    if (f.detail != null) {
      assert.ok(f.detail.length <= 200, `사유 글이 길다: ${f.detail.length}`);
      assert.ok(!/[\u0000-\u001f\u007f]/.test(f.detail), '사유 글에 제어 문자 없음');
    }
  }
  assert.equal(b.failed.find((f) => f.login === 'ok').reason, 'bad_entries');
});

/** 바이트를 조금씩 내주는 본문(Content-Length 없음). 몇 조각을 꺼내 갔는지 센다. */
function drip(total, chunk = 64 * 1024) {
  const st = { pulled: 0, cancelled: false };
  let sent = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (sent >= total) return c.close();
      const n = Math.min(chunk, total - sent);
      sent += n; st.pulled++;
      c.enqueue(new TextEncoder().encode(' '.repeat(n)));
    },
    cancel() { st.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, st };
}

test('검토: 크기 상한은 받으면서 센다 — Content-Length 가 없어도 256KB 를 넘으면 그 자리에서 끊는다', async () => {
  const huge = drip(50 * 1024 * 1024);               // 50MB 를 흘리는 gist
  const lying = drip(10 * 1024 * 1024);              // Content-Length 는 작다고 우기는 gist
  const declared = drip(10 * 1024 * 1024);           // 크다고 미리 밝힌 gist — 본문을 받지 않고 닫는다
  const small = JSON.stringify(payload('fine', [entry('claude')]));
  const fetch = fakeFetch({
    'https://example.test/site/members.json': members([['huge', GID(1)], ['lying', GID(2)], ['declared', GID(3)], ['fine', GID(4)]]),
    [rawKey('huge', GID(1))]: () => new Response(huge.stream, { status: 200 }),
    [rawKey('lying', GID(2))]: () => new Response(lying.stream, { status: 200, headers: { 'content-length': '100' } }),
    [rawKey('declared', GID(3))]: () => new Response(declared.stream, { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } }),
    // 청크 경계에 한글이 걸려도 깨지지 않는다
    [rawKey('fine', GID(4))]: () => new Response(new ReadableStream({
      start(c) { const bytes = new TextEncoder().encode(small.replace('"Asia/Seoul"', '"Asia/Seoul","memo":"가나다"')); for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); },
    }), { status: 200 }),
  });
  const b = await loadBoard({ base: BASE, fetch });
  assert.deepEqual(Object.fromEntries(b.failed.map((f) => [f.login, f.reason])), { huge: 'too_large', lying: 'too_large', declared: 'too_large' });
  assert.deepEqual(b.rows.map((r) => r.login), ['fine']);
  assert.ok(huge.st.pulled <= 6, `50MB 중 상한 근처까지만 꺼내야 한다(꺼낸 조각 ${huge.st.pulled})`);
  assert.ok(huge.st.cancelled, '넘으면 본문을 닫는다');
  assert.ok(lying.st.pulled <= 6);
  assert.equal(declared.st.pulled, 0, '크다고 밝힌 본문은 한 조각도 꺼내지 않는다');
  assert.ok(declared.st.cancelled);
});

// ── 사이트 그리기(가짜 DOM) ───────────────────────────────────────────────
// index.html 의 모듈 스크립트를 꺼내 board.mjs import 만 바꿔 끼우고, 아주 작은 가짜 DOM 에서 돌려 그려진 HTML 을 본다.
async function renderSite(board, { open = null } = {}) {
  const vm = await import('node:vm');
  const mod = await import('../docs/board.mjs');
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  const src = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const imp = /import\s*\{([^}]*)\}\s*from\s*"\.\/board\.mjs";/;
  assert.match(src, imp);
  const body = src.replace(imp, (_, names) => `const {${names}} = __board;`);
  let inner = '';
  const handlers = {};
  const root = { set innerHTML(v) { inner = v; }, get innerHTML() { return inner; }, contains: () => false, querySelector: () => null };
  const ctx = vm.createContext({
    __board: { ...mod, loadBoard: async () => board },
    document: { getElementById: () => root, addEventListener: (t, f) => { handlers[t] = f; }, documentElement: {}, title: '', activeElement: null, body: {} },
    navigator: { language: 'ko-KR', platform: 'MacIntel', userAgent: '' },
    localStorage: { getItem: () => null, setItem() {} },
    location: { href: 'https://example.test/site/' },
    CSS: { escape: (s) => s },
    URL, console,
  });
  vm.runInContext(body, ctx);
  for (let i = 0; i < 5 && !inner.includes('class="rows"'); i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
  if (open) handlers.click({ target: { closest: (sel) => (sel === '[data-open]' ? { dataset: { open } } : null) } });
  return inner;
}

test('검토(사이트): 시각이 없는 gist 를 1970년으로 그리지 않고, 남이 정한 글자는 모두 이스케이프한다', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  // 시각 칸이 하나도 없는 gist 도 형식상 통과한다(참가 검사도 통과)
  const v = validatePayload({ schema: 1, login: 'mallory', entries: [{ tool: 'claude', totals: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, total: 2, cost: 0 }, byModel: { [evil]: { total: 2 } }, byDay: { '2026-10-14': [2, 1, 0] } }] });
  assert.equal(v.updatedAt, null);
  const rows = v.entries.map((e) => ({ login: 'mallory', tool: e.tool, entry: e, updatedAt: v.updatedAt, gist: GID(1) }));
  const board = {
    fetchedAt: '2026-10-14T03:00:00.000Z',
    members: [{ login: 'mallory', gist: GID(1) }, { login: 'dup', gist: GID(2) }],
    rows,
    failed: [{ login: evil, reason: 'bad_member', detail: null }, { login: 'DUP', reason: 'duplicate_member', detail: null }, { login: 'gone', reason: '<b>zz', detail: null }],
  };
  const out = await renderSite(board, { open: 'mallory|claude' });
  assert.match(out, /class="detail"/, '상세 패널이 열렸다');
  assert.ok(!out.includes('1970'), '시각이 없으면 1970년이 아니라 — 로');
  assert.match(out, /— 기준/);
  assert.ok(!out.includes('<img src=x'), '모델 이름·실패 목록의 HTML 은 이스케이프');
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!out.includes('<b>zz'));
  // 두 번 적힌 줄은 같은 아이디의 다른 줄 gist 로 잘못 링크하지 않는다
  assert.ok(!out.includes(`gist.github.com/DUP/${GID(2)}`));
});

test('검토(사이트): 띄어쓰기 없는 긴 모델 이름·시간대가 모바일 화면을 가로로 밀지 않게 줄 안에서 끊는다', () => {
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  const rule = (sel) => { const m = html.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')}\\{([^}]*)\\}`)); return m ? m[1] : ''; };
  assert.match(rule('.meta'), /overflow-wrap:anywhere/);
  assert.match(rule('.dlinks>*'), /overflow-wrap:anywhere/);
  assert.match(rule('.failnote'), /overflow-wrap:anywhere/);
});
