// eta.mjs 검증 — 합성 픽스처만 쓴다(실제 ~/.claude 는 건드리지 않는다).
// 실행: node --test eta.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseMeta, distill, progressAt, upperBound, trackRecord, liveRuns, loadHistory, estimate, quantile,
  MIN_EMPIRICAL, LOCK_AFTER_S, AGENT_SILENT_S, TRACK_AT,
} from '../eta.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;

// 결정적 난수(테스트가 매번 같은 값을 보도록)
function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }

/** 끝난 워크플로 기록 하나(원본 wf_*.json 모양). 에이전트가 많을수록 오래 걸리게 만든다. */
function fakeRecord(i, rnd, t0) {
  const agents = 2 + Math.floor(rnd() * 12);
  const per = 120 + rnd() * 600;                       // 에이전트 하나 2~12분
  const startTime = t0 + i * 3600_000;
  const progress = [];
  let end = 0;
  for (let a = 0; a < agents; a++) {
    const startedAt = startTime + Math.floor(a / 3) * per * 1000;   // 3개씩 동시에
    const durationMs = per * 1000 * (0.6 + rnd() * 0.8);
    end = Math.max(end, startedAt + durationMs - startTime);
    progress.push({ type: 'workflow_agent', agentId: `a${i}_${a}`, startedAt, durationMs, phaseIndex: a < agents / 2 ? 1 : 2 });
  }
  return { runId: `wf_hist${i}`, status: 'completed', startTime, durationMs: end + 2000, phases: [{ title: 'A' }, { title: 'B' }], workflowProgress: progress };
}
const fakeHistory = (n, seed) => { const rnd = rng(seed); return Array.from({ length: n }, (_, i) => distill(fakeRecord(i, rnd, 1.7e12))); };

function makeRoot(nHistory = 90) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-test-'));
  const sess = path.join(root, '-proj', '11111111-1111-1111-1111-111111111111');
  fs.mkdirSync(path.join(sess, 'workflows', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(sess, 'subagents', 'workflows'), { recursive: true });
  const rnd = rng(42);
  const t0 = Date.now() - (nHistory + 5) * 3600_000;
  for (let i = 0; i < nHistory; i++) {
    const rec = fakeRecord(i, rnd, t0);
    fs.writeFileSync(path.join(sess, 'workflows', `${rec.runId}.json`), JSON.stringify(rec));
  }
  return { root, sess, state: path.join(root, 'state') };
}

const setTime = (file, ms) => fs.utimesSync(file, ms / 1000, ms / 1000);
/** 생성 시각까지 과거로 옮긴 뒤(APFS 는 수정 시각을 생성 시각보다 앞으로 돌리면 생성 시각도 따라온다) 수정 시각을 정한다 */
const setBirthAndModified = (file, birthMs, modifiedMs) => { setTime(file, birthMs); setTime(file, modifiedMs); };

/** 돌고 있는 워크플로 하나: 스크립트 + 일지 + 에이전트 파일. agents = [{ id, phase, done }] */
function addLive(sess, id, agents = [{ id: 'x1', done: true }, { id: 'x2' }, { id: 'x3' }], { script = true } = {}) {
  if (script) {
    fs.writeFileSync(path.join(sess, 'workflows', 'scripts', `my-flow-${id}.js`),
      "export const meta = { name: 'my-flow', description: 'has } brace', phases: [{ title: 'Review' }, { title: 'Verify' }] }\nawait agent('x')\n");
  }
  const dir = path.join(sess, 'subagents', 'workflows', id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'launched' })];
  for (const a of agents) {
    lines.push(JSON.stringify({ type: 'started', key: 'k', agentId: a.id, label: a.id, phase: a.phase ?? 'Review' }));
    fs.writeFileSync(path.join(dir, `agent-${a.id}.jsonl`), '{}\n');
  }
  for (const a of agents) if (a.done) lines.push(JSON.stringify({ type: 'result', key: 'k', agentId: a.id, result: { big: 'x'.repeat(2000) } }));
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.join('\n') + '\n');
  return dir;
}
const touchAll = (dir, ms) => { for (const f of fs.readdirSync(dir)) setTime(path.join(dir, f), ms); };
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

