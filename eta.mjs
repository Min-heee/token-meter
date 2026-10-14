#!/usr/bin/env node
/**
 * 토큰 계량기 — 늦어도 몇 시 (돌고 있는 Claude Code 워크플로의 완료 상한)
 *
 * "약 12분 남음" 같은 숫자는 맞히지 못한다(실측: 2배 안 적중 절반). 대신 내 지난 워크플로
 * 기록으로 "10번 중 9번은 이 시각 안에 끝났다"는 상한을 내고, 그 상한이 실제로 얼마나
 * 지켜졌는지(적중 기록)를 함께 보여준다.
 *
 * 대상은 워크플로뿐이다. 일반 요청은 대부분 2분 안에 끝나고 상한이 실제의 19배로 부풀어 쓸모가 없다.
 *
 * 프라이버시: 완전히 로컬이다. 아무것도 서버로 보내지 않는다. 읽는 것은
 *   - 끝난 워크플로 기록(workflows/wf_*.json)의 시작 시각·소요 시간·단계 목록
 *   - 워크플로 일지(journal.jsonl)에서 에이전트 id·단계 이름·끝났는지 여부
 *   - 에이전트 기록 파일의 생성·수정 시각(파일 내용은 열지 않는다)
 *   - 워크플로 스크립트 머리의 이름·단계 목록
 *   - 그 워크플로를 띄운 세션의 이름(custom-title.json, 또는 세션 기록 끝부분의 제목 줄만)
 *
 * 사용법:
 *   node eta.mjs                 # 돌고 있는 워크플로와 "늦어도 몇 시"
 *   node eta.mjs --json          # 앱용 JSON
 *   node eta.mjs --backtest      # 내 기록으로 상한이 얼마나 지켜졌는지 다시 재기
 *   node eta.mjs --level 0.8     # 안전 수준(기본 0.9 = 10번 중 9번)
 *   node eta.mjs --dir <claude경로> --state-dir <상태 저장 폴더>
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ── 상수 ────────────────────────────────────────────────────────────────
export const LOCK_AFTER_S = 120;        // 이 시각부터 상한을 고정한다(그 전은 잠정)
export const STALE_MS = 30 * 60 * 1000; // 이만큼 아무 파일도 안 바뀌면 죽은 실행으로 본다
export const AGENT_SILENT_S = 15 * 60;  // 결과 없이 이만큼 조용한 에이전트는 버려진 것으로 본다
export const ATTEMPT_GAP_S = 5 * 60;    // 아무 에이전트도 안 돌던 틈이 이보다 길면 그 뒤를 새 시도(재개)로 본다
export const MIN_MODEL = 60;            // 진행률 모델을 쓰려면 필요한 과거 실행 수(그 시점까지 돌고 있던 것)
export const MIN_EMPIRICAL = 20;        // 이보다 적으면 상한을 내지 않는다
export const FORGET_MS = 24 * 3600 * 1000; // 이만큼 안 보인 실행의 고정 상한은 잊는다
// 적중 기록을 재는 시점들. 상한을 정한 경과 시간에 가장 가까운 것으로 잰다 —
// 20분에 정한 상한의 성적은 2분에 정한 상한의 성적과 다르다.
export const TRACK_AT = [120, 300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200];
const CACHE_VERSION = 3;

// ── 통계 도구 ───────────────────────────────────────────────────────────
export function quantile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/**
 * 표준화 + 릿지 회귀. 예측 함수를 돌려준다.
 * 예측할 때 특징을 학습 범위 안으로 자른다 — 본 적 없는 값(예: 0초 만에 끝난 에이전트)에서
 * 직선을 그대로 늘리면 터무니없이 짧은 상한이 나온다.
 */
