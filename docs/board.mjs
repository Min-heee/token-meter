#!/usr/bin/env node
/**
 * 토큰 계량기 — 순위판 공용 모듈 (사이트 · 맥 앱 · CLI 가 같이 쓴다)
 *
 * 서버가 없다. 참가자 명단(members.json)을 읽고, 명단에 있는 사람마다 그 사람 계정의
 * 공개 gist(token-meter.json)를 직접 받아 순위를 낸다. 의존성 없음 — 브라우저와 Node 20+ 둘 다.
 *
 * 남의 gist는 믿지 않는다: 형식·계정·숫자를 검사하고, 통과한 칸만 화이트리스트로 옮겨 담는다.
 * 깨진 gist 하나가 순위판 전체를 깨뜨리지 않도록, 실패는 failed 목록으로만 보낸다.
 *
 * 기간(오늘·이번 주·이번 달)은 "보는 사람"의 달력으로 자른다(주는 월요일 시작).
 * byDay 의 날짜 키는 올린 사람의 시간대 날짜다 — 다시 계산할 근거(시각)가 없으므로 그대로 쓴다.
 * 그래서 시간대가 다른 사람끼리는 하루 경계가 몇 시간 어긋날 수 있다.
 *
 * 사용법 (맥 앱이 번들째로 부른다):
 *   node docs/board.mjs --json                 # { ok, fetchedAt, failed, people } — 이번 주 총 토큰 순
 *   node docs/board.mjs                        # 사람이 읽는 표
 *   node docs/board.mjs --json --base <url>    # 다른 사이트 폴더(members.json 이 있는 곳)
 *   node docs/board.mjs --json --now <ISO>     # 기준 시각 고정(시험용)
 */

// ── 상수 ────────────────────────────────────────────────────────────────
export const DEFAULT_BASE = 'https://min-heee.github.io/token-meter/';
export const GIST_RAW = 'https://gist.githubusercontent.com/';
export const FILE_NAME = 'token-meter.json';
export const TOOLS = ['claude', 'codex', 'gemini'];
export const PERIODS = ['all', 'today', 'week', 'month'];
export const UNITS = ['total', 'output', 'cost'];

export const MAX_MEMBERS = 2000;
export const MAX_BYTES = 256 * 1024;
const MAX_MEMBERS_BYTES = 4 * 1024 * 1024;   // 2000명 명단은 200KB 남짓 — 넉넉히
const MAX_MODELS = 100;
const TIMEOUT_MS = 15000;

const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;   // GitHub 아이디: 영숫자·하이픈 39자까지 — URL 에 그대로 넣으므로 엄격하게
const GIST_RE = /^[0-9a-f]{5,64}$/i;                  // gist id: 16진수(요즘 것은 32자)
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;             // 수집기·참가 검사와 같은 규칙(IANA 이름 꼴)
const CTRL_RE = /[\u0000-\u001f\u007f]/g;
// 숫자 상한: 정수로 정확히 셀 수 있는 가장 큰 수. 실제 사용량은 이 근처에도 못 간다.
// 상한이 없으면 1e308 같은 값 둘이 더해져 Infinity 가 되고, JSON 에서는 null 로 바뀌어 앱이 순위판 전체를 못 읽는다.
const MAX_NUM = Number.MAX_SAFE_INTEGER;
const MAX_DETAIL = 200;                               // failed 사유 글 길이 — 남이 만든 글이 섞이므로 짧게
const TOTAL_KEYS = ['input', 'output', 'cacheWrite', 'cacheRead', 'total', 'cost'];
const MODEL_KEYS = [...TOTAL_KEYS, 'messages'];
const UNIT_INDEX = { total: 0, output: 1, cost: 2 };   // byDay 값 = [총 토큰, 출력 토큰, API 환산]

/** 실패 사유 코드. 사이트가 이 코드로 사람 말을 고른다. */
export class BoardError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// ── 작은 도구 ───────────────────────────────────────────────────────────
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_NUM;
const cents = (n) => Math.round(n * 100) / 100;        // 수집기가 센트로 반올림해 올린다 — 더할 때 생기는 0.1+0.2 꼬리 제거
const lower = (s) => String(s).toLowerCase();
const timeOf = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const isIso = (v) => typeof v === 'string' && v.length <= 40 && timeOf(v) != null;
// Date.parse 는 '홍길동 2026' 같은 글도 시각으로 읽는다 — 받은 글을 그대로 넘기지 않고 표준 꼴로 다시 쓴다
const isoOf = (v) => new Date(timeOf(v)).toISOString();
const byteLength = (s) => new TextEncoder().encode(s).length;
// 남이 만든 글을 사유·이름으로 내보낼 때: 제어 문자(터미널 조작 등)를 지우고 길이를 자른다
const clip = (s, n) => String(s).replace(CTRL_RE, '?').slice(0, n);