test('parseMeta: 이름과 단계 제목, 문자열 안의 중괄호', () => {
  const m = parseMeta("// hi\nexport const meta = {\n  name: 'review-changes',\n  description: 'a } b { c',\n  phases: [{ title: 'Review' }, { title: \"Verify\", detail: 'x' }],\n}\nconst title = 'not-a-phase'\n");
  assert.equal(m.name, 'review-changes');
  assert.deepEqual(m.phases, ['Review', 'Verify']);
  assert.deepEqual(parseMeta('no meta here'), { name: null, phases: [] });
});

test('distill: 끝난 실행만, 폴더가 없으면 기록 안의 진행 정보로', () => {
  const rec = fakeRecord(0, rng(1), 1.7e12);
  const d = distill(rec);
  assert.equal(d.P, 2);
  assert.equal(d.ag.length, rec.workflowProgress.length);
  assert.ok(d.ag.every((a) => a[1] > a[0] && a[2] === 1));
  assert.equal(distill({ ...rec, status: 'killed' }), null);
  assert.equal(distill({ ...rec, durationMs: 0 }), null);
});

test('distill: 폴더가 있으면 실시간과 같은 출처(일지 + 파일 시각)로 만든다', () => {
  const { root, sess } = makeRoot(0);
  const base = Date.now() - 3600_000;
  const dir = addLive(sess, 'wf_done0001-aaa', [{ id: 'p1', phase: 'A', done: true }, { id: 'p2', phase: 'B', done: true }, { id: 'old', phase: 'A', done: true }]);
  setBirthAndModified(path.join(dir, 'agent-p1.jsonl'), base, base + 100_000);
  setBirthAndModified(path.join(dir, 'agent-p2.jsonl'), base + 50_000, base + 300_000);
  setBirthAndModified(path.join(dir, 'agent-old.jsonl'), base - 600_000, base - 500_000);   // 앞선 시도의 에이전트
  const rec = { runId: 'wf_done0001-aaa', status: 'completed', startTime: base, durationMs: 302_000, phases: [{ title: 'A' }, { title: 'B' }],
    workflowProgress: [{ type: 'workflow_agent', agentId: 'zzz', startedAt: base, durationMs: 1, phaseIndex: 2 }] };   // 폴더가 있으면 쓰이지 않는다
  const d = distill(rec, dir);
  const got = d.ag.map((a) => a.map(Math.round)).sort((x, y) => x[0] - y[0]);
  assert.deepEqual(got, [[0, 100, 1, 1], [50, 300, 1, 2]]);
  cleanup(root);
});