function ridge(X, y, lam) {
  const n = X.length, d = X[0].length;
  const mu = Array(d).fill(0), sd = Array(d).fill(0);
  const lo = Array(d).fill(Infinity), hi = Array(d).fill(-Infinity);
  for (const r of X) r.forEach((v, i) => { mu[i] += v / n; if (v < lo[i]) lo[i] = v; if (v > hi[i]) hi[i] = v; });
  for (const r of X) r.forEach((v, i) => { sd[i] += (v - mu[i]) ** 2 / n; });
  sd.forEach((v, i) => { sd[i] = Math.sqrt(v) || 1; });
  const ym = y.reduce((a, b) => a + b, 0) / n;
  const A = Array.from({ length: d }, () => Array(d + 1).fill(0));
  for (let k = 0; k < n; k++) {
    const z = X[k].map((v, i) => (v - mu[i]) / sd[i]);
    for (let i = 0; i < d; i++) {
      A[i][d] += z[i] * (y[k] - ym);
      for (let l = 0; l < d; l++) A[i][l] += z[i] * z[l];
    }
  }
  for (let i = 0; i < d; i++) A[i][i] += lam;
  for (let i = 0; i < d; i++) {
    let p = i;
    for (let r = i + 1; r < d; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < d; r++) {
      if (r === i) continue;
      const m = A[r][i] / A[i][i];
      for (let c = i; c <= d; c++) A[r][c] -= m * A[i][c];
    }
  }
  const w = A.map((r, i) => r[d] / r[i]);
  return (x) => ym + x.reduce((a, v, i) => a + w[i] * (Math.min(hi[i], Math.max(lo[i], v)) - mu[i]) / sd[i], 0);
}

// ── 진행 상태 → 특징 ────────────────────────────────────────────────────
// run = { S(ms), D(초, 끝난 실행만), P(선언된 단계 수), ag: [[s, m, fin, ph], ...] }
//   s = 에이전트 시작(초), m = 그 기록 파일이 마지막으로 바뀐 시각(초), fin = 일지에 결과가 있는가(0/1), ph = 단계 번호
// 끝난 실행도 돌고 있는 실행도 같은 모양·같은 출처(일지 + 파일 시각)로 만든다 — 학습 때 본 것과
// 실시간에 보는 것이 어긋나지 않게. 대기 중인 에이전트 수·총 개수는 실시간으로 알 수 없어 쓰지 않는다.
export function progressAt(run, t) {
  let started = 0, done = 0, running = 0, cur = 1, doneDur = 0, runEl = 0;
  for (const [s, m, fin, ph] of run.ag) {
    if (s > t) continue;
    const isDone = fin && m <= t;
    if (!fin && t >= m + AGENT_SILENT_S) continue;   // 결과 없이 오래 조용함 = 버려진 시도
    started++;
    if (ph > cur) cur = ph;
    if (isDone) { done++; doneDur += m - s; } else { running++; runEl += t - s; }
  }
  return {
    started, done, running, cur, total: Math.max(run.P || 1, cur),
    meanDone: done ? doneDur / done : t, runEl: running ? runEl / running : 0,
  };
}

function features(run, t) {
  const s = progressAt(run, t);
  return [
    Math.log(s.started + 1), Math.log(s.done + 1), Math.log(s.running + 1),
    s.cur, s.total, s.cur / s.total,
    Math.log(s.meanDone + 1), Math.log(s.runEl + 1), s.done / Math.max(1, s.started),
  ];
}

/**
 * 경과 t초 시점에 "남은 시간" 상한(초)을 낸다.
 * history: 끝난 실행들(시작 시각 오름차순). run: 지금 보고 있는 실행.
 * 방법: 로그 남은 시간에 릿지 회귀 → 최근 30% 실행의 잔차에서 한쪽 분위수를 더한다(분할 컨포멀).
 * 과거 실행이 적거나 이 실행의 단계 수를 모르면(run.P == null) 모델 없이
 * "그 시점까지 돌고 있던 실행들의 남은 시간" 분위수만 쓴다.
 * typical 은 같은 보정 잔차의 중앙값만큼 옮긴 값이다 — 로그 평균을 그대로 되돌리면 실제보다 이르게 나온다.
 */
export function upperBound(history, run, t, level = 0.9) {
  const alive = history.filter((r) => r.D > t + 5);
  const n = alive.length;
  if (n < MIN_EMPIRICAL) return { ok: false, n, need: MIN_EMPIRICAL };
  const y = alive.map((r) => Math.log(r.D - t));
  const adj = (m) => Math.min(1, Math.ceil((m + 1) * level) / m); // 유한 표본 보정
  if (n < MIN_MODEL || run.P == null) {
    return { ok: true, n, method: 'empirical', latest: Math.exp(quantile(y, adj(n))), typical: Math.exp(quantile(y, 0.5)) };
  }
  const X = alive.map((r) => features(r, t));
  const nFit = Math.floor(n * 0.7);
  const cal = ridge(X.slice(0, nFit), y.slice(0, nFit), 5);
  const res = X.slice(nFit).map((x, i) => y[nFit + i] - cal(x));
  const add = quantile(res, adj(res.length));
  const pred = ridge(X, y, 5)(features(run, t));
  return { ok: true, n, method: 'model', latest: Math.exp(pred + add), typical: Math.exp(pred + quantile(res, 0.5)) };
}