function bad(where, what) { throw new BoardError('bad_entries', `${where}: ${what}`); }

/** 꼭 있어야 하는 숫자 — 유한하고 0 이상, 상한 이하 */
function need(v, where) {
  if (!isNum(v)) {
    bad(where, v === undefined ? '없음' : typeof v === 'number' && v > MAX_NUM ? '너무 큼' : `숫자가 아님(${clip(v, 20)})`);
  }
  return v;
}
/** 없어도 되는 숫자 — 없으면 기본값, 있으면 need 와 같은 검사 */
const opt = (v, where, d = 0) => (v === undefined || v === null ? d : need(v, where));

// 보는 사람 달력의 YYYY-MM-DD. toLocaleDateString 은 환경마다 꼴이 달라 직접 만든다.
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ── gist 검사 ───────────────────────────────────────────────────────────
/**
 * 기록 한 줄을 화이트리스트로 옮겨 담는다. 모르는 칸(이름·프로젝트·경로 등)은 버리고,
 * 아는 칸의 숫자가 이상하면(음수·무한대·문자열) 기록 전체를 거절한다.
 */
function cleanEntry(e, i) {
  const at = `entries[${i}]`;
  if (!isObj(e)) bad(at, '객체가 아님');
  if (!TOOLS.includes(e.tool)) bad(`${at}.tool`, `모르는 도구(${clip(e.tool, 20)})`);
  if (!isObj(e.totals)) bad(`${at}.totals`, '없음');

  const totals = {};
  for (const k of TOTAL_KEYS) totals[k] = need(e.totals[k], `${at}.totals.${k}`);
  totals.messages = opt(e.totals.messages, `${at}.totals.messages`);

  const r = e.range === undefined || e.range === null ? {} : e.range;
  if (!isObj(r)) bad(`${at}.range`, '객체가 아님');
  for (const k of ['from', 'to']) {
    if (r[k] != null && !(typeof r[k] === 'string' && DAY_RE.test(r[k]))) bad(`${at}.range.${k}`, '날짜 꼴이 아님');
  }

  if (e.generatedAt != null && !isIso(e.generatedAt)) bad(`${at}.generatedAt`, '시각 꼴이 아님');
  // 시간대 이름은 화면에 글자로 나간다 — 띄어쓰기 없는 긴 글로 모바일 화면을 밀어내지 못하게 IANA 꼴만
  if (e.tz != null && !(typeof e.tz === 'string' && TZ_RE.test(e.tz))) bad(`${at}.tz`, '시간대 꼴이 아님');

  let split = null;
  if (e.split != null) {
    if (!isObj(e.split)) bad(`${at}.split`, '객체가 아님');
    split = { main: opt(e.split.main, `${at}.split.main`), sub: opt(e.split.sub, `${at}.split.sub`) };
  }

  if (e.byModel != null && !isObj(e.byModel)) bad(`${at}.byModel`, '객체가 아님');
  const models = Object.entries(e.byModel || {});
  if (models.length > MAX_MODELS) bad(`${at}.byModel`, `모델이 ${MAX_MODELS}개를 넘음`);
  const modelRows = [];
  for (const [name, m] of models) {
    // 모델 이름은 화면에 글자로 나간다 — 길이·제어 문자만 막고 표시할 때 이스케이프한다
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) bad(`${at}.byModel`, '모델 이름이 이상함');
    if (!isObj(m)) bad(`${at}.byModel.${clip(name, 40)}`, '객체가 아님');
    for (const [k, v] of Object.entries(m)) if (!isNum(v)) bad(`${at}.byModel.${clip(name, 40)}.${clip(k, 40)}`, '숫자가 아님');
    const clean = {};
    for (const k of MODEL_KEYS) clean[k] = opt(m[k], `${at}.byModel.${clip(name, 40)}.${k}`);
    modelRows.push([name, clean]);
  }
  // fromEntries 로 만든다: '__proto__' 같은 이름도 원형을 건드리지 않는 평범한 칸이 된다.
  // 수집기도 같은 방식으로 올리므로(그런 이름의 모델을 쓰는 사람도) 거절하지 않는다.
  const byModel = Object.fromEntries(modelRows);

  if (e.byDay != null && !isObj(e.byDay)) bad(`${at}.byDay`, '객체가 아님');
  const byDay = {};
  for (const [day, v] of Object.entries(e.byDay || {})) {
    if (!DAY_RE.test(day)) bad(`${at}.byDay`, `날짜 꼴이 아님(${clip(day, 20)})`);
    if (!Array.isArray(v) || v.length !== 3) bad(`${at}.byDay.${day}`, '[총, 출력, 환산] 꼴이 아님');
    byDay[day] = v.map((x, j) => need(x, `${at}.byDay.${day}[${j}]`));
  }

  const days = Object.keys(byDay).sort();
  return {
    tool: e.tool,
    generatedAt: e.generatedAt == null ? null : isoOf(e.generatedAt),
    tz: e.tz ?? null,
    range: {
      from: r.from ?? days[0] ?? null,
      to: r.to ?? days[days.length - 1] ?? null,
      activeDays: opt(r.activeDays, `${at}.range.activeDays`, days.length),
    },
    totals,
    messages: opt(e.messages, `${at}.messages`, totals.messages),
    sessions: opt(e.sessions, `${at}.sessions`),
    subagents: opt(e.subagents, `${at}.subagents`),
    split,
    byModel,
    byDay,
    estimated: e.estimated === true,
  };
}

