#!/usr/bin/env node
/**
 * 토큰 계량기 — 수집기 (Claude Code + Codex + Gemini CLI)
 *
 * ~/.claude/projects, ~/.codex/sessions, ~/.gemini/tmp 의 세션 로그에서
 * "토큰 사용량 숫자만" 뽑는다. --publish 면 내 GitHub 계정의 공개 gist 에 올린다(서버 없음).
 *
 * 프라이버시: 읽는 필드는 토큰 수치·모델명·시각·세션id·작업경로가 전부다.
 * 대화 내용은 파싱조차 하지 않으며 출력에도 절대 포함되지 않는다.
 * gist 에 올라가는 것은 화이트리스트(sanitizeEntry)를 지난 숫자뿐이다 — 이름·프로젝트·
 * 경로·세션 id·내부 통계는 올리기 직전에 매번 걸러진다. gist 수정 기록은 영원히 공개라서다.
 *
 * 두 도구는 토큰 회계 방식이 달라 아래처럼 공통 스키마로 맞춘다:
 *   전체 프롬프트  Claude: input + cache_read + cache_creation   Codex: input_tokens
 *   캐시 재사용    Claude: cache_read_input_tokens                Codex: cached_input_tokens
 *   출력           Claude: output_tokens (thinking 포함)          Codex: output_tokens (reasoning 포함)
 *   총합           위 항목들의 합                                  Codex: total_tokens
 *
 * 사용법:
 *   node collect.mjs                      # 내 사용량만 보기 (아무것도 올리지 않음)
 *   node collect.mjs --publish            # 내 공개 gist 에 숫자만 올리기 (gh auth login 필요)
 *   node collect.mjs --publish --json     # 앱용: 결과 JSON 한 줄 { ok, login, gist, url, member, joinUrl }
 *   node collect.mjs --json-only          # 수집 결과 JSON 만 표준 출력으로 (클립보드·파일 안 건드림)
 *   node collect.mjs --tool codex         # 하나만 (claude | codex | gemini)
 *   node collect.mjs --since 2026-08-01 [--until ...]
 *   node collect.mjs --name "닉네임"      # 화면 머리글에만 쓰인다 (공개 안 됨)
 *   node collect.mjs --projects           # --json-only 출력에 프로젝트 이름도 (공개에는 절대 안 들어감)
 *   node collect.mjs --dir <claude경로> --codex-dir <codex경로> --gemini-dir <gemini경로>
 *   node collect.mjs --publish --base <사이트 주소>   # members.json 을 읽을 순위판 (기본 GitHub Pages,
 *                                                   환경변수 TOKEN_METER_BASE 로도)
 *
 * gh 는 PATH 에서, 없으면 /opt/homebrew/bin·/usr/local/bin 에서 찾는다(TOKEN_METER_GH 로 못 박을 수 있다).
 * 호출은 늘 github.com 으로 간다(GH_HOST 무시). 토큰은 gh 가 쓰고 여기서는 읽지 않는다.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

// ── 인자 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);

const NAME = String(flag('name') || os.userInfo().username).slice(0, 24);
const TOOL = (flag('tool') || 'auto').toLowerCase();
const CLAUDE_ROOT = flag('dir') || path.join(os.homedir(), '.claude', 'projects');
const CODEX_ROOT = flag('codex-dir') || path.join(os.homedir(), '.codex');
const GEMINI_ROOT = flag('gemini-dir') || path.join(os.homedir(), '.gemini');
const SINCE = flag('since');
const UNTIL = flag('until');
const WITH_PROJECTS = has('projects');
const PUBLISH = has('publish');
// --publish 와 함께면 --json(또는 --json-only)은 "공개 결과 JSON 한 줄", 아니면 "수집 결과 JSON"
const JSON_OUT = PUBLISH && (has('json') || has('json-only'));
const QUIET = has('json-only') || has('json');

// ── 단가 (USD / 1M tokens) ──────────────────────────────────────────────
// 실제 청구액이 아니라 "각 벤더 API 단가로 환산하면 얼마"인지 보는 참고값이다.
// 구독(Max/Pro/ChatGPT Plus)으로 쓴 토큰은 이 금액이 청구되지 않는다.
// 표는 로그에 적힌 모델 이름으로 찾는다 — __proto__: null 이 없으면 "constructor"·"toString" 같은
// 이름이 Object.prototype 의 함수를 단가로 집어 와 환산액이 NaN 이 된다.

// Anthropic 1st-party, 2026-08 기준
const CLAUDE_PRICES = {
  __proto__: null,
  'claude-fable-5':    { in: 10, out: 50 },
  'claude-mythos-5':   { in: 10, out: 50 },
  'claude-opus-5':     { in: 5,  out: 25, fast: { in: 10, out: 50 } },
  'claude-opus-4-8':   { in: 5,  out: 25, fast: { in: 10, out: 50 } },
  'claude-opus-4-7':   { in: 5,  out: 25 },
  'claude-opus-4-6':   { in: 5,  out: 25 },
  'claude-opus-4-5':   { in: 5,  out: 25 },
  'claude-sonnet-5':   { in: 3,  out: 15, introUntil: '2026-08-31', intro: { in: 2, out: 10 } },
  'claude-sonnet-4-6': { in: 3,  out: 15 },
  'claude-sonnet-4-5': { in: 3,  out: 15 },
  'claude-haiku-4-5':  { in: 1,  out: 5 },
};
const CLAUDE_FALLBACK = { in: 5, out: 25 };
const CACHE_WRITE_5M = 1.25;   // 입력 단가 배수
const CACHE_WRITE_1H = 2.0;
const CACHE_READ = 0.1;

// OpenAI, developers.openai.com/api/docs/pricing 2026-08 기준
const CODEX_PRICES = {
  __proto__: null,
  'gpt-5.5':       { in: 5,    cached: 0.5,   out: 30 },
  'gpt-5.4':       { in: 2.5,  cached: 0.25,  out: 15 },
  'gpt-5.3-codex': { in: 1.75, cached: 0.175, out: 14 },
  'gpt-5.2':       { in: 1.75, cached: 0.175, out: 14 },
  'gpt-5.1':       { in: 1.25, cached: 0.125, out: 10 },
  'gpt-5':         { in: 1.25, cached: 0.125, out: 10 },
};
const CODEX_FALLBACK = { in: 2.5, cached: 0.25, out: 15 };
const LONG_CTX = 272_000;      // 초과 요청은 입력 2×, 출력 1.5×

// Google Gemini API paid tier, ai.google.dev/gemini-api/docs/pricing 2026-08 기준.
// 주의: Gemini CLI를 구글 계정 OAuth로 쓰면 실제로는 무료 티어 — 환산액은 참고값.
const GEMINI_PRICES = {
  __proto__: null,
  'gemini-2.5-pro':         { in: 1.25, cached: 0.125, out: 10 },
  'gemini-2.5-flash':       { in: 0.3,  cached: 0.03,  out: 2.5 },
  'gemini-2.5-flash-lite':  { in: 0.1,  cached: 0.01,  out: 0.4 },
  'gemini-3.1-pro-preview': { in: 2,    cached: 0.2,   out: 12 },
  'gemini-3-flash-preview': { in: 0.5,  cached: 0.05,  out: 3 },
  'gemini-3.5-flash':       { in: 1.5,  cached: 0.15,  out: 9 },
  'gemini-3.1-flash-lite':  { in: 0.25, cached: 0.025, out: 1.5 },
};
const GEMINI_FALLBACK = { in: 1.25, cached: 0.125, out: 10 };
const GEMINI_LONG_CTX = 200_000;   // pro 계열만: 초과 요청 입력·캐시 2×, 출력 1.5×

// ── 콘솔 문구 (시스템 로케일 기준) ──────────────────────────────────────
const KO = /^ko([_-]|$)/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '');
const STRINGS = {
  en: { published: 'Published to your gist', failed: 'failed',
        unchanged: 'Nothing changed — left your gist as it is (no new public revision)',
        created: 'Created a new public gist. Only numbers go up, and every gist revision stays public.',
        memberYes: 'You are on the leaderboard:',
        memberNo: 'Not on the leaderboard yet (or joined with an older gist). Open this link and submit the join issue:',
        memberUnknown: 'Could not check the leaderboard (network). If you are not on it, join here:',
        publishHint: 'To put these numbers on the leaderboard: node collect.mjs --publish  (needs gh auth login)',
        partialWarn: '--tool/--since/--until is set, so only that part is published — it replaces your whole gist (other tools and days drop off the board).',
        period: 'range', totalTokens: 'total tokens', output: 'output', cacheWrite: 'cache write',
        cacheRead: 'cache read', input: 'input (uncached)', responses: 'responses',
        sessionsL: 'sessions', subagents: 'subagents', apiEquiv: 'API-equivalent',
        notBilled: '(not an actual bill; 0 on a subscription)', byModel: 'By model',
        compare: 'Side by side', tokenizerNote: 'Tokenizers differ, so the same text counts differently.',
        days: 'active days', reasoningIncl: 'includes reasoning',
        notReported: 'not reported by Codex', readFail: (n) => `Could not read ${n} log file(s) — figures are short by that much:` },
  ko: { published: '내 gist 에 올림', failed: '실패',
        unchanged: '바뀐 것이 없어 gist 를 그대로 뒀어요 (새 공개 수정 기록 없음)',
        created: '새 공개 gist 를 만들었어요. 숫자만 올라가며, gist 의 수정 기록은 계속 공개로 남아요.',
        memberYes: '순위판에 참가 중이에요:',
        memberNo: '아직 순위판에 없어요(또는 예전 gist 로 참가돼 있어요). 아래 링크를 열어 참가 이슈를 제출해 주세요:',
        memberUnknown: '순위판 참가 여부를 확인하지 못했어요(네트워크). 순위판에 없다면 여기서 참가하세요:',
        publishHint: '순위판에 올리려면: node collect.mjs --publish  (gh auth login 필요)',
        partialWarn: '--tool·--since·--until 이 있어 그 부분만 올라갑니다 — gist 를 통째로 바꾸므로 빠진 도구·기간은 순위판에서 사라져요.',
        period: '기간', totalTokens: '총 토큰', output: '출력', cacheWrite: '캐시 쓰기',
        cacheRead: '캐시 읽기', input: '입력(캐시 아님)', responses: '응답 수',
        sessionsL: '세션', subagents: '서브에이전트', apiEquiv: 'API 환산',
        notBilled: '(실제 청구액 아님 - 구독이면 0원)', byModel: '모델별',
        compare: '대조', tokenizerNote: '토크나이저가 서로 달라 같은 글이라도 토큰 수가 다릅니다.',
        days: '활동', reasoningIncl: 'reasoning 포함',
        notReported: 'Codex는 별도 보고 없음',
        readFail: (n) => `읽지 못한 로그 파일 ${n}개 — 아래 수치는 그만큼 적게 잡혔습니다:` },
};
const L = (k, ...a) => { const v = (KO ? STRINGS.ko : STRINGS.en)[k]; return typeof v === 'function' ? v(...a) : v; };

// ── 공용 ────────────────────────────────────────────────────────────────
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (n) => Math.round(n * 100) / 100;
const localDay = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('sv-SE');
};
const inRange = (day) => !(SINCE && day && day < SINCE) && !(UNTIL && day && day > UNTIL);
const blank = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0, messages: 0 });
// 모델 이름 → 합계. 이름은 로그에서 그대로 오므로 원형 없는 객체에 모은다 — 보통 {} 면 "__proto__" 가
// Object.prototype 을 집어 와 거기에 NaN 을 쓰고(그 뒤 spawnSync 가 options.stdio[0] 에서 멈춘다),
// "constructor"·"toString" 은 원형의 함수에 더해져 모델별 목록에서 빠진다. JSON 으로는 {} 와 똑같이 나간다.
const byName = () => Object.create(null);

function walk(dir, out = [], exts = ['.jsonl']) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, exts);
    else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/** 단일 JSON 문서(들여쓰기 가능)를 통째로 읽는다 — 구형 Gemini 세션용 */