/**
 * 적중 기록: 각 실행을 "그때 이미 끝나 있던 실행들만 아는 상태"에서 경과 t초 시점에 예측했다면
 * 상한을 넘겼는지. 화면에 "N번 중 M번 넘김"으로 그대로 보여준다.
 * 먼저 시작했어도 그 시점에 아직 돌고 있던 실행은 쓰지 않는다(실시간에는 소요 시간을 알 수 없다).
 */
export function trackRecord(history, level = 0.9, t = LOCK_AFTER_S, onEach = null) {
  let n = 0, exceeded = 0;
  const ratios = [];
  for (let i = MIN_EMPIRICAL; i < history.length; i++) {
    const run = history[i];
    if (run.D <= t + 5) continue;
    const at = run.S + t * 1000;
    const b = upperBound(history.slice(0, i).filter((r) => r.S + r.D * 1000 <= at), run, t, level);
    if (!b.ok) continue;
    n++;
    const actual = run.D - t;
    if (actual > b.latest) exceeded++;
    ratios.push(b.latest / actual);
    if (onEach) onEach(run, b, actual);
  }
  return { n, exceeded, rate: n ? exceeded / n : null, medianRatio: n ? quantile(ratios, 0.5) : null, level };
}

// ── 파일 읽기 ───────────────────────────────────────────────────────────
const ls = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };
const isDir = (p) => stat(p)?.isDirectory() === true;

/**
 * 모든 프로젝트 폴더에 걸쳐 워크플로 파일 위치를 모은다.
 * 한 세션이 작업 폴더를 옮기면(워크트리 등) 에이전트 기록과 스크립트·완료 기록이 서로 다른
 * 프로젝트 폴더에 놓인다 — 같은 폴더만 보면 끝난 실행이 계속 도는 것처럼 보인다.
 */
function scan(root) {
  const records = new Map();   // id → { file, mtimeMs, size }  끝난(또는 멈춘) 시도의 기록
  const scripts = new Map();   // id → { file, name }
  const dirs = new Map();      // id → { dir, proj, session }  에이전트 기록 폴더
  const transcripts = new Map(); // 세션 id → 세션 기록 파일(<프로젝트>/<세션>.jsonl)
  const titleFiles = new Map();  // 세션 id → [custom-title.json …] (세션이 프로젝트 폴더 여럿에 걸칠 수 있다)
  for (const proj of ls(root)) {
    const pd = path.join(root, proj);
    if (!isDir(pd)) continue;
    for (const s of ls(pd)) {
      if (s.endsWith('.jsonl')) { transcripts.set(s.slice(0, -'.jsonl'.length), path.join(pd, s)); continue; }
      const tf = path.join(pd, s, 'custom-title.json');
      if (stat(tf)) titleFiles.set(s, [...(titleFiles.get(s) || []), tf]);
      const wd = path.join(pd, s, 'workflows');
      for (const f of ls(wd)) {
        const m = f.match(/^(wf_.+)\.json$/);
        if (!m) continue;
        const st = stat(path.join(wd, f));
        if (st) records.set(m[1], { file: path.join(wd, f), mtimeMs: st.mtimeMs, size: st.size });
      }
      for (const f of ls(path.join(wd, 'scripts'))) {
        const m = f.match(/^(?:(.*)-)?(wf_[A-Za-z0-9]+-[A-Za-z0-9]+)\.js$/);
        if (m) scripts.set(m[2], { file: path.join(wd, 'scripts', f), name: m[1] || null });
      }
      const ld = path.join(pd, s, 'subagents', 'workflows');
      for (const id of ls(ld)) if (id.startsWith('wf_') && isDir(path.join(ld, id))) dirs.set(id, { dir: path.join(ld, id), proj, session: s });
    }
  }
  return { records, scripts, dirs, transcripts, titleFiles };
}

/**
 * 세션 이름. 데스크톱 앱이 남기는 custom-title.json 을 먼저 보고, 없으면 세션 기록의 제목 줄
 * ({"type":"custom-title"…} / {"type":"ai-title"…})을 끝부분에서 찾는다. 기록이 수백 MB일 수 있어 통째로 읽지 않는다
 * — 제목 줄은 이름이 바뀔 때마다 다시 붙으므로 끝 2MB 안에 거의 늘 있다. 못 찾으면 null.
 */