test('loadHistory: 바뀐 기록은 다시 읽고, 깨진 기록은 매번 센다', () => {
  const { root, sess, state } = makeRoot(3);
  assert.equal(loadHistory(root, state).runs.length, 3);
  const file = path.join(sess, 'workflows', 'wf_hist1.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, durationMs: 7_777_000 }));
  assert.ok(loadHistory(root, state).runs.some((r) => r.D === 7777), '캐시가 바뀐 기록을 다시 읽는다');
  fs.writeFileSync(path.join(sess, 'workflows', 'wf_broken.json'), '{"runId": ');
  assert.equal(loadHistory(root, state).unreadable, 1);
  assert.equal(loadHistory(root, state).unreadable, 1, '캐시에서 읽어도 실패는 계속 보고한다');
  assert.equal(fs.statSync(path.join(state, 'eta-cache.json')).mode & 0o077, 0, '캐시는 본인만 읽는다');
  assert.equal(fs.readFileSync(path.join(state, 'eta-cache.json'), 'utf8').includes(root), false, '캐시에 폴더 경로를 남기지 않는다');
  cleanup(root);
});

test('upperBound: 기록이 적으면 지어내지 않는다', () => {
  const hist = fakeHistory(MIN_EMPIRICAL - 1, 7);
  const b = upperBound(hist, hist[0], 120);
  assert.equal(b.ok, false);
  assert.equal(b.need, MIN_EMPIRICAL);
});

test('upperBound: 기록이 얇거나 단계 수를 모르면 분위수만 쓴다(값까지 확인)', () => {
  const hist = fakeHistory(30, 11).map((r, i) => ({ ...r, D: 200 + i * 100 }));   // 남은 시간 80, 180, …, 2980초
  const logs = hist.map((r) => Math.log(r.D - 120));
  const b = upperBound(hist, hist[0], 120, 0.9);
  assert.equal(b.method, 'empirical');
  assert.ok(Math.abs(b.latest - Math.exp(quantile(logs, Math.ceil(31 * 0.9) / 30))) < 1e-6, '유한 표본 보정이 들어간 분위수');
  assert.ok(Math.abs(b.typical - Math.exp(quantile(logs, 0.5))) < 1e-6);
  const big = fakeHistory(200, 12);
  assert.equal(upperBound(big, big[150], 120).method, 'model');
  assert.equal(upperBound(big, { ...big[150], P: null }, 120).method, 'empirical', '단계 수를 모르는 실행에는 진행률 모델을 쓰지 않는다');
});

test('trackRecord: 넘긴 비율과 상한의 크기가 양쪽 모두 말이 되는 범위', () => {
  const hist = fakeHistory(300, 99);
  const b = upperBound(hist.slice(0, 200), hist[250], 120, 0.9);
  assert.ok(b.latest >= b.typical);
  const k = trackRecord(hist, 0.9);
  assert.ok(k.n > 200);
  assert.ok(k.rate >= 0.03 && k.rate <= 0.16, `넘긴 비율 ${k.rate} (목표 10%)`);
  assert.ok(k.medianRatio >= 1 && k.medianRatio <= 5, `상한/실제 ${k.medianRatio}`);
  assert.ok(trackRecord(hist, 0.8).rate > k.rate, '덜 보수적이면 더 자주 넘긴다');
});

test('trackRecord: 예측 시점에 아직 안 끝난 실행은 과거로 쓰지 않는다', () => {
  const hist = fakeHistory(120, 5);
  const last = hist[hist.length - 1];
  const boundOf = (h) => { let got = null; trackRecord(h, 0.9, 120, (run, b) => { if (run.id === last.id) got = b.latest; }); return got; };
  // last 보다 1분 먼저 시작해 50시간 뒤에 끝나는 실행 — last 의 2분 시점에는 아직 돌고 있다
  const straggler = { ...hist[0], id: 'wf_straggler', S: last.S - MIN, D: 50 * 3600 };
  const withStraggler = [...hist.slice(0, -1), straggler, last];
  assert.equal(boundOf(withStraggler), boundOf(hist));
});

test('estimate: 2분 전은 잠정, 그 뒤 고정, 넘기면 다시 계산, 끝나면 사라진다', () => {
  const { root, sess, state } = makeRoot();
  const id = 'wf_live0001-abc';
  const dir = addLive(sess, id);
  const born = fs.statSync(path.join(dir, 'agent-x1.jsonl')).birthtimeMs;

  const early = estimate({ root, stateDir: state, now: born + 40_000 });
  assert.equal(early.history, 90);
  assert.equal(early.running.length, 1);
  const e = early.running[0];
  assert.equal(e.name, 'my-flow');
  assert.deepEqual(e.phase, { cur: 1, total: 2, title: 'Review' });
  assert.deepEqual(e.agents, { started: 3, done: 1, running: 2 });
  assert.equal(e.locked, false);
  assert.equal(e.track, null, '잠정값에는 적중 기록을 붙이지 않는다');
  assert.ok(e.latestBy > born);

  const at = born + (LOCK_AFTER_S + 60) * 1000;
  const first = estimate({ root, stateDir: state, now: at }).running[0];
  assert.equal(first.locked, true);
  assert.equal(first.track.atSec, 120, '적중 기록은 상한을 정한 시점에 가장 가까운 것으로');
  const whole = trackRecord(loadHistory(root, null).runs, 0.9, 120);
  assert.deepEqual([first.track.n, first.track.exceeded], [whole.n, whole.exceeded]);
  const again = estimate({ root, stateDir: state, now: at + 20_000 }).running[0];
  assert.equal(again.latestBy, first.latestBy, '고정된 상한은 다시 볼 때 움직이지 않는다');
  assert.equal(again.revised, 0);

  const late = first.latestBy + 5_000;
  touchAll(dir, late - 60_000);                              // 아직 돌고 있는 것처럼
  const over = estimate({ root, stateDir: state, now: late }).running[0];
  assert.equal(over.revised, 1);
  assert.ok(over.latestBy === null || over.latestBy > first.latestBy);

  const record = path.join(sess, 'workflows', `${id}.json`);
  fs.writeFileSync(record, JSON.stringify({ runId: id, status: 'completed', startTime: born, durationMs: 600_000, workflowProgress: [] }));
  setTime(record, late + 30_000);                            // 완료 기록은 마지막 활동 뒤에 쓰인다
  const done = estimate({ root, stateDir: state, now: late + 60_000 });
  assert.equal(done.running.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'eta-state.json'), 'utf8')).runs, {});
  cleanup(root);
});