function readJsonDoc(file, maxBytes = 256 * 1024 * 1024) {
  try {
    if (fs.statSync(file).size > maxBytes) { readErrors.push([file, 'too_large']); return null; }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e && e.code) readErrors.push([file, e.code]);
    return null;   // 파싱 실패한 구형 파일은 건너뛴다
  }
}
const readErrors = [];

/**
 * JSONL 을 청크 단위로 흘려 읽는다. 통째로 읽으면 512MB(Node 문자열 한계)를
 * 넘는 세션 파일에서 ERR_STRING_TOO_LONG 이 나고, 그걸 삼키면 데이터가
 * 통째로 사라진다. 읽기 실패는 절대 조용히 넘기지 않는다.
 * want(line) 로 파싱 전에 싼값으로 걸러 큰 파일을 빠르게 지나간다.
 */
function* jsonl(file, want = null) {
  const CHUNK = 1 << 22;
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (e) { readErrors.push([file, e.code || e.message]); return; }
  const buf = Buffer.allocUnsafe(CHUNK);
  const dec = new StringDecoder('utf8');
  let carry = '';
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
      const parts = (carry + dec.write(buf.subarray(0, n))).split('\n');
      carry = parts.pop();
      for (const line of parts) {
        if (!line || (want && !want(line))) continue;
        try { yield JSON.parse(line); } catch { /* 깨진 줄은 건너뛴다 */ }
      }
    }
    carry += dec.end();
    if (carry && (!want || want(carry))) { try { yield JSON.parse(carry); } catch {} }
  } catch (e) {
    readErrors.push([file, e.code || e.message]);
  } finally { try { fs.closeSync(fd); } catch {} }
}