export function sessionTitle(found, sessionId) {
  for (const f of found.titleFiles?.get(sessionId) || []) {
    try { const t = JSON.parse(fs.readFileSync(f, 'utf8')).customTitle; if (t) return String(t); } catch { /* 다음 후보 */ }
  }
  const file = found.transcripts?.get(sessionId);
  const st = file && stat(file);
  if (!st) return null;
  const pick = (text) => {
    let custom = null, ai = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('{"type":"custom-title"') && !line.startsWith('{"type":"ai-title"')) continue;
      try { const o = JSON.parse(line); if (o.customTitle) custom = String(o.customTitle); else if (o.aiTitle) ai = String(o.aiTitle); } catch { /* 잘린 첫 줄 */ }
    }
    return custom || ai;
  };
  const CHUNK = 2 * 1024 * 1024;
  const read = (pos, len) => {
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b.toString('utf8'); } finally { fs.closeSync(fd); }
  };
  try {
    return pick(read(Math.max(0, st.size - CHUNK), Math.min(st.size, CHUNK))) || (st.size > CHUNK ? pick(read(0, CHUNK)) : null);
  } catch { return null; }
}

/**
 * 워크플로 폴더 하나에서 에이전트별 [생성 시각, 마지막 수정 시각, 결과 유무, 단계 이름]을 읽는다.
 * 일지의 결과 줄은 클 수 있어 앞머리만 본다. 에이전트 기록 파일은 시각만 보고 열지 않는다.
 */
function readAgents(wdir) {
  const phaseOf = new Map(), finished = new Set();
  let journal = '';
  try { journal = fs.readFileSync(path.join(wdir, 'journal.jsonl'), 'utf8'); } catch { /* 일지 없으면 파일만으로 */ }
  for (const line of journal.split('\n')) {
    const type = line.match(/^\{"type":"([^"]+)"/)?.[1];
    if (!type) continue;
    const agentId = line.slice(0, 600).match(/"agentId":"([^"]+)"/)?.[1];
    if (!agentId) continue;
    if (type === 'started') {
      let phase = null;
      try { phase = JSON.parse(line).phase ?? null; } catch { /* 단계 없이 */ }
      phaseOf.set(agentId, phase);
    } else finished.add(agentId);   // result · failed
  }
  const agents = [];
  let lastTouch = stat(path.join(wdir, 'journal.jsonl'))?.mtimeMs || 0;
  for (const n of ls(wdir)) {
    const m = n.match(/^agent-(.+)\.jsonl$/);
    if (!m) continue;
    const st = stat(path.join(wdir, n));
    if (!st) continue;
    if (st.mtimeMs > lastTouch) lastTouch = st.mtimeMs;
    agents.push({ b: st.birthtimeMs || st.mtimeMs, m: st.mtimeMs, fin: finished.has(m[1]) ? 1 : 0, phase: phaseOf.get(m[1]) ?? null });
  }
  return { agents, lastTouch };
}

/**
 * 에이전트 목록을 시작 시각 S 기준의 [s, m, fin, ph] 로 바꾼다. S 이전에 시작한 것(앞선 시도)은 뺀다.
 * titles 는 선언된 단계 제목 — 선언에 없는 제목은 뒤에 덧붙여 번호를 준다(덧붙인 목록도 돌려준다).
 */
function toEntries(agents, S, titles) {
  const order = [...titles];
  const index = (title) => {
    if (title == null) return 1;
    let i = order.indexOf(title);
    if (i < 0) { order.push(title); i = order.length - 1; }
    return i + 1;
  };
  const ag = agents.filter((a) => a.b >= S - 5000)
    .map((a) => [Math.max(0, (a.b - S) / 1000), Math.max(0, (a.m - S) / 1000), a.fin, index(a.phase)]);
  return { ag, order };
}

/**
 * 끝난 워크플로 기록 한 건을 예측에 필요한 숫자만 남겨 줄인다. 쓸 수 없으면 null.
 * 진행 상태는 실시간과 같은 출처(wdir 의 일지 + 파일 시각)에서 만든다. 폴더가 없을 때만
 * 기록 안의 workflowProgress 로 대신한다.
 */