test('estimate: 넘긴 뒤 새 상한을 못 내면 못 낸다고 하고, 넘긴 횟수는 볼 때마다 늘지 않는다', () => {
  const { root, sess, state } = makeRoot(30);                // 기록이 얇다: 오래 돈 실행은 20건이 안 된다
  const dir = addLive(sess, 'wf_live0005-ccc');
  const born = fs.statSync(path.join(dir, 'agent-x1.jsonl')).birthtimeMs;
  const first = estimate({ root, stateDir: state, now: born + 180_000 }).running[0];
  assert.ok(first.latestBy, '처음에는 상한이 나온다');
  const late = first.latestBy + 5_000;
  for (const step of [0, 30_000, 60_000]) {
    touchAll(dir, late + step - 10_000);
    const r = estimate({ root, stateDir: state, now: late + step }).running[0];
    assert.equal(r.latestBy, null, '지난 상한을 계속 보여주지 않는다');
    assert.equal(r.reason.kind, 'history');
    assert.equal(r.revised, 1);
  }
  cleanup(root);
});

test('estimate: 다른 수준으로 한 번 불러도 고정해 둔 상한은 그대로다', () => {
  const { root, sess, state } = makeRoot();
  const dir = addLive(sess, 'wf_live0006-ddd');
  const born = fs.statSync(path.join(dir, 'agent-x1.jsonl')).birthtimeMs;
  const at = born + 200_000;
  const nine = estimate({ root, stateDir: state, level: 0.9, now: at }).running[0];
  const eight = estimate({ root, stateDir: state, level: 0.8, now: at + 30_000 }).running[0];
  assert.ok(eight.latestBy < nine.latestBy, '덜 보수적인 수준은 더 이른 상한');
  assert.equal(estimate({ root, stateDir: state, level: 0.9, now: at + 60_000 }).running[0].latestBy, nine.latestBy);
  assert.equal(estimate({ root, stateDir: state, level: 0.8, now: at + 90_000 }).running[0].latestBy, eight.latestBy);
  cleanup(root);
});

test('estimate: 에이전트 없는 긴 틈이 있어도 지켜보던 실행의 시작 시각은 그대로다', () => {
  const { root, sess, state } = makeRoot();
  const T0 = Date.now() - 14 * MIN;
  const dir = addLive(sess, 'wf_live0007-eee', [{ id: 'x1', done: true }]);
  setBirthAndModified(path.join(dir, 'agent-x1.jsonl'), T0, T0 + 6 * MIN);
  setTime(path.join(dir, 'journal.jsonl'), T0 + 6 * MIN);
  const before = estimate({ root, stateDir: state, now: T0 + 7 * MIN }).running[0];
  assert.ok(Math.abs(before.startedAt - T0) < 2000);

  // 8분 틈 뒤에 다음 에이전트가 시작한다(재시도 대기 같은 상황)
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'k', agentId: 'x2', phase: 'Verify' }) + '\n');
  fs.writeFileSync(path.join(dir, 'agent-x2.jsonl'), '{}\n');
  const now = Date.now() + 2000;
  assert.ok(liveRuns(root, now)[0].S > T0 + 10 * MIN, '처음 보는 눈에는 긴 틈 뒤가 새 시도로 보인다');
  const after = estimate({ root, stateDir: state, now }).running[0];
  assert.equal(after.startedAt, before.startedAt);
  assert.deepEqual(after.agents, { started: 2, done: 1, running: 1 });
  assert.ok(after.elapsedSec > 13 * 60);
  cleanup(root);
});

test('estimate: 잠깐 목록에서 빠져도 고정한 상한은 남고, 오래 조용하면 상한을 내세우지 않는다', () => {
  const { root, sess, state } = makeRoot();
  const id = 'wf_live0008-fff';
  const dir = addLive(sess, id, [{ id: 'x1', done: true }]);
  const born = fs.statSync(path.join(dir, 'agent-x1.jsonl')).birthtimeMs;
  const first = estimate({ root, stateDir: state, now: born + 200_000 }).running[0];
  assert.ok(first.latestBy && !first.stalled);

  const quiet = estimate({ root, stateDir: state, now: born + 20 * MIN }).running[0];   // 도는 에이전트 없이 20분째 조용
  assert.equal(quiet.stalled, true);
  assert.equal(quiet.latestBy, null);
  assert.equal(quiet.reason.kind, 'stalled');

  assert.equal(estimate({ root, stateDir: state, now: born + 31 * MIN }).running.length, 0, '30분 넘게 조용하면 목록에서 뺀다');
  const kept = JSON.parse(fs.readFileSync(path.join(state, 'eta-state.json'), 'utf8')).runs[`${id}@0.9`];
  assert.ok(kept && kept.S, '목록에서 빠졌다고 지켜보던 실행을 잊지 않는다');
  cleanup(root);
});