function finish(tool, { totals, byModel, byDay, sessions, projects, extra, estimated, stats }) {
  const days = Object.keys(byDay).sort();
  for (const m of Object.values(byModel)) m.cost = round(m.cost);
  for (const d of days) byDay[d][2] = round(byDay[d][2]);
  totals.cost = round(totals.cost);
  return {
    v: 2, tool, name: NAME,
    generatedAt: new Date().toISOString(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    range: { from: days[0] || null, to: days[days.length - 1] || null, activeDays: days.length },
    totals,
    messages: totals.messages,
    sessions: sessions.size,
    projectCount: projects.size,
    ...(WITH_PROJECTS ? { projects: [...projects].map((p) => path.basename(p)) } : {}),
    byModel, byDay,
    ...extra,
    estimated: !!estimated,
    _stats: stats,
  };
}

// ── Claude Code ─────────────────────────────────────────────────────────
// 함정 3개: ① 한 응답이 여러 줄 → message.id 로 접기  ② resume/fork 시 히스토리가
// 새 파일로 복사 → 전역 중복 제거  ③ 스트리밍 중간 스냅샷이 같은 id로 쌓이며
// output_tokens 만 커짐 → 합이 아니라 최대값
function collectClaude() {
  const files = walk(CLAUDE_ROOT);
  if (!files.length) return null;

  const rate = (model, day, speed) => {
    const p = CLAUDE_PRICES[model] || CLAUDE_FALLBACK;
    if (speed === 'fast' && p.fast) return p.fast;
    if (p.intro && p.introUntil && day && day <= p.introUntil) return p.intro;
    return { in: p.in, out: p.out };
  };

  const records = new Map();
  let lines = 0, usageLines = 0;
  for (const file of files) {
    for (const d of jsonl(file, (l) => l.includes('"usage"'))) {
      lines++;
      const m = d.message;
      if (!m || typeof m !== 'object') continue;
      const u = m.usage;
      if (!u || typeof u !== 'object') continue;
      usageLines++;
      const model = m.model;
      if (!model || model === '<synthetic>' || d.isApiErrorMessage) continue;
      const id = m.id || d.requestId || d.uuid;
      if (!id) continue;
      const day = localDay(d.timestamp);
      if (!inRange(day)) continue;

      const cc = u.cache_creation || {};
      const w1h = num(cc.ephemeral_1h_input_tokens);
      const w5m = num(cc.ephemeral_5m_input_tokens);
      const ccTotal = num(u.cache_creation_input_tokens);

      const cur = {
        model, day, speed: u.speed || null,
        session: d.sessionId || null, project: d.cwd || null,
        input: num(u.input_tokens), output: num(u.output_tokens),
        write5m: w1h + w5m > 0 ? w5m : ccTotal, write1h: w1h,
        read: num(u.cache_read_input_tokens),
        sub: !!d.isSidechain, agentId: d.agentId || null,
      };
      const prev = records.get(id);
      if (!prev) { records.set(id, cur); continue; }
      for (const k of ['input', 'output', 'write5m', 'write1h', 'read']) prev[k] = Math.max(prev[k], cur[k]);
      if (!prev.day && cur.day) prev.day = cur.day;
    }
  }
  if (!records.size) return null;

  const totals = blank(), byModel = byName(), byDay = {};
  const sessions = new Set(), projects = new Set(), agents = new Set();
  const split = { main: 0, sub: 0 };
  let unknown = 0;

  for (const r of records.values()) {
    const rt = rate(r.model, r.day, r.speed);
    const cost = (r.input / 1e6) * rt.in + (r.output / 1e6) * rt.out
      + (r.write5m / 1e6) * rt.in * CACHE_WRITE_5M + (r.write1h / 1e6) * rt.in * CACHE_WRITE_1H
      + (r.read / 1e6) * rt.in * CACHE_READ;
    const cacheWrite = r.write5m + r.write1h;
    const total = r.input + r.output + cacheWrite + r.read;
    const m = (byModel[r.model] ||= blank());
    for (const [k, v] of [['input', r.input], ['output', r.output], ['cacheWrite', cacheWrite],
                          ['cacheRead', r.read], ['total', total], ['cost', cost]]) { totals[k] += v; m[k] += v; }
    totals.messages++; m.messages++;
    if (!CLAUDE_PRICES[r.model]) unknown += total;
    split[r.sub ? 'sub' : 'main'] += total;
    if (r.sub && r.agentId) agents.add(r.agentId);
    if (r.day) { const b = (byDay[r.day] ||= [0, 0, 0]); b[0] += total; b[1] += r.output; b[2] += cost; }
    if (r.session) sessions.add(r.session);
    if (r.project) projects.add(r.project);
  }

  return finish('claude', {
    totals, byModel, byDay, sessions, projects, estimated: unknown > 0,
    extra: { subagents: agents.size, split },
    stats: { files: files.length, lines, usageLines, deduped: records.size },
  });
}

// ── Codex ───────────────────────────────────────────────────────────────
// 함정: token_count.info.total_token_usage 는 세션 누적값이다. 이벤트를 그냥
// 더하면 수십 배가 된다. 양수 델타만 취해 모델·날짜에 귀속시키고, 같은 세션이
// 여러 파일에 걸치면 카운터가 이어지므로 세션별로 직전값을 들고 간다.
function collectCodex() {
  const roots = [path.join(CODEX_ROOT, 'sessions'), path.join(CODEX_ROOT, 'archived_sessions')];
  const files = roots.flatMap((r) => walk(r)).filter((f) => path.basename(f).startsWith('rollout-'));
  if (!files.length) return null;
  files.sort();   // rollout-<ISO 타임스탬프> → 이름순 = 시간순

  const rate = (model) => CODEX_PRICES[model] || CODEX_FALLBACK;
  const totals = blank(), byModel = byName(), byDay = {};
  const sessions = new Set(), projects = new Set();
  const prevBySession = new Map();   // 세션이 여러 파일에 걸칠 때 누적값 이어받기
  let unknown = 0, events = 0, drops = 0;

  for (const file of files) {
    let sid = path.basename(file), model = null;
    let prev = null;
    for (const d of jsonl(file, (l) => l.includes('"token_count"') || l.includes('"session_meta"') || l.includes('"turn_context"') || l.includes('"agent_message"'))) {
      const p = d.payload;
      if (!p || typeof p !== 'object') continue;

      if (d.type === 'session_meta') {
        if (p.id) sid = p.id;
        if (p.cwd) projects.add(p.cwd);
        prev = prevBySession.get(sid) || null;
        continue;
      }
      if (d.type === 'turn_context' && p.model) { model = p.model; continue; }
      if (p.type === 'agent_message') { totals.messages++; continue; }
      if (p.type !== 'token_count' || !p.info) continue;

      const tt = p.info.total_token_usage;
      const lt = p.info.last_token_usage;
      if (!tt) continue;
      events++;
      const base = prev || { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      const dIn = tt.input_tokens - base.input_tokens;
      const dCa = tt.cached_input_tokens - base.cached_input_tokens;
      const dOut = tt.output_tokens - base.output_tokens;
      prev = tt; prevBySession.set(sid, tt);
      if (dIn < 0 || dOut < 0) { drops++; continue; }   // 드문 하향 보정은 버린다
      if (dIn === 0 && dOut === 0) continue;

      const day = localDay(d.timestamp);
      if (!inRange(day)) continue;
      sessions.add(sid);

      const cached = Math.max(0, Math.min(dCa, dIn));
      const uncached = dIn - cached;
      const long = lt && lt.input_tokens > LONG_CTX;      // 272K 초과 요청 할증
      const rt = rate(model);
      const cost = (uncached / 1e6) * rt.in * (long ? 2 : 1)
        + (cached / 1e6) * rt.cached * (long ? 2 : 1)
        + (dOut / 1e6) * rt.out * (long ? 1.5 : 1);
      const total = dIn + dOut;

      const key = model || '(unknown)';
      const m = (byModel[key] ||= blank());
      // 공통 스키마: input = 캐시 아닌 입력, cacheRead = 캐시 입력, cacheWrite 없음
      for (const [k, v] of [['input', uncached], ['output', dOut], ['cacheRead', cached],
                            ['total', total], ['cost', cost]]) { totals[k] += v; m[k] += v; }
      if (!CODEX_PRICES[key]) unknown += total;
      if (day) { const b = (byDay[day] ||= [0, 0, 0]); b[0] += total; b[1] += dOut; b[2] += cost; }
    }
  }
  if (!totals.total) return null;

  return finish('codex', {
    totals, byModel, byDay, sessions, projects, estimated: unknown > 0,
    extra: { subagents: 0, split: null },
    stats: { files: files.length, events, drops },
  });
}

// ── Gemini CLI ──────────────────────────────────────────────────────────
// 포맷(소스 chatRecordingTypes.ts 확인): ~/.gemini/tmp/<프로젝트해시>/chats/ 안에
// 신형 .jsonl(레코드 스트림)과 구형 .json(단일 객체)이 공존한다. 함정 셋:
// ① 스트리밍 갱신 — 같은 id의 메시지 레코드가 여러 번 오면 "최신으로 교체"
// ② {$set:{messages:[...]}} 는 체크포인트(전체 교체), {$rewindTo:id} 는 그 id부터 절단
//    — 순서대로 적용하지 않으면 되감긴 요청의 토큰을 이중 집계한다
// ③ tokens.input 에는 cached 가 포함 — 비캐시 입력 = input - cached
// 같은 세션이 .json/.jsonl 양쪽에 있을 수 있어 sessionId 로 중복 제거(.jsonl 우선).
function collectGemini() {
  const root = path.join(GEMINI_ROOT, 'tmp');
  const chatFiles = walk(root, [], ['.jsonl', '.json']).filter((f) => f.split(path.sep).includes('chats'));
  if (!chatFiles.length) return null;

  const rate = (model) => {
    if (model && GEMINI_PRICES[model]) return GEMINI_PRICES[model];
    if (model) for (const k of Object.keys(GEMINI_PRICES)) if (model.startsWith(k)) return GEMINI_PRICES[k];
    return GEMINI_FALLBACK;
  };

  // 세션 재구성: sessionId -> { kind, project, msgs: Map(id -> msg), fmt }
  const sessions = new Map();
  for (const file of chatFiles) {
    let meta = { sessionId: null, kind: 'main', project: null };
    const msgs = new Map();
    const isJsonl = file.endsWith('.jsonl');
    if (isJsonl) {
      for (const rec of jsonl(file)) {
        if (rec && rec.sessionId && rec.projectHash && !rec.id) {
          meta = { sessionId: rec.sessionId, kind: rec.kind || 'main', project: rec.projectHash };
          continue;
        }
        if (rec && rec.$set) {
          if (Array.isArray(rec.$set.messages)) {
            msgs.clear();
            for (const m of rec.$set.messages) if (m && m.id) msgs.set(m.id, m);
          }
          continue;
        }
        if (rec && rec.$rewindTo) {
          const ids = [...msgs.keys()];
          const at = ids.indexOf(rec.$rewindTo);
          if (at >= 0) for (const id of ids.slice(at)) msgs.delete(id);
          continue;
        }
        if (rec && rec.id) msgs.set(rec.id, rec);   // 재등장 = 스트리밍 갱신 → 교체
      }
    } else {
      // 구형: 단일 ConversationRecord 객체 (들여쓰기돼 있을 수 있어 통째로 읽는다)
      const doc = readJsonDoc(file);
      if (!doc || !Array.isArray(doc.messages)) continue;
      meta = { sessionId: doc.sessionId || file, kind: doc.kind || 'main', project: doc.projectHash || null };
      for (const m of doc.messages) if (m && m.id) msgs.set(m.id, m);
    }
    if (!msgs.size) continue;
    const key = meta.sessionId || file;
    const prev = sessions.get(key);
    if (prev && prev.fmt === 'jsonl' && !isJsonl) continue;   // .jsonl 이 이긴다
    sessions.set(key, { ...meta, msgs, fmt: isJsonl ? 'jsonl' : 'json' });
  }
  if (!sessions.size) return null;

  const totals = blank(), byModel = byName(), byDay = {};
  const sessionIds = new Set(), projects = new Set(), subs = new Set();
  const split = { main: 0, sub: 0 };
  let unknown = 0;

  for (const [sid, sess] of sessions) {
    let touched = false;
    for (const m of sess.msgs.values()) {
      if (m.type !== 'gemini' || !m.tokens || typeof m.tokens !== 'object') continue;
      const tk = m.tokens;
      const rawIn = num(tk.input), cached = Math.min(num(tk.cached), rawIn);
      const input = rawIn - cached;                       // ③ 이중 집계 방지
      const output = num(tk.output) + num(tk.thoughts);   // 추론 포함 (Claude/Codex 와 동형)
      if (input + cached + output === 0) continue;

      const day = localDay(m.timestamp);
      if (!inRange(day)) continue;
      touched = true;

      const model = typeof m.model === 'string' ? m.model : '(gemini)';
      const rt = rate(model);
      const long = model.includes('pro') && rawIn > GEMINI_LONG_CTX;
      const cost = (input / 1e6) * rt.in * (long ? 2 : 1)
        + (cached / 1e6) * rt.cached * (long ? 2 : 1)
        + (output / 1e6) * rt.out * (long ? 1.5 : 1);
      const total = input + cached + output;

      const bm = (byModel[model] ||= blank());
      for (const [k, v] of [['input', input], ['output', output], ['cacheRead', cached],
                            ['total', total], ['cost', cost]]) { totals[k] += v; bm[k] += v; }
      totals.messages++; bm.messages++;
      if (!GEMINI_PRICES[model] && model !== '(gemini)') unknown += total;
      if (model === '(gemini)') unknown += total;
      split[sess.kind === 'subagent' ? 'sub' : 'main'] += total;
      if (day) { const b = (byDay[day] ||= [0, 0, 0]); b[0] += total; b[1] += output; b[2] += cost; }
    }
    if (touched) {
      if (sess.kind === 'subagent') subs.add(sid); else sessionIds.add(sid);
      if (sess.project) projects.add(sess.project);
    }
  }
  if (!totals.total) return null;

  return finish('gemini', {
    totals, byModel, byDay, sessions: sessionIds, projects, estimated: unknown > 0,
    extra: { subagents: subs.size, split: split.sub > 0 ? split : null },
    stats: { files: chatFiles.length, sessions: sessions.size },
  });
}

// ── 공개: 참가자 gist ───────────────────────────────────────────────────
// 서버가 없다. 각자 자기 GitHub 계정의 공개 gist 에 숫자만 올리고, 순위판(GitHub Pages)이
// docs/members.json 에 적힌 gist 들을 직접 읽는다. 모든 GitHub 호출은 gh CLI 를 거친다.
export const REPO = 'Min-heee/token-meter';
export const DEFAULT_SITE = 'https://min-heee.github.io/token-meter/';
export const GIST_FILE = 'token-meter.json';
export const GIST_DESCRIPTION = 'token-meter — AI coding agent token usage (numbers only)';
export const MAX_GIST_BYTES = 256 * 1024;
export const MAX_MODELS = 100;   // 순위판(board.mjs)·참가 검사(join-core.mjs)가 받는 모델 수 상한
export const TOOLS = ['claude', 'codex', 'gemini'];
export const TOTAL_KEYS = ['input', 'output', 'cacheWrite', 'cacheRead', 'total', 'cost', 'messages'];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;
// 모델 이름은 키로 공개된다 — 흔한 글자만, 64자까지. 벗어나면 "(other)" 로 합친다
// (Codex 는 사용자가 붙인 임의 모델 이름이 그대로 들어올 수 있다).
const MODEL_RE = /^[A-Za-z0-9_.:@+\-/() ]{1,64}$/;
// 글자는 흔해도 내용이 개인 정보인 이름이 있다 — 로컬 모델을 파일 경로로 부르는 경우
// ("/Users/<이름>/models/x.gguf")와 메일 주소꼴. 순위판(board.mjs)은 "__proto__" 를 받으면
// 그 사람 기록 전체를 거절하므로 이것도 함께 "(other)" 로 보낸다. "org/model"·"provider/org/model"·
// "model@날짜"·"qwen2.5-coder:7b" 같은 흔한 이름은 그대로 둔다.
const PATHLIKE_RE = /^(?:[/.]|[A-Za-z]:\/)|\/\/|(?:^|\/)(?:users|home|root|private|tmp|var|volumes|mnt|opt)(?:\/|$)/i;
const EMAIL_RE = /@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const publicModel = (name) =>
  MODEL_RE.test(name) && name !== '__proto__' && !PATHLIKE_RE.test(name) && !EMAIL_RE.test(name)
  && name.split('/').length <= 3 ? name : '(other)';
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GIST_ID_RE = /^[0-9A-Za-z]{1,64}$/;

export const joinUrl = (gistId) =>
  `https://github.com/${REPO}/issues/new?template=join.yml&title=join&gist=${encodeURIComponent(gistId)}`;
const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// 순위판 검증(board.mjs·join.mjs)은 유한한 0 이상 숫자만 받는다 — 이상한 값은 0 으로
const cnt = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const pickTotals = (o) => Object.fromEntries(TOTAL_KEYS.map((k) => [k, cnt(o && o[k])]));

/**
 * 수집 결과 하나를 공개 가능한 모양으로 깎는다(화이트리스트). 여기 적힌 필드 말고는 아무것도
 * 나가지 않는다 — name·projectCount·projects·_stats·v·경로·세션 id 는 모두 버려진다.
 * 도구가 claude|codex|gemini 가 아니면 null.
 */
export function sanitizeEntry(e) {
  if (!e || typeof e !== 'object' || !TOOLS.includes(e.tool)) return null;
  let models = new Map();
  if (e.byModel && typeof e.byModel === 'object') {
    for (const [name, v] of Object.entries(e.byModel)) {
      const key = publicModel(name);
      const cur = pickTotals(v), prev = models.get(key);
      if (prev) for (const k of TOTAL_KEYS) prev[k] += cur[k];
      else models.set(key, cur);
    }
  }
  if (models.size > MAX_MODELS) {
    // 넘으면 작은 것부터 "(other)" 로 합친다 — 하나라도 넘으면 순위판이 기록 전체를 거절한다
    const ranked = [...models].sort((a, b) => b[1].total - a[1].total);
    const keep = new Map(ranked.filter(([k]) => k !== '(other)').slice(0, MAX_MODELS - 1));
    const other = pickTotals(null);
    for (const [k, v] of ranked) if (!keep.has(k)) for (const t of TOTAL_KEYS) other[t] += v[t];
    keep.set('(other)', other);
    models = keep;
  }
  const byDay = {};
  if (e.byDay && typeof e.byDay === 'object') {
    for (const d of Object.keys(e.byDay).sort()) {
      const v = e.byDay[d];
      if (!DAY_RE.test(d) || !Array.isArray(v)) continue;
      byDay[d] = [cnt(v[0]), cnt(v[1]), cnt(v[2])];
    }
  }
  // 기간은 걸러진 byDay 에서 다시 잰다 — 둘이 어긋날 일이 없게
  const days = Object.keys(byDay);
  const t = typeof e.generatedAt === 'string' ? new Date(e.generatedAt) : null;
  return {
    tool: e.tool,
    generatedAt: t && !Number.isNaN(t.getTime()) ? t.toISOString() : new Date().toISOString(),
    tz: typeof e.tz === 'string' && TZ_RE.test(e.tz) ? e.tz : 'UTC',
    range: { from: days[0] || null, to: days[days.length - 1] || null, activeDays: days.length },
    totals: pickTotals(e.totals),
    messages: cnt(e.messages),
    sessions: cnt(e.sessions),
    subagents: cnt(e.subagents),
    split: e.split && typeof e.split === 'object' ? { main: cnt(e.split.main), sub: cnt(e.split.sub) } : null,
    byModel: Object.fromEntries(models),   // fromEntries: "__proto__" 같은 이름도 평범한 키로 남는다
    byDay,
    estimated: e.estimated === true,
  };
}

/** gist 에 올릴 문서 전체. 도구마다 하나만(뒤에 온 것이 이긴다), claude → codex → gemini 순. */
export function buildPayload(entries, login, now = new Date()) {
  const byTool = new Map();
  for (const e of Array.isArray(entries) ? entries : [entries]) {
    const s = sanitizeEntry(e);
    if (s) byTool.set(s.tool, s);
  }
  return {
    schema: 1, app: 'token-meter', login, updatedAt: now.toISOString(),
    entries: TOOLS.filter((t) => byTool.has(t)).map((t) => byTool.get(t)),
  };
}

/**
 * gist 파일 내용. 사람이 gist 에서 읽기 쉽게 줄을 나누되 날짜별 [총,출력,환산] 배열은 한 줄로
 * 접는다(그대로면 크기가 두 배). 상한을 넘으면 줄바꿈 없는 꼴로, 그래도 넘으면 gist_too_large.
 * JSON 문자열 안에는 날 줄바꿈이 있을 수 없어서, 줄바꿈을 요구하는 이 치환은 문자열을 건드리지 않는다.
 */
export function serializePayload(payload) {
  const pretty = JSON.stringify(payload, null, 1)
    .replace(/\[\n\s*(-?[\d.eE+-]+(?:,\n\s*-?[\d.eE+-]+)*)\n\s*\]/g, (_, xs) => '[' + xs.replace(/\s+/g, '') + ']');
  const compact = JSON.stringify(payload);
  for (const s of [pretty, compact]) if (Buffer.byteLength(s, 'utf8') <= MAX_GIST_BYTES) return s;
  throw new PublishError('gist_too_large', { detail: `${Math.ceil(Buffer.byteLength(compact, 'utf8') / 1024)}KB` });
}

// ── 공개: 오류 ──────────────────────────────────────────────────────────
// 앱(main.swift)이 code 로 안내 문구를 고른다. 코드 목록은 계약이라 늘리지 않는다.
const ERR = {
  gh_missing: [
    () => 'GitHub CLI(gh)가 설치돼 있지 않아요. brew install gh 로 설치한 뒤 gh auth login 으로 로그인해 주세요.',
    () => 'GitHub CLI (gh) is not installed. Install it (brew install gh), then run gh auth login.'],
  gh_not_logged_in: [
    () => 'gh 에 로그인돼 있지 않아요. 터미널에서 gh auth login 으로 로그인해 주세요.',
    () => 'gh is not logged in. Run gh auth login in a terminal.'],
  gh_no_gist_scope: [
    () => 'gh 로그인에 gist 권한이 없어요. 터미널에서 gh auth refresh -s gist 로 권한을 더해 주세요.',
    () => 'Your gh login lacks the gist scope. Run gh auth refresh -s gist in a terminal.'],
  network: [
    () => 'GitHub 에 닿지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.',
    () => 'Could not reach GitHub. Check your connection and try again.'],
  gist_too_large: [
    (d) => `올릴 내용(${d})이 gist 상한 256KB 를 넘어요. --since 로 기간을 줄여 주세요.`,
    (d) => `The payload (${d}) is over the 256 KB gist cap. Narrow it with --since.`],
  unknown: [
    (d) => `올리지 못했어요${d ? `: ${d}` : ''}`,
    (d) => `Publishing failed${d ? `: ${d}` : ''}`],
};

// gh 의 오류 문구에 토큰이 섞여 나와도 화면에는 절대 찍지 않는다
const TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/g;
export const redact = (s) => String(s)
  .replace(/(authorization\s*[:=]\s*)(?:(?:bearer|token|basic)\s+)?[^\s"']+/gi, '$1***')
  .replace(TOKEN_RE, '***');

export class PublishError extends Error {
  /** @param {string} code  ERR 의 키  @param {{detail?:string, ko?:string, en?:string}} [o] */
  constructor(code, { detail = '', ko = null, en = null } = {}) {
    const c = ERR[code] ? code : 'unknown';
    const d = redact(detail).replace(/\s+/g, ' ').trim().slice(0, 300);
    const msgKo = redact(ko ?? ERR[c][0](d)), msgEn = redact(en ?? ERR[c][1](d));
    super(msgKo);
    this.code = c; this.ko = msgKo; this.en = msgEn;
  }
}

const httpStatus = (r) => { const m = /\(HTTP (\d{3})\)/.exec(r.stderr || ''); return m ? Number(m[1]) : null; };

/**
 * gh 실패를 오류 코드로. write=true 는 gist 쓰기·목록 호출 — 인증은 됐는데 403/404 면 gist 권한이
 * 없는 것이다(GitHub 은 권한 없는 gist 쓰기에 404 를 준다).
 */
export function classifyGh(r, { write = false } = {}) {
  if (r.error === 'ENOENT') return 'gh_missing';
  if (r.error === 'ETIMEDOUT') return 'network';
  const err = r.stderr || '';
  if (/-s\s+gist\b|"gist" scope/i.test(err)) return 'gh_no_gist_scope';
  if (r.status === 4 || /gh auth login|not logged in|authentication required|bad credentials|HTTP 401/i.test(err)) return 'gh_not_logged_in';
  if (/error connecting|could not resolve|no such host|dial tcp|connection (?:refused|reset)|network is unreachable|i\/o timeout|timed? ?out|TLS handshake|unexpected EOF|HTTP 50[234]/i.test(err)) return 'network';
  const http = httpStatus(r);
  if (write && (http === 403 || http === 404) && !/rate limit/i.test(err)) return 'gh_no_gist_scope';
  return 'unknown';
}

const lastLine = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
const ghError = (r, opts) => {
  const code = classifyGh(r, opts);
  return new PublishError(code, code === 'unknown' ? { detail: lastLine(r.stderr) || (r.error ? `gh ${r.error}` : `gh exit ${r.status}`) } : {});
};

// ── 공개: gh 실행 ───────────────────────────────────────────────────────
// 맥 앱처럼 launchd 가 띄운 프로세스는 PATH 가 /usr/bin:/bin 뿐이라 Homebrew 의 gh 를 못 찾는다.
// 그러면 설치돼 있는데도 "gh 를 설치하세요" 라고 안내하게 된다 — PATH 에 없을 때만 흔한 설치 위치를 본다.
export const GH_FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/home/linuxbrew/.linuxbrew/bin'];

/**
 * gh 를 부르는 함수를 만든다. 반환: (args, input) → { status, stdout, stderr, error }.
 * 테스트·앱은 같은 모양의 가짜를 넣을 수 있다. 토큰은 gh 가 알아서 쓴다 — 여기서는 읽지 않는다.
 * bin(또는 TOKEN_METER_GH)을 주면 그것만 쓴다. 없으면 PATH 의 gh → fallbackDirs 순으로 찾는다.
 */
export function ghRunner({ env = process.env, bin = env.TOKEN_METER_GH || null, fallbackDirs = GH_FALLBACK_DIRS, timeoutMs = 120_000 } = {}) {
  const childEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0' };
  delete childEnv.GH_DEBUG;   // 디버그 출력에는 요청 머리글(인증 포함)이 찍힌다
  delete childEnv.DEBUG;
  const candidates = bin ? [bin] : ['gh', ...fallbackDirs.map((d) => path.join(d, 'gh'))];
  let found = null;   // 한 번 찾은 gh 는 계속 쓴다
  return (args, input = null) => {
    // gh 의 기본 호스트는 GH_HOST 나, 로그인한 곳이 회사 GitHub Enterprise 하나뿐이면 그 서버다 —
    // 그러면 "공개" gist 가 회사 서버에 생기고 순위판은 읽지 못한다. 늘 github.com 으로 못 박는다.
    const full = args[0] === 'api' && !args.includes('--hostname') ? ['api', '--hostname', 'github.com', ...args.slice(1)] : args;
    for (const b of found ? [found] : candidates) {
      const r = spawnSync(b, full, {
        input: input ?? '', encoding: 'utf8', env: childEnv,
        maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true,
      });
      if (r.error && r.error.code === 'ENOENT') continue;   // 여기엔 없다 — 다음 자리
      found = b;
      return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? (r.error.code || 'spawn_failed') : null };
    }
    return { status: null, stdout: '', stderr: '', error: 'ENOENT' };
  };
}

/** 이어 붙은 JSON 값들([...][...])을 차례로 읽는다 — gh --paginate 는 판에 따라 쪽마다 배열을 따로 낸다 */
export function parseJsonSeq(text) {
  const s = String(text);
  try { return [JSON.parse(s)]; } catch { /* 이어 붙은 꼴 — 아래에서 하나씩 */ }
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { if (--depth === 0) { j++; break; } }
    }
    out.push(JSON.parse(s.slice(i, j)));   // 깨졌으면 여기서 던진다
    i = j;
  }
  return out;
}

/** 내 gist 중 token-meter.json 이 든 공개 gist(가장 최근 것). 없으면 null. */
function searchGist(gh, login) {
  // 계약 문서의 `user/gists` 는 GitHub 에 없는 경로다(404) — 로그인한 사람의 gist 목록은 GET /gists
  const r = gh(['api', '--paginate', 'gists?per_page=100']);
  if (r.error || r.status !== 0) throw ghError(r, { write: true });
  let list;
  try { list = parseJsonSeq(r.stdout).flat(); }
  catch { throw new PublishError('unknown', { detail: 'gist 목록을 해석하지 못했어요' }); }
  const mine = list.filter((g) => g && typeof g.id === 'string' && GIST_ID_RE.test(g.id) && g.public === true
    && g.files && typeof g.files === 'object' && Object.hasOwn(g.files, GIST_FILE)
    && (!g.owner || sameLogin(g.owner.login, login)));
  mine.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return mine.length ? mine[0].id : null;
}

/** gist 고치기(id) 또는 새로 만들기(id 없음). 실패해도 던지지 않고 판단 재료를 돌려준다. */
function writeGist(gh, id, content, login) {
  const body = JSON.stringify({
    description: GIST_DESCRIPTION,
    ...(id ? {} : { public: true }),
    files: { [GIST_FILE]: { content } },
  });
  const args = id ? ['api', '-X', 'PATCH', `gists/${id}`, '--input', '-'] : ['api', '-X', 'POST', 'gists', '--input', '-'];
  const r = gh(args, body);
  if (r.error || r.status !== 0) {
    // hinted: gh 가 이유를 분명히 말했다(권한·로그인·네트워크) — 404 라도 "지워진 gist" 로 보지 않는다
    return { ok: false, http: httpStatus(r), hinted: classifyGh(r) !== 'unknown', err: ghError(r, { write: true }) };
  }
  let g;
  try { g = JSON.parse(r.stdout); } catch { g = null; }
  if (!g || typeof g.id !== 'string' || !GIST_ID_RE.test(g.id)) {
    return { ok: false, http: null, hinted: true, err: new PublishError('unknown', { detail: 'gist 응답을 해석하지 못했어요' }) };
  }
  const url = typeof g.html_url === 'string' && g.html_url.startsWith('https://gist.github.com/')
    ? g.html_url : `https://gist.github.com/${login}/${g.id}`;
  return { ok: true, gist: { id: g.id, url }, created: !id };
}

// ── 공개: 바뀐 것이 없으면 고치지 않는다 ────────────────────────────────
// gist 를 고칠 때마다 공개 수정 기록이 하나씩 영원히 남는다. 앱은 10분~6시간마다 올리니,
// 숫자가 그대로인데 고치면 똑같은 수정 기록만 쌓인다 — 지금 gist 의 문서와 같으면 그대로 둔다.
// 비교에서 빼는 것은 올릴 때마다 바뀌는 시각뿐이다: 문서의 updatedAt, 기록마다의 generatedAt.

/** 키 순서와 상관없이 비교할 수 있게 키를 정렬한 사본 */
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const withoutTimes = (doc) => ({
  ...doc, updatedAt: null,
  entries: Array.isArray(doc.entries)
    ? doc.entries.map((e) => (e && typeof e === 'object' && !Array.isArray(e) ? { ...e, generatedAt: null } : e)) : doc.entries,
});

/** 올릴 문서(payload)가 gist 에 있는 문서(current)와 시각 말고는 똑같은가. 모르는 칸이 하나라도 다르면 false(= 고친다). */
export function samePublished(current, payload) {
  if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
  return JSON.stringify(canon(withoutTimes(current))) === JSON.stringify(canon(withoutTimes(payload)));
}

/** 내 gist 의 token-meter.json 문서와 주소. 못 읽거나(지워짐·잘림·깨짐) 남의 gist 면 null — 그러면 그냥 고친다. */
function readGist(gh, id, login) {
  const r = gh(['api', `gists/${id}`]);
  if (r.error || r.status !== 0) return null;
  let g;
  try { g = JSON.parse(r.stdout); } catch { return null; }
  const f = g && g.files && typeof g.files === 'object' && Object.hasOwn(g.files, GIST_FILE) ? g.files[GIST_FILE] : null;
  if (!f || f.truncated === true || typeof f.content !== 'string' || !g.owner || !sameLogin(g.owner.login, login)) return null;
  let doc;
  try { doc = JSON.parse(f.content); } catch { return null; }
  const url = typeof g.html_url === 'string' && g.html_url.startsWith('https://gist.github.com/')
    ? g.html_url : `https://gist.github.com/${login}/${id}`;
  return { doc, url };
}

// ── 공개: gist id 기억 (~/.token-meter/gist.json) ───────────────────────
const cachePath = (home) => path.join(home, '.token-meter', 'gist.json');
export function readGistCache(home = os.homedir()) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(home), 'utf8'));
    return c && typeof c.gist === 'string' && GIST_ID_RE.test(c.gist) && typeof c.login === 'string' ? c : null;
  } catch { return null; }
}
function writeGistCache(home, login, gist, now) {
  // 못 써도 공개는 성공이다 — 다음에 목록에서 다시 찾으면 된다
  try {
    const file = cachePath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ login, gist, updatedAt: now.toISOString() }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* 무시 */ }
}