export function distill(o, wdir = null) {
  if (!o || o.status !== 'completed' || !o.startTime || !o.durationMs) return null;
  const S = o.startTime, D = o.durationMs / 1000;
  if (D < 30) return null;
  const titles = (o.phases || []).map((p) => p.title);
  let ag = wdir ? toEntries(readAgents(wdir).agents, S, titles).ag : [];
  if (!ag.length) {
    const byId = new Map();
    for (const p of o.workflowProgress || []) {
      if (p.type === 'workflow_agent' && p.startedAt) byId.set(p.agentId || `${p.index}:${p.label}`, p);
    }
    ag = [...byId.values()].map((p) => {
      const s = (p.startedAt - S) / 1000;
      return [s, p.durationMs ? s + p.durationMs / 1000 : D, 1, p.phaseIndex || 1];
    });
  }
  if (!ag.length) return null;
  return { id: o.runId, S, D, P: Math.max(titles.length, 1), ag };
}

/** 끝난 워크플로 전부. 큰 JSON·일지를 매번 다시 읽지 않도록 줄인 결과를 캐시에 둔다. */
export function loadHistory(root, stateDir, found = scan(root)) {
  const cachePath = stateDir ? path.join(stateDir, 'eta-cache.json') : null;
  let cache = { v: CACHE_VERSION, files: {} };
  if (cachePath) {
    try { const c = JSON.parse(fs.readFileSync(cachePath, 'utf8')); if (c.v === CACHE_VERSION) cache = c; } catch { /* 없으면 새로 만든다 */ }
  }
  const next = { v: CACHE_VERSION, files: {} };
  let dirty = false, unreadable = 0;
  const runs = [];
  for (const [id, r] of found.records) {
    const key = `${r.mtimeMs}:${r.size}`;
    let rec = cache.files[id];
    if (!rec || rec.key !== key) {
      let run = null, bad = false;
      try { run = distill(JSON.parse(fs.readFileSync(r.file, 'utf8')), found.dirs.get(id)?.dir ?? null); } catch { bad = true; }
      rec = { key, run, bad };
      dirty = true;
    }
    if (rec.bad) unreadable++;   // 읽기 실패는 캐시에 묻히지 않게 매번 센다
    next.files[id] = rec;
    if (rec.run) runs.push(rec.run);
  }
  if (cachePath && (dirty || Object.keys(cache.files).length !== Object.keys(next.files).length)) writeJson(cachePath, next);
  runs.sort((a, b) => a.S - b.S);
  return { runs, unreadable };
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* 캐시·상태 저장 실패는 예측을 막지 않는다 */ }
}

/** 스크립트 머리의 `export const meta = {...}` 에서 이름과 단계 제목을 뽑는다. */
export function parseMeta(src) {
  const at = src.indexOf('export const meta');
  if (at < 0) return { name: null, phases: [] };
  const open = src.indexOf('{', at);
  if (open < 0) return { name: null, phases: [] };
  let depth = 0, quote = null, end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = i; break; }
  }
  const block = src.slice(open, end < 0 ? open + 4000 : end + 1);
  const str = (re) => { const m = block.match(re); return m ? m[2] : null; };
  const name = str(/\bname\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
  const pa = block.indexOf('phases');
  const phases = [];
  if (pa >= 0) {
    const re = /\btitle\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
    let m;
    while ((m = re.exec(block.slice(pa)))) phases.push(m[2]);
  }
  return { name, phases };
}

/**
 * 이번 시도가 시작한 시각. 워크플로를 재개하면 같은 폴더에 앞선 시도의 에이전트가 남아 있어
 * 폴더·스크립트 생성 시각은 며칠 전일 수 있다. 에이전트가 하나도 안 돌던 긴 틈 뒤를 새 시도로 본다.
 * (과거 218건에 대 보면 215건이 실제 시작과 30초 안에서 맞는다.)
 */
function attemptStart(agents, now) {
  const spans = agents
    .map((a) => [a.b, a.fin || now - a.m > AGENT_SILENT_S * 1000 ? a.m : now])
    .sort((x, y) => x[0] - y[0]);
  if (!spans.length) return null;
  let start = spans[0][0], end = spans[0][1];
  for (const [b, e] of spans.slice(1)) {
    if (b > end + ATTEMPT_GAP_S * 1000) { start = b; end = e; } else if (e > end) end = e;
  }
  return start;
}

/**
 * 돌고 있는 워크플로(최근에 파일이 바뀌었고, 그 뒤에 쓰인 완료 기록이 없는 실행).
 * pinned: 이미 지켜보던 실행의 시작 시각(id → ms). 한 시도 안에서도 에이전트가 하나도 안 도는 긴 틈이
 * 생기므로(재시도 대기, 잠자기), 한 번 정한 시작 시각은 완료 기록이 새로 쓰이기 전에는 바꾸지 않는다.
 * '긴 틈 뒤는 새 시도' 규칙은 처음 볼 때만 쓴다.
 */