test('estimate: 자기 스크립트가 없는 실행은 단계 수를 모른다고 하고 분위수만 쓴다', () => {
  const { root, sess, state } = makeRoot();
  const dir = addLive(sess, 'wf_live0009-ggg', undefined, { script: false });
  const born = fs.statSync(path.join(dir, 'agent-x1.jsonl')).birthtimeMs;
  const r = estimate({ root, stateDir: state, now: born + 200_000 }).running[0];
  assert.equal(r.name, null);
  assert.equal(r.phase.total, null);
  assert.equal(r.basis.method, 'empirical');
  cleanup(root);
});

test('liveRuns: 30분 넘게 조용한 실행은 빼고, 결과 없이 15분 넘게 조용한 에이전트는 세지 않는다', () => {
  const { root, sess } = makeRoot(3);
  const dir = addLive(sess, 'wf_live0002-def', [{ id: 'y1' }, { id: 'y2' }]);
  const now = Date.now();
  assert.equal(liveRuns(root, now).length, 1);
  assert.equal(liveRuns(root, now + 31 * MIN).length, 0);

  // 둘 다 25분 전에 시작, y1 만 20분째 조용 — 같은 시도 안에서 버려진 에이전트
  setBirthAndModified(path.join(dir, 'agent-y1.jsonl'), now - 25 * MIN, now - 20 * MIN);
  setBirthAndModified(path.join(dir, 'agent-y2.jsonl'), now - 25 * MIN, now);
  const r = liveRuns(root, now)[0];
  assert.equal(r.ag.length, 2, '둘 다 이번 시도의 에이전트다');
  const p = progressAt(r, (now - r.S) / 1000);
  assert.deepEqual([p.started, p.running], [1, 1]);
  cleanup(root);
});

test('progressAt: 끝난 것·도는 것·버려진 것', () => {
  // [시작, 마지막 수정, 결과 유무, 단계]
  const run = { P: 2, ag: [[0, 10, 0, 1], [0, 2000, 0, 1], [5, 50, 1, 2], [1500, 1600, 1, 2]] };
  const p = progressAt(run, 1000);
  assert.deepEqual([p.started, p.done, p.running, p.cur, p.total], [2, 1, 1, 2, 2]);   // 첫째는 버려짐, 넷째는 아직 시작 전
  assert.equal(p.meanDone, 45);
  assert.equal(progressAt(run, 10 + AGENT_SILENT_S - 1).started, 3, '15분이 되기 전까지는 도는 것으로 센다');
});

test('liveRuns: 재개된 실행은 앞선 시도의 완료 기록 뒤부터 다시 센다', () => {
  const { root, sess } = makeRoot(3);
  const id = 'wf_live0004-bbb';
  const dir = addLive(sess, id, [{ id: 'old1', done: true }]);
  const now = Date.now();
  setTime(path.join(dir, 'agent-old1.jsonl'), now - 10 * MIN);   // 30분 안쪽: 조용해서가 아니라 완료 기록 때문에 빠져야 한다
  setTime(path.join(dir, 'journal.jsonl'), now - 10 * MIN);
  assert.equal(liveRuns(root, now).length, 1, '완료 기록이 없으면 아직 도는 것으로 본다');
  const record = path.join(sess, 'workflows', `${id}.json`);
  fs.writeFileSync(record, JSON.stringify({ runId: id, status: 'killed' }));
  setTime(record, now - 9 * MIN);
  assert.equal(liveRuns(root, now).length, 0, '앞선 시도가 끝난 뒤 아무 일도 없으면 끝난 실행');

  fs.appendFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'k', agentId: 'new1', phase: 'Verify' }) + '\n');
  fs.writeFileSync(path.join(dir, 'agent-new1.jsonl'), '{}\n');
  const r = liveRuns(root, Date.now())[0];
  assert.equal(r.ag.length, 1, '앞선 시도의 에이전트는 세지 않는다');
  assert.ok(Date.now() - r.S < 5000, '시작 시각은 재개한 때');
  assert.equal(progressAt(r, 1).cur, 2);
  cleanup(root);
});