// ── 공개: 순위판 참가 여부 ──────────────────────────────────────────────
/**
 * Pages 의 members.json 에 내 로그인이 "이 gist" 로 올라 있는가. 로그인은 있는데 gist 가 다르면
 * false — 순위판이 옛 gist 를 읽고 있으니 다시 참가해야 한다(참가 이슈는 기존 줄을 바꾼다).
 * 못 읽으면(네트워크·아직 배포 전) null.
 */
export async function checkMember({ fetch = globalThis.fetch, site = DEFAULT_SITE, login, gist, timeoutMs = 10_000 }) {
  try {
    const url = new URL('members.json', site.endsWith('/') ? site : site + '/');
    url.searchParams.set('t', String(Date.now()));   // Pages CDN 캐시를 피한다
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.members)) return null;
    return doc.members.some((m) => m && sameLogin(m.login, login) && typeof m.gist === 'string' && m.gist.toLowerCase() === gist.toLowerCase());
  } catch { return null; }
}

/**
 * 수집 결과를 내 공개 gist 에 올린다. 반환: { ok, login, gist, url, member, joinUrl, created } —
 * gist 의 문서가 이미 같아 고치지 않았으면 unchanged: true 가 붙는다.
 * 실패하면 PublishError(code) 를 던진다. 순서: 로그인 → 내용(화이트리스트·크기) → 기억한 gist 고치기
 * → (없거나 404) 목록에서 찾아 고치기 → (그래도 없으면) 새로 만들기 → 참가 여부.
 * 고치기 전에는 지금 내용을 읽어 비교하고, 같으면 고치지 않는다(공개 수정 기록이 쌓이지 않게).
 */