export function liveRuns(root, now = Date.now(), found = scan(root), pinned = new Map()) {
  const out = [];
  for (const [id, { dir, proj, session }] of found.dirs) {
    let { agents, lastTouch } = readAgents(dir);
    if (now - lastTouch > STALE_MS) continue;
    // 완료 기록은 시도가 끝날 때 쓰인다. 그 뒤로 폴더가 다시 바뀌었다면 재개된 것이다.
    const prevEnd = found.records.get(id)?.mtimeMs ?? null;
    if (prevEnd != null) {
      if (lastTouch <= prevEnd + 10_000) continue;
      agents = agents.filter((a) => a.b > prevEnd);
    }
    const pin = pinned.get(id);
    const S = pin != null && (prevEnd == null || prevEnd < pin) ? pin : attemptStart(agents, now);
    if (S == null) continue;

    let meta = { name: null, phases: [] };
    const script = found.scripts.get(id);
    if (script) {
      try { meta = parseMeta(fs.readFileSync(script.file, 'utf8').slice(0, 20000)); } catch { /* 이름 없이 진행 */ }
      if (!meta.name) meta.name = script.name;
    }
    const { ag, order } = toEntries(agents, S, meta.phases);
    // 다른 실행의 스크립트 파일로 띄운 실행은 자기 id 의 스크립트가 없다 — 단계 수를 모르는 것이지 1단계가 아니다
    const P = script ? Math.max(meta.phases.length, 1) : null;
    out.push({ id, proj, name: meta.name, S, P, titles: order, ag, quietSec: (now - lastTouch) / 1000, session: { id: session, title: sessionTitle(found, session) } });
  }
  return out.sort((a, b) => a.S - b.S);
}

// ── 상한 고정 ───────────────────────────────────────────────────────────
// 상한을 볼 때마다 다시 계산하면 오래 돌수록 뒤로 밀려 "늦어도"가 의미를 잃는다.
// 처음 볼 때(보통 시작 2분 뒤) 한 번 정하고, 그 시각을 넘겼을 때만 다시 계산한다(넘긴 횟수를 함께 표시).
const nearestTrackAt = (sec) => TRACK_AT.reduce((best, b) => (Math.abs(Math.log(sec / b)) < Math.abs(Math.log(sec / best)) ? b : best));