/**
 * gist 내용(JSON 을 푼 값)을 검사한다. 통과하면 { login, updatedAt, entries } (깨끗한 사본),
 * 아니면 BoardError(code) 를 던진다. login 을 주면 대소문자 무시하고 맞는지도 본다.
 */
export function validatePayload(doc, { login } = {}) {
  if (!isObj(doc)) throw new BoardError('bad_schema', '객체가 아님');
  if (doc.schema !== 1) throw new BoardError('bad_schema', `schema ${clip(doc.schema, 10)}`);
  if (doc.app !== undefined && doc.app !== 'token-meter') throw new BoardError('bad_schema', 'app 이 token-meter 가 아님');
  if (typeof doc.login !== 'string' || !LOGIN_RE.test(doc.login)) throw new BoardError('bad_schema', 'login 이 없음');
  if (login != null && lower(doc.login) !== lower(login)) {
    throw new BoardError('login_mismatch', `gist 의 login(${doc.login})이 명단(${login})과 다름`);
  }
  if (!Array.isArray(doc.entries)) throw new BoardError('bad_schema', 'entries 가 배열이 아님');
  if (doc.entries.length > TOOLS.length) bad('entries', `${TOOLS.length}개를 넘음`);
  const entries = doc.entries.map(cleanEntry);
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.tool)) bad('entries', `${e.tool} 가 두 번 나옴`);
    seen.add(e.tool);
  }
  // 올린 시각이 이상하면 기록마다의 수집 시각 중 가장 늦은 것으로 대신한다
  const updatedAt = isIso(doc.updatedAt) ? isoOf(doc.updatedAt)
    : entries.map((e) => e.generatedAt).filter(Boolean).sort((a, b) => timeOf(b) - timeOf(a))[0] ?? null;
  return { login: doc.login, updatedAt, entries };
}

/** members.json 검사. 이상한 줄은 버리고 problems 로 돌려준다(명단 전체를 버리지 않는다). */
export function validateMembers(doc) {
  if (!isObj(doc) || doc.schema !== 1 || !Array.isArray(doc.members)) {
    throw new BoardError('members_invalid', 'members.json 형식이 아님');
  }
  const members = [], problems = [], seen = new Set();
  for (const m of doc.members) {
    const login = clip(isObj(m) ? m.login : m, 40);
    if (!isObj(m) || !LOGIN_RE.test(login) || typeof m.gist !== 'string' || !GIST_RE.test(m.gist)) {
      problems.push({ login, reason: 'bad_member' });
      continue;
    }
    if (seen.has(lower(login))) { problems.push({ login, reason: 'duplicate_member' }); continue; }
    if (members.length >= MAX_MEMBERS) { problems.push({ login, reason: 'too_many_members' }); continue; }
    seen.add(lower(login));
    members.push({ login, gist: m.gist, joinedAt: isIso(m.joinedAt) ? m.joinedAt : null });
  }
  return { members, problems };
}