test('liveRuns: 스크립트·완료 기록이 다른 프로젝트 폴더에 있어도 찾는다', () => {
  const { root, sess } = makeRoot(3);
  const id = 'wf_live0003-aaa';
  addLive(sess, id);
  // 같은 세션이 작업 폴더를 옮긴 상황: 스크립트와 완료 기록은 다른 프로젝트 폴더에 놓인다
  const other = path.join(root, '-proj-worktree', path.basename(sess), 'workflows');
  fs.mkdirSync(path.join(other, 'scripts'), { recursive: true });
  fs.renameSync(path.join(sess, 'workflows', 'scripts', `my-flow-${id}.js`), path.join(other, 'scripts', `my-flow-${id}.js`));
  const r = liveRuns(root)[0];
  assert.equal(r.name, 'my-flow');
  assert.equal(r.P, 2);

  fs.writeFileSync(path.join(other, `${id}.json`), JSON.stringify({ runId: id, status: 'killed' }));
  assert.equal(liveRuns(root).length, 0, '다른 폴더에 완료 기록이 생겨도 끝난 것으로 본다');
  cleanup(root);
});

test('명령줄: 경로에 공백·한글이 있어도 출력하고, --dir 만 주면 기본 상태 폴더를 건드리지 않는다', () => {
  const { root, sess } = makeRoot(25);
  addLive(sess, 'wf_live0010-hhh');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-home-'));
  const odd = path.join(home, '토큰 계량기 app');
  fs.mkdirSync(odd);
  fs.copyFileSync(path.join(HERE, '..', 'eta.mjs'), path.join(odd, 'eta.mjs'));
  const run = (args) => execFileSync(process.execPath, [path.join(odd, 'eta.mjs'), ...args], { env: { ...process.env, HOME: home, LANG: 'ko_KR.UTF-8' }, encoding: 'utf8' });
  assert.match(run(['--dir', root]), /my-flow/);
  assert.equal(JSON.parse(run(['--dir', root, '--json'])).running.length, 1);
  assert.equal(fs.existsSync(path.join(home, '.token-meter')), false);
  assert.match(run(['--dir', root, '--backtest']), /끝난 워크플로 25건/);
  assert.ok(TRACK_AT.includes(LOCK_AFTER_S));
  cleanup(root); cleanup(home);
});

test('liveRuns: 세션 이름은 custom-title.json → 세션 기록 끝의 제목 줄 → 없음 순으로 찾는다', () => {
  const { root, sess } = makeRoot(3);
  addLive(sess, 'wf_live0011-iii');
  const transcript = sess + '.jsonl';   // <프로젝트>/<세션>.jsonl
  assert.equal(liveRuns(root)[0].session.title, null, '아무 데도 없으면 null');
  // 기록 앞쪽에 옛 이름, 끝쪽에 새 이름 — 2MB 넘게 사이를 벌려 끝부분만 읽는지 본다
  const filler = (JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } }) + '\n').repeat(2300);
  fs.writeFileSync(transcript, JSON.stringify({ type: 'ai-title', aiTitle: '옛 이름', sessionId: 's' }) + '\n' + filler
    + '{"type":"custom-title","customTitle":"새 이' + '\n'   // 잘린 줄은 건너뛴다
    + JSON.stringify({ type: 'custom-title', customTitle: '토큰계량기', sessionId: 's' }) + '\n' + filler.slice(0, 5000));
  assert.equal(liveRuns(root)[0].session.title, '토큰계량기');
  fs.writeFileSync(path.join(sess, 'custom-title.json'), JSON.stringify({ customTitle: '앱이 정한 이름' }));
  assert.equal(liveRuns(root)[0].session.title, '앱이 정한 이름', 'custom-title.json 이 먼저');
  fs.rmSync(path.join(sess, 'custom-title.json'));
  fs.writeFileSync(transcript, JSON.stringify({ type: 'ai-title', aiTitle: '자동 이름', sessionId: 's' }) + '\n');
  assert.equal(liveRuns(root)[0].session.title, '자동 이름', '직접 정한 이름이 없으면 자동 이름');
  cleanup(root);
});