export function estimate({ root, stateDir, level = 0.9, now = Date.now() }) {
  const found = scan(root);
  const { runs: history, unreadable } = loadHistory(root, stateDir, found);
  const statePath = stateDir ? path.join(stateDir, 'eta-state.json') : null;
  let saved = {}, savedTrack = null;
  if (statePath) {
    try { const j = JSON.parse(fs.readFileSync(statePath, 'utf8')); saved = j.runs || {}; savedTrack = j.track || null; } catch { /* 처음 */ }
  }
  // 상태 칸은 "실행 id@수준" — 터미널에서 다른 --level 로 한 번 불러도 앱이 고정해 둔 상한은 그대로다.
  // (옛 형식은 실행 id 만 키로 썼다: 수준이 같으면 이어받고, 아니면 버린다.)
  const idOf = (key) => key.split('@')[0];
  const keyOf = (id) => `${id}@${level}`;
  const nextState = {};
  const pinned = new Map();
  for (const [key, st] of Object.entries(saved)) {
    const id = idOf(key);
    if (!st || st.S == null) continue;
    // 그 시도가 끝났거나(시작 뒤에 완료 기록이 쓰임) 오래 안 보였으면 잊는다. 잠깐 목록에서 빠진 것만으로는 지우지 않는다.
    if ((found.records.get(id)?.mtimeMs ?? 0) > st.S || now - (st.seenAt ?? now) > FORGET_MS) continue;
    nextState[key.includes('@') ? key : `${id}@${st.level}`] = st;
    if (!pinned.has(id)) pinned.set(id, st.S);
  }

  // 적중 기록은 상한을 정한 시점별로 잰다. 기록이 늘 때만 다시 계산하도록 상태 파일에 함께 둔다.
  const sig = `${history.length}:${history.length ? history[history.length - 1].S : 0}`;
  const trackItems = savedTrack?.sig === sig ? savedTrack.items : {};
  const trackFor = (lockedAtSec) => {
    const at = nearestTrackAt(Math.max(LOCK_AFTER_S, lockedAtSec));
    const k = `${level}:${at}`;
    if (!trackItems[k]) { const r = trackRecord(history, level, at); trackItems[k] = { n: r.n, exceeded: r.exceeded, atSec: at }; }
    return trackItems[k];
  };

  const running = [];
  for (const run of liveRuns(root, now, found, pinned)) {
    const t = Math.max(1, (now - run.S) / 1000);
    const prog = progressAt(run, t);
    const key = keyOf(run.id);
    // 완료 기록이 남은 재개만 새 시도로 본다(시작 시각이 달라진다) — 앞선 시도의 상한은 물려받지 않는다
    const prev = nextState[key] && Math.abs(nextState[key].S - run.S) < 60_000 ? nextState[key] : null;
    const overdue = !!prev?.locked && now > prev.latestBy;
    let st = prev, reason = null;
    if (!prev || !prev.locked || overdue) {
      // 넘긴 횟수는 넘긴 순간 한 번만 센다(lapsed = 넘겼는데 새 상한을 못 낸 상태)
      const revised = (prev?.revised || 0) + (overdue && !prev.lapsed ? 1 : 0);
      const b = upperBound(history, run, Math.max(30, t), level);
      if (b.ok) {
        st = {
          level, S: run.S, locked: t >= LOCK_AFTER_S, lockedAtSec: Math.round(t), lapsed: false, revised, n: b.n, method: b.method,
          latestBy: Math.round(now + b.latest * 1000), typicalBy: Math.round(now + b.typical * 1000),
        };
      } else {
        // 이만큼 오래 돈 과거 실행이 너무 적다 — 지어내지 않고 못 낸다고 말한다
        st = overdue ? { ...prev, lapsed: true, revised } : null;
        reason = { kind: 'history', have: b.n, need: b.need };
      }
    }
    if (st) nextState[key] = { ...st, seenAt: now }; else delete nextState[key];
    // 도는 에이전트가 없는데 오래 조용하다 = 기록 없이 죽었을 수 있다. 상한을 내세우지 않는다.
    const stalled = prog.running === 0 && run.quietSec > AGENT_SILENT_S;
    const shown = st && !st.lapsed && !stalled ? st : null;
    running.push({
      runId: run.id, name: run.name, project: run.proj, session: run.session, startedAt: Math.round(run.S), elapsedSec: Math.round(t),
      phase: { cur: prog.cur, total: run.P == null ? null : prog.total, title: run.titles[prog.cur - 1] ?? null },
      agents: { started: prog.started, done: prog.done, running: prog.running },
      quietSec: Math.round(run.quietSec), stalled,
      latestBy: shown?.latestBy ?? null, typicalBy: shown && shown.typicalBy > now ? shown.typicalBy : null,
      typicalAt: shown?.typicalBy ?? null,   // 지났어도 남긴다 — 게이지에 '보통은 여기였다'를 표시하는 데 쓴다
      locked: shown?.locked ?? false, revised: st?.revised ?? 0,
      basis: shown ? { n: shown.n, method: shown.method } : null,
      track: shown?.locked ? trackFor(shown.lockedAtSec) : null,
      reason: shown ? null : stalled ? { kind: 'stalled' } : reason ?? (st?.lapsed ? { kind: 'history', have: st.n ?? 0, need: MIN_EMPIRICAL } : null),
    });
  }
  if (statePath && (Object.keys(nextState).length || Object.keys(saved).length)) {
    writeJson(statePath, { runs: nextState, track: { sig, items: trackItems } });
  }
  return { now, level, history: history.length, unreadable, running };
}