// ── 불러오기 ────────────────────────────────────────────────────────────
const siteBase = (base) => { const s = String(base); return s.endsWith('/') ? s : s + '/'; };
export const gistRawUrl = (login, gist) => `${GIST_RAW}${login}/${gist}/raw/${FILE_NAME}`;

function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

async function get(fetch, url, init, ms) {
  try {
    return await fetch(url, { ...init, signal: timeoutSignal(ms) });
  } catch (e) {
    const slow = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new BoardError(slow ? 'timeout' : 'network', e && e.message);
  }
}

/** 읽지 않을 본문은 닫는다 — 열어 둔 채 버리면 연결이 시간 초과까지 붙잡힌다 */
function cancelBody(res) {
  try { const p = res.body && res.body.cancel && res.body.cancel(); if (p && p.catch) p.catch(() => {}); } catch {}
}

/**
 * 본문을 max 바이트까지만 읽는다. 넘으면 그 자리에서 끊는다 — 참가자가 gist 를 수십 MB 로 바꿔 놓아도
 * 보는 사람마다 그걸 다 받지 않게. Content-Length 가 없거나(청크 전송) 틀려도 실제로 센 바이트로 판단한다.
 */
async function readCapped(res, max) {
  const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  const body = res.body;
  if (declared > max) { cancelBody(res); throw new BoardError('too_large', `${declared} bytes`); }
  try {
    if (!body || typeof body.getReader !== 'function') {
      const text = await res.text();
      if (byteLength(text) > max) throw new BoardError('too_large', `${byteLength(text)} bytes`);
      return text;
    }
    const reader = body.getReader();
    const dec = new TextDecoder();
    let n = 0, text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) {
        try { reader.cancel().catch(() => {}); } catch {}
        throw new BoardError('too_large', `${max} bytes 넘음`);
      }
      text += dec.decode(value, { stream: true });
    }
    return text + dec.decode();
  } catch (e) {
    if (e instanceof BoardError) throw e;
    const slow = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new BoardError(slow ? 'timeout' : 'network', e && e.message);
  }
}

async function fetchGist(fetch, m, ms) {
  const res = await get(fetch, gistRawUrl(m.login, m.gist), {}, ms);
  if (res.status === 404) { cancelBody(res); throw new BoardError('not_found', 'gist 가 없거나 token-meter.json 이 없음'); }
  if (!res.ok) { cancelBody(res); throw new BoardError('http_error', `HTTP ${res.status}`); }
  const text = await readCapped(res, MAX_BYTES);
  let doc;
  try { doc = JSON.parse(text); } catch { throw new BoardError('not_json', 'JSON 이 아님'); }
  return validatePayload(doc, { login: m.login });
}

/** 동시에 limit 개까지만 돌린다. fn 은 던지지 않아야 한다. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * 순위판 데이터를 모은다.
 * → { fetchedAt, members, rows: [{ login, tool, entry, updatedAt, gist }], failed: [{ login, reason, detail }] }
 * members.json 자체를 못 읽으면 BoardError 를 던진다(그건 순위판이 없는 것이므로).
 */
export async function loadBoard({ base = DEFAULT_BASE, fetch = globalThis.fetch, concurrency = 8, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof fetch !== 'function') throw new BoardError('unknown', 'fetch 가 없음');
  // members.json 은 GitHub Pages 가 10분쯤 캐시한다 — 방금 참가한 사람이 바로 보이도록 매번 새로 받는다
  const url = new URL('members.json', siteBase(base));
  url.searchParams.set('t', String(Date.now()));
  const res = await get(fetch, url.href, { cache: 'no-store' }, timeoutMs);
  if (!res.ok) { cancelBody(res); throw new BoardError(res.status === 404 ? 'members_missing' : 'members_http', `members.json HTTP ${res.status}`); }
  let doc;
  const text = await readCapped(res, MAX_MEMBERS_BYTES).catch((e) => {
    throw e.code === 'too_large' ? new BoardError('members_invalid', `members.json 이 너무 큼(${e.message})`) : e;
  });
  try { doc = JSON.parse(text); } catch { throw new BoardError('members_invalid', 'members.json 이 JSON 이 아님'); }
  const { members, problems } = validateMembers(doc);

  const failed = problems.map((p) => ({ ...p, detail: null }));
  const rows = [];
  // gist 원본(raw)은 GitHub 가 5분쯤 캐시한다. 일부러 우회하지 않는다 — 10분~6시간마다, 숫자가 바뀔 때만 올리는 기록이라 충분하고, 요청 한도도 아낀다.
  const results = await pool(members, concurrency, async (m) => {
    try { return { m, ok: await fetchGist(fetch, m, timeoutMs) }; }
    catch (e) { return { m, err: e instanceof BoardError ? e : new BoardError('unknown', e && e.message) }; }
  });
  for (const r of results) {
    if (r.err) { failed.push({ login: r.m.login, reason: r.err.code, detail: r.err.message ? clip(r.err.message, MAX_DETAIL) : null }); continue; }
    const order = (e) => TOOLS.indexOf(e.tool);
    for (const entry of [...r.ok.entries].sort((a, b) => order(a) - order(b))) {
      rows.push({ login: r.m.login, tool: entry.tool, entry, updatedAt: r.ok.updatedAt ?? entry.generatedAt, gist: r.m.gist });
    }
  }
  return { fetchedAt: new Date().toISOString(), members, rows, failed };
}