export async function publish({ entries, gh = ghRunner(), fetch = globalThis.fetch, home = os.homedir(), site = DEFAULT_SITE, now = new Date() }) {
  const u = gh(['api', 'user', '--jq', '.login']);
  if (u.error || u.status !== 0) throw ghError(u);
  const login = u.stdout.trim();
  if (!LOGIN_RE.test(login)) throw new PublishError('unknown', { detail: 'GitHub 로그인 이름을 읽지 못했어요' });

  // 올리기 직전에 매번 화이트리스트로 다시 깎는다 — 호출하는 쪽이 무엇을 넘기든
  const content = serializePayload(buildPayload(entries, login, now));
  const doc = JSON.parse(content);   // 비교는 실제로 올라갈 글을 되읽은 것으로

  // 이 gist 에 이미 같은 문서가 있으면 고친 셈 친다. 한 번 읽은 gist 는 다시 읽지 않는다.
  const read = new Set();
  const unchanged = (gid) => {
    if (!gid || read.has(gid)) return null;
    read.add(gid);
    const cur = readGist(gh, gid, login);
    return cur && samePublished(cur.doc, doc) ? { ok: true, gist: { id: gid, url: cur.url }, created: false, unchanged: true } : null;
  };

  const cache = readGistCache(home);
  let id = cache && sameLogin(cache.login, login) ? cache.gist : null;   // 다른 계정으로 바꿨으면 기억은 버린다
  let res = null;
  if (id) {
    res = unchanged(id) || writeGist(gh, id, content, login);
    if (!res.ok && res.http === 404 && !res.hinted) id = null;   // 지워진 gist — 목록에서 다시 찾는다
    else if (!res.ok) throw res.err;
  }
  if (!id) {
    id = searchGist(gh, login);
    res = unchanged(id) || writeGist(gh, id, content, login);   // id 가 null 이면 새로 만든다
    if (!res.ok) throw res.err;                // 있는 gist 인데 404 = gist 권한 없음 (write 분류)
  }
  writeGistCache(home, login, res.gist.id, now);

  const member = await checkMember({ fetch, site, login, gist: res.gist.id });
  return { ok: true, ...(res.unchanged ? { unchanged: true } : {}), login, gist: res.gist.id, url: res.gist.url, member,
    joinUrl: joinUrl(res.gist.id), created: res.created };
}