// ── 실행 ────────────────────────────────────────────────────────────────
// 경로에 공백·한글이 있으면 import.meta.url 은 %XX 로 적히고, 심볼릭 링크면 argv 와 다르게 풀린다 —
// 글자 그대로 비교하면 "직접 실행이 아님"으로 보고 아무것도 출력하지 않은 채 끝난다.
const realPath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => {
    const i = argv.indexOf('--' + n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  const has = (n) => argv.includes('--' + n);
  const root = flag('dir') || path.join(os.homedir(), '.claude', 'projects');
  // 다른 폴더를 보라고 했으면 기본 상태 폴더를 쓰지 않는다 — 앱이 고정해 둔 상한과 캐시가 통째로 비워진다
  const stateDir = flag('state-dir') || (flag('dir') ? null : path.join(os.homedir(), '.token-meter'));
  const level = Math.min(0.99, Math.max(0.5, Number(flag('level', '0.9')) || 0.9));
  const KO = /^ko([_-]|$)/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '');
  const clock = (ms) => {
    const d = new Date(ms), today = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return d.toDateString() === today.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };
  const mins = (s) => (s < 5400 ? `${Math.round(s / 60)}${KO ? '분' : 'm'}` : `${(s / 3600).toFixed(1)}${KO ? '시간' : 'h'}`);

  if (has('backtest')) {
    const { runs, unreadable } = loadHistory(root, null);
    console.log(KO ? `끝난 워크플로 ${runs.length}건` : `${runs.length} completed workflows`);
    if (unreadable) console.log(KO ? `읽지 못한 워크플로 기록 ${unreadable}건(빠짐)` : `${unreadable} workflow records could not be read (left out)`);
    for (const t of TRACK_AT) {
      const r = trackRecord(runs, level, t);
      if (r.n < 10) continue;
      console.log(KO
        ? `  ${mins(t)} 시점에 정한 상한: ${r.n}번 중 ${r.exceeded}번 넘김(${(r.rate * 100).toFixed(0)}%), 상한은 실제의 ${r.medianRatio.toFixed(1)}배(중앙값)`
        : `  bound set at ${mins(t)}: exceeded ${r.exceeded}/${r.n} (${(r.rate * 100).toFixed(0)}%), bound is ${r.medianRatio.toFixed(1)}x actual (median)`);
    }
  } else {
    const res = estimate({ root, stateDir, level });
    if (has('json')) console.log(JSON.stringify(res));
    else if (!res.running.length) console.log(KO ? '지금 돌고 있는 워크플로가 없습니다.' : 'No workflow is running.');
    else {
      for (const r of res.running) {
        const phase = r.phase.total == null ? '' : KO ? `, ${r.phase.total}단계 중 ${r.phase.cur}단계` : `, phase ${r.phase.cur}/${r.phase.total}`;
        const head = `${r.name || r.runId} — ${mins(r.elapsedSec)}${KO ? '째' : ' in'}${phase}, ${KO ? `에이전트 ${r.agents.done} 끝남·${r.agents.running} 도는 중` : `${r.agents.done} agents done, ${r.agents.running} running`}`;
        let tail;
        if (r.latestBy) {
          const typical = r.typicalBy ? (KO ? ` · 보통은 ${clock(r.typicalBy)}쯤` : ` · typically ~${clock(r.typicalBy)}`) : '';
          const track = r.track?.n ? (KO ? `\n  (${mins(r.track.atSec)} 시점에 정한 상한은 내 기록 ${r.track.n}번 중 ${r.track.exceeded}번 넘겼습니다)` : `\n  (bounds set at ${mins(r.track.atSec)} were exceeded ${r.track.exceeded} of ${r.track.n} times on your history)`) : '';
          tail = (KO ? `늦어도 ${clock(r.latestBy)}${r.locked ? '' : ' (잠정)'}${r.revised ? ` · ${r.revised}번 넘겨 다시 계산` : ''}`
            : `by ${clock(r.latestBy)} at the latest${r.locked ? '' : ' (provisional)'}${r.revised ? ` · revised ${r.revised}x` : ''}`) + typical + track;
        } else if (r.reason?.kind === 'stalled') {
          tail = KO ? `${mins(r.quietSec)}째 소식이 없습니다(끝났거나 멈췄을 수 있음)` : `no activity for ${mins(r.quietSec)} (may have ended or stopped)`;
        } else {
          tail = KO ? `${r.revised ? '예상을 넘겼습니다 · ' : ''}이만큼 오래 돈 기록이 ${r.reason?.have ?? 0}건뿐이라 상한을 못 냅니다(${r.reason?.need ?? MIN_EMPIRICAL}건 필요)`
            : `${r.revised ? 'past the bound · ' : ''}only ${r.reason?.have ?? 0} past runs lasted this long (need ${r.reason?.need ?? MIN_EMPIRICAL})`;
        }
        console.log(`${head}\n  ${tail}`);
      }
      if (res.unreadable) console.log(KO ? `읽지 못한 워크플로 기록 ${res.unreadable}건(예측에서 빠짐)` : `${res.unreadable} workflow records could not be read (left out)`);
    }
  }
}