// ── 기간 · 값 ───────────────────────────────────────────────────────────
/** 보는 사람 달력의 기간 → { from, to } (YYYY-MM-DD, 양끝 포함). "all" 은 null. 주는 월요일 시작. */
export function periodRange(period, { now = new Date() } = {}) {
  const d = new Date(now.getTime());
  if (period === 'all') return null;
  if (period === 'today') { const t = ymd(d); return { from: t, to: t }; }
  if (period === 'week') {
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    return { from: ymd(mon), to: ymd(sun) };
  }
  if (period === 'month') {
    return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
  }
  throw new TypeError(`모르는 기간: ${period}`);
}

/**
 * 기록 하나의 기간 × 단위 값. period ∈ all|today|week|month, unit ∈ total|output|cost.
 * 기간 값은 byDay 를 보는 사람 달력으로 잘라 더한다. byDay 날짜는 올린 사람 시간대 그대로다.
 */
export function measure(entry, period, unit, { now = new Date() } = {}) {
  const idx = UNIT_INDEX[unit];
  if (idx === undefined) throw new TypeError(`모르는 단위: ${unit}`);
  let sum = 0;
  if (period === 'all') {
    const v = entry && entry.totals ? entry.totals[unit] : 0;
    sum = isNum(v) ? v : 0;
  } else {
    const { from, to } = periodRange(period, { now });
    for (const [day, v] of Object.entries((entry && entry.byDay) || {})) {
      if (day < from || day > to || !Array.isArray(v)) continue;
      if (isNum(v[idx])) sum += v[idx];
    }
  }
  return unit === 'cost' ? cents(sum) : sum;
}

/** 마지막으로 올린 날이 보는 사람 달력으로 며칠 전인지(오늘 = 0). 시각을 모르면 null. */
export function staleDays(updatedAt, { now = new Date() } = {}) {
  const t = timeOf(updatedAt);
  if (t == null) return null;
  const at = new Date(t), n = new Date(now.getTime());
  const a = Date.UTC(at.getFullYear(), at.getMonth(), at.getDate());
  const b = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.max(0, Math.round((b - a) / 86400000));
}

// ── 순위 ────────────────────────────────────────────────────────────────
// 실수 비교 — 환산 금액은 더하는 순서에 따라 끝자리가 달라질 수 있다
const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function ranked(list) {
  list.sort((a, b) => (same(a.value, b.value) ? 0 : b.value - a.value)
    || lower(a.login).localeCompare(lower(b.login))
    || TOOLS.indexOf(a.tool) - TOOLS.indexOf(b.tool));
  // 같은 값은 같은 순위, 다음 순위는 그만큼 건너뛴다(1, 1, 3)
  list.forEach((x, i) => { x.rank = i > 0 && same(x.value, list[i - 1].value) ? list[i - 1].rank : i + 1; });
  return list;
}

/**
 * 순위를 매긴다. → { rows, people }
 *   rows   = 도구별 줄 [{ ...row, value, rank }] (사이트가 쓴다)
 *   people = 사람별 합 [{ login, value, rank, tools, rows, updatedAt }] (앱이 쓴다)
 * 같은 값은 같은 순위. opts.now 는 기간 계산 기준 시각.
 */