// ── 실행 ────────────────────────────────────────────────────────────────
const fmt = (n) => Math.round(n).toLocaleString(KO ? 'ko-KR' : 'en-US');
const tok = (n) => {
  if (KO) {
    const 억 = 1e8, 만 = 1e4;
    return n >= 억 ? (n / 억).toFixed(n >= 10 * 억 ? 1 : 2) + '억'
      : n >= 만 ? (n / 만).toFixed(n >= 100 * 만 ? 0 : 1) + '만' : fmt(n);
  }
  return n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + 'B'
    : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : fmt(n);
};

function printSummary(results) {
  const LABEL = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };
  for (const r of results) {
    const t = r.totals;
    const rows = Object.entries(r.byModel).sort((a, b) => b[1].total - a[1].total);
    const max = rows[0]?.[1].total || 1;
    const bar = (v, w = 20) => '█'.repeat(Math.max(1, Math.round((v / max) * w)));
    const reuse = t.cacheRead + t.cacheWrite + t.input;
    console.log(`
┌──────────────────────────────────────────────────────────┐
│  ${LABEL[r.tool].padEnd(14)}${String(r.name).padEnd(40)}│
└──────────────────────────────────────────────────────────┘
  ${L('period').padEnd(16)}${r.range.from} ~ ${r.range.to}  (${r.range.activeDays} ${L('days')})
  ${L('totalTokens').padEnd(16)}${fmt(t.total)}   (${tok(t.total)})
    - ${L('input').padEnd(18)}${fmt(t.input).padStart(15)}
    - ${L('output').padEnd(18)}${fmt(t.output).padStart(15)}${r.tool === 'claude' ? '' : '   (' + L('reasoningIncl') + ')'}
    - ${L('cacheWrite').padEnd(18)}${fmt(t.cacheWrite).padStart(15)}${r.tool === 'codex' ? '   (' + L('notReported') + ')' : ''}
    - ${L('cacheRead').padEnd(18)}${fmt(t.cacheRead).padStart(15)}   (${(t.cacheRead / reuse * 100).toFixed(1)}%)
  ${L('responses').padEnd(16)}${fmt(t.messages)}   |  ${L('sessionsL')} ${fmt(r.sessions)}${r.subagents ? `  |  ${L('subagents')} ${fmt(r.subagents)}` : ''}
  ${L('apiEquiv').padEnd(16)}$${fmt(t.cost)}   ${L('notBilled')}

  ${L('byModel')}`);
    for (const [n, v] of rows) console.log(`    ${n.padEnd(18)} ${bar(v.total).padEnd(21)} ${tok(v.total).padStart(8)}  $${fmt(v.cost)}`);
  }
  if (results.length > 1) {
    console.log('\n  -- ' + L('compare') + ' ----------------------------------------');
    for (const r of results) console.log(`    ${LABEL[r.tool].padEnd(13)} ${tok(r.totals.total).padStart(9)}   ${L('output')} ${tok(r.totals.output).padStart(8)}   $${fmt(r.totals.cost).padStart(8)}`);
    console.log('    * ' + L('tokenizerNote'));
  }
}