export function rank(rows, period, unit, opts = {}) {
  const scored = ranked(rows.map((r) => ({ ...r, value: measure(r.entry, period, unit, opts) })));
  const byLogin = new Map();
  for (const r of scored) {
    const k = lower(r.login);
    let p = byLogin.get(k);
    if (!p) byLogin.set(k, (p = { login: r.login, value: 0, tools: [], rows: [], updatedAt: null }));
    p.value += r.value;
    p.rows.push(r);
    if (!p.tools.includes(r.tool)) p.tools.push(r.tool);
    if (timeOf(r.updatedAt) != null && (p.updatedAt == null || timeOf(r.updatedAt) > timeOf(p.updatedAt))) p.updatedAt = r.updatedAt;
  }
  const people = [...byLogin.values()];
  for (const p of people) {
    if (unit === 'cost') p.value = cents(p.value);
    p.tools.sort((a, b) => TOOLS.indexOf(a) - TOOLS.indexOf(b));
  }
  return { rows: scored, people: ranked(people) };
}

/** 앱용 요약: 사람마다 기간 4개 × 단위 3개, 이번 주 총 토큰 순. */
export function summarize(board, { now = new Date() } = {}) {
  const { people } = rank(board.rows, 'week', 'total', { now });
  const grid = (p, unit) => Object.fromEntries(PERIODS.map((period) => {
    const v = p.rows.reduce((s, r) => s + measure(r.entry, period, unit, { now }), 0);
    return [period, unit === 'cost' ? cents(v) : v];
  }));
  return {
    ok: true,
    fetchedAt: board.fetchedAt,
    failed: board.failed,
    people: people.map((p) => ({
      login: p.login,
      rank: p.rank,
      tools: p.tools,
      total: grid(p, 'total'),
      output: grid(p, 'output'),
      cost: grid(p, 'cost'),
      updatedAt: p.updatedAt,
    })),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────
async function cli(argv) {
  const flag = (n, d = null) => {
    const i = argv.indexOf('--' + n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  const json = argv.includes('--json');
  const nowArg = flag('now');
  const now = nowArg ? new Date(nowArg) : new Date();
  if (!Number.isFinite(now.getTime())) {
    const error = { code: 'unknown', message: `--now 시각을 읽지 못함: ${nowArg}` };
    if (json) console.log(JSON.stringify({ ok: false, error })); else console.error(error.message);
    process.exitCode = 1;
    return;
  }
  let out;
  try {
    out = summarize(await loadBoard({ base: flag('base') || DEFAULT_BASE }), { now });
  } catch (e) {
    const error = { code: (e && e.code) || 'unknown', message: (e && e.message) || String(e) };
    if (json) console.log(JSON.stringify({ ok: false, error }));
    else console.error(`순위판을 불러오지 못했습니다 (${error.code}): ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (json) { console.log(JSON.stringify(out)); return; }

  const tok = (n) => (n >= 1e8 ? (n / 1e8).toFixed(2) + '억' : n >= 1e4 ? (n / 1e4).toFixed(1) + '만' : String(Math.round(n)));
  console.log(`토큰 계량기 순위 — 이번 주 총 토큰 (불러온 시각 ${new Date(out.fetchedAt).toLocaleString()})`);
  if (!out.people.length) console.log('  아직 참가자가 없습니다.');
  for (const p of out.people) {
    console.log(`  ${String(p.rank).padStart(3)}  ${p.login.padEnd(20)} ${tok(p.total.week).padStart(9)}   누적 ${tok(p.total.all).padStart(9)}   ${p.tools.join('+')}`);
  }
  if (out.failed.length) console.log(`읽지 못한 참가자 ${out.failed.length}명: ${out.failed.map((f) => `${f.login}(${f.reason})`).join(', ')}`);
}

// 브라우저에서는 process 가 없으므로 여기서 멈춘다. Node 에서도 직접 실행했을 때만 CLI 로 돈다.
// 경로에 공백·한글이 있으면 import.meta.url 은 %XX 로 적히고, 심볼릭 링크면 argv 와 다르게 풀린다 — 둘 다 실제 경로로 맞춘다.
async function isEntry() {
  try {
    const [{ fileURLToPath }, { realpathSync }] = await Promise.all([import('node:url'), import('node:fs')]);
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}
if (typeof process !== 'undefined' && process.versions && process.versions.node && Array.isArray(process.argv) && process.argv[1]) {
  isEntry().then((yes) => yes && cli(process.argv.slice(2))).catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
  });
}