const say = (s) => process.stdout.write(redact(s));
/** 실패 보고. --publish --json 이면 표준 출력에 { ok:false, error } 한 줄, 아니면 표준 오류에 사람 말로. */
function fail(e) {
  const pe = e instanceof PublishError ? e : new PublishError('unknown', { detail: e && e.message });
  if (JSON_OUT) say(JSON.stringify({ ok: false, error: { code: pe.code, message: pe.ko } }) + '\n');
  else console.error('\n  [' + L('failed') + '] ' + (KO ? pe.ko : pe.en) + '\n');
  process.exitCode = 1;   // exit() 는 파이프로 나가는 표준 출력을 자를 수 있다
}

async function main() {
  const SITE = flag('base') || process.env.TOKEN_METER_BASE || DEFAULT_SITE;

  if (TOOL !== 'auto' && !TOOLS.includes(TOOL)) {
    return fail(new PublishError('unknown', { ko: `--tool 값이 이상합니다: ${TOOL} (claude | codex | gemini)`, en: `Unknown --tool: ${TOOL} (claude | codex | gemini)` }));
  }
  const results = [];
  for (const t of TOOL === 'auto' ? TOOLS : [TOOL]) {
    const r = t === 'claude' ? collectClaude() : t === 'codex' ? collectCodex() : collectGemini();
    if (r) results.push(r);
  }
  if (!results.length) {
    const where = `Claude: ${CLAUDE_ROOT} / Codex: ${CODEX_ROOT}/sessions / Gemini: ${GEMINI_ROOT}/tmp`;
    return fail(new PublishError('unknown', {
      ko: `로그를 못 찾았습니다 (${where}). --dir / --codex-dir / --gemini-dir 로 경로를 지정해 주세요.`,
      en: `No logs found (${where}). Point to them with --dir / --codex-dir / --gemini-dir.` }));
  }

  if (!QUIET) printSummary(results);
  if (readErrors.length) {
    console.error('\n  ! ' + L('readFail', readErrors.length));
    for (const [f, why] of readErrors.slice(0, 5)) console.error(`     ${why}  ${f}`);
    if (readErrors.length > 5) console.error(`     ... +${readErrors.length - 5} more`);
  }

  if (PUBLISH) {
    if ((SINCE || UNTIL || TOOL !== 'auto') && !JSON_OUT) console.error('\n  ! ' + L('partialWarn'));
    let r;
    try { r = await publish({ entries: results, site: SITE }); } catch (e) { return fail(e); }
    if (JSON_OUT) {
      // 계약: 표준 출력에는 이 객체 하나만 (바뀐 것이 없어 고치지 않았으면 unchanged: true 가 붙는다)
      say(JSON.stringify({ ok: true, ...(r.unchanged ? { unchanged: true } : {}), login: r.login, gist: r.gist, url: r.url,
        member: r.member, joinUrl: r.joinUrl }) + '\n');
    } else {
      console.log(`\n  == ${L(r.unchanged ? 'unchanged' : 'published')} ${'='.repeat(40)}`);
      console.log(`  GitHub  ${r.login}`);
      console.log(`  gist    ${r.url}`);
      if (r.created) console.log('  ' + L('created'));
      if (r.member === true) console.log(`  ${L('memberYes')} ${SITE}\n`);
      else console.log(`  ${r.member === false ? L('memberNo') : L('memberUnknown')}\n    ${r.joinUrl}\n`);
    }
    return;
  }

  // --json-only 는 파이프용이라 표준 출력만 낸다 — 클립보드도 파일도 건드리지 않는다
  // (맥 앱이 켤 때와 팝오버를 열 때마다 이 모드로 부른다). 붙여넣기 제출은 없어졌다.
  if (QUIET) process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : results) + '\n');
  else console.log(`\n  ${L('publishHint')}\n`);
}

// 경로에 공백·한글이 있으면 import.meta.url 은 %XX 로 적히고, 심볼릭 링크면 argv 와 다르게 풀린다 —
// 글자 그대로 비교하면 "직접 실행이 아님"으로 보고 아무것도 하지 않은 채 끝난다(eta.mjs 와 같은 방식).
const realPath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
// 예상 못 한 예외도 --json 이면 계약대로 JSON 한 줄로 끝낸다(앱이 해석할 수 있게)
if (isMain) await main().catch(fail);
