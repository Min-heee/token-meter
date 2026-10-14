// 화면 점검용 고정 자료. 앱의 --snapshot 이 실제 해석 경로로 읽는다(올리기·네트워크 없음).
//   node mkfixture.mjs [kind] > eta.json                 # --fixture          eta.mjs --json 과 같은 모양
//   node mkfixture.mjs board <kind> > board.json         # --board-fixture    board.mjs --json 과 같은 모양
//   node mkfixture.mjs publish <kind> > publish.json     # --publish-fixture  collect.mjs --publish --json 출력(단계 목록)
//   node mkfixture.mjs stats > stats.json                # --stats-fixture    collect.mjs --json-only 와 같은 모양
//   board 종류: normal far(나는 7등) notme joined(방금 올린 내 기록을 읽음) me-failed empty members_missing network
//   publish 종류: ok-member ok-nonmember ok-unknown noisy-ok node_missing timeout,
//                 unchanged(다섯 시간 전에 올렸고 이번엔 바뀐 것이 없어 그대로 둠), 오류 코드(gh_missing …, 이틀 전 성공 뒤 실패),
//                 <오류 코드>-first(한 번도 성공 못 함)
//   워크플로 종류(eta): mixed edge one many none — 세션 이름(session.title)이 있는 줄과 없는 줄이 섞여 있다
//   순위판 배열 파일([board, board])은 차례로 읽은 것으로 본다 — 예: 읽었다가 다음엔 못 읽음
const now = Date.now(), min = 60_000;
const run = (name, elapsedMin, o = {}) => ({
  runId: o.noName ? name : 'wf_' + name, name: o.noName ? null : name, project: '-fixture',
  session: o.session === null ? null : { id: 's-' + name, title: o.session ?? null }, startedAt: now - elapsedMin * min, elapsedSec: elapsedMin * 60,
  phase: { cur: o.cur ?? 1, total: o.total === undefined ? 3 : o.total, title: 'Review' },
  agents: { started: (o.done ?? 2) + (o.running ?? 2), done: o.done ?? 2, running: o.running ?? 2 },
  quietSec: o.quiet ?? 5, stalled: !!o.stalled,
  latestBy: o.latest == null ? null : now + o.latest * min, typicalBy: o.typical == null ? null : now + o.typical * min,
  typicalAt: o.latest == null ? null : now + (o.typical ?? o.typicalWas ?? -5) * min,
  locked: o.latest == null ? false : o.locked ?? true, revised: o.revised ?? 0, basis: o.latest == null ? null : { n: 150, method: 'model' },
  track: o.latest == null || o.locked === false ? null : o.track ?? { n: 200, exceeded: 11, atSec: 120 },
  reason: o.latest != null ? null : o.stalled ? { kind: 'stalled' } : { kind: 'history', have: o.have ?? 5, need: 20 },
});
const kinds = {
  mixed: [
    run('session-fix-review-r2', 1, { latest: 64, typical: 21, locked: false, done: 0, running: 4, cur: 1 }),          // 잠정
    run('chaeum-gold-v3-docs', 14, { session: '채움 문서 정리', latest: 71, typical: 19, cur: 2, done: 3, running: 2 }),                           // 평범
    run('ci-stage1-review', 41, { session: '자동화 시스템 기회 검토', latest: 33, typical: null, typicalWas: -16, cur: 2, total: 2, done: 6, running: 1 }),                 // 보통 시각 지남
    run('solo-restore-review-with-a-very-long-workflow-name-r4', 95, { latest: 48, typical: 12, revised: 1, cur: 3, done: 11, running: 2 }), // 한 번 넘김
    run('chaeum-ui-polish', 130, { latest: null, have: 5, cur: 4, total: 4, done: 9, running: 1 }),                    // 상한 없음
  ],
  edge: [
    run('just-passed-the-bound', 52, { session: '아주 긴 세션 이름이 붙은 창 — 러닝그라운드 배경 위치 기록 점검과 후속 수정', latest: -0.2, typical: null, typicalWas: -30, cur: 2, done: 4, running: 1 }), // 막 넘김 + 긴 세션 이름
    run('past-bound-no-new-one', 160, { latest: null, revised: 1, have: 7, cur: 3, done: 8, running: 2 }),             // 넘겼고 새 상한 없음
    run('went-quiet', 47, { latest: null, stalled: true, quiet: 22 * 60, cur: 2, done: 3, running: 0 }),               // 소식 없음
    run('wf_4ecc2e0d-614', 23, { latest: 58, typical: 16, total: null, noName: true, done: 2, running: 3, track: { n: 99, exceeded: 14, atSec: 1200 } }), // 단계 모름 + 늦게 잡음
    run('typical-right-after-now', 6, { latest: 80, typical: 0.4, cur: 1, done: 1, running: 3 }),                      // 눈금이 채움 바로 뒤
    run('crosses-midnight', 30, { latest: 60 * 14, typical: 60 * 9, cur: 1, done: 2, running: 2 }),                    // 날이 넘어감
    run('nothing-started-yet', 0.3, { latest: 40, typical: 12, locked: false, done: 0, running: 0, cur: 1 }),          // 방금 시작
  ],
  one: [run('eta-feature-review', 9, { session: '토큰계량기', latest: 52, typical: 17, cur: 1, done: 1, running: 3 })],
  many: Array.from({ length: 9 }, (_, i) => run('workflow-number-' + (i + 1), 5 + i * 7,
    { session: i % 3 === 2 ? null : ['토큰계량기', '채움 문서 정리'][i % 2] + ' ' + (i + 1), latest: 30 + i * 9, typical: 8 + i * 3, cur: 1 + (i % 3) })),
  none: [],
};
// ── 순위판 · 올리기 · 내 사용량 ──────────────────────────────────────────
// 숫자는 지어낸 것이다. 모양은 진짜 모듈이 만든다 — 순위판은 board.mjs 의 summarize,
// 올리기 실패 문구는 collect.mjs 의 PublishError, 참가 링크는 collect.mjs 의 joinUrl.
const ME = 'Min-heee';
const GIST = '0123456789abcdef0123456789abcdef';
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return ymd(d); };
const hours = (h) => new Date(now - h * 3600_000).toISOString();

/** 최근 days 일 동안 하루 perDay 토큰쯤 쓴 기록 하나 (skip = 그만큼 최근 날은 비움 = 그 뒤로 안 올림) */
function entryOf(tool, perDay, { days = 20, skip = 0 } = {}) {
  const byDay = {};
  let total = 0, output = 0, cost = 0;
  for (let i = skip; i < days; i++) {
    const t = Math.round(perDay * (0.6 + ((i * 37) % 9) / 10)), o = Math.round(t * 0.012), c = Math.round(t / 1e6 * 180) / 100;
    byDay[dayAgo(i)] = [t, o, c];
    total += t; output += o; cost += c;
  }
  return { tool, totals: { input: 0, output, cacheWrite: 0, cacheRead: 0, total, cost: Math.round(cost * 100) / 100, messages: 0 }, byDay };
}

async function boardFixture(k) {
  if (k === 'members_missing') return { ok: false, error: { code: 'members_missing', message: 'members.json HTTP 404' } };
  if (k === 'network') return { ok: false, error: { code: 'network', message: 'fetch failed' } };
  const { summarize } = await import('../docs/board.mjs');
  // [login, [[tool, 하루 토큰, 옵션]], 마지막으로 올린 지 몇 시간]
  let people = [
    ['hana-codes', [['claude', 9.1e7], ['codex', 1.2e7]], 2],
    ['jun-dev', [['claude', 7.4e7]], 5],
    [ME, [['claude', 6.2e7], ['codex', 3.1e6], ['gemini', 4e5]], 3],
    ['sora', [['codex', 4.4e7]], 26],
    ['minsu-park', [['claude', 3.9e7, { skip: 4 }]], 4 * 24 + 3],                         // 나흘째 안 올림
    ['a-very-long-github-login-name-39chars', [['gemini', 2.2e7], ['claude', 1e7]], 1],
    ['dev-yuna', [['claude', 1.1e7]], 7],
    ['taeho', [['codex', 6e6]], 9],
  ];
  if (k === 'far') people = people.map(([l, t, h]) => [l, l === ME ? [['claude', 2e6]] : t, h]);   // 나는 7등 밖
  if (k === 'notme' || k === 'me-failed') people = people.filter(([l]) => l !== ME);
  if (k === 'joined') people = people.map(([l, t, h]) => [l, t, l === ME ? 0.02 : h]);            // 방금 올린 기록을 읽고 있다
  if (k === 'empty') people = [];
  const rows = people.flatMap(([login, tools, h]) =>
    tools.map(([tool, perDay, o]) => ({ login, tool, entry: entryOf(tool, perDay, o), updatedAt: hours(h), gist: GIST })));
  const failed = k === 'empty' ? [] : [{ login: 'old-gist-user', reason: 'not_found', detail: 'gist 가 없거나 token-meter.json 이 없음' }];
  if (k === 'me-failed') failed.push({ login: ME, reason: 'login_mismatch', detail: 'gist 의 login 이 명단과 다름' });
  const out = summarize({ fetchedAt: new Date(now - 60_000).toISOString(), rows, failed }, { now: new Date(now) });
  return out;
}

/** 단계 목록 [{ stdout, stderr, rc, at }] — 앞 단계가 먼저 일어난 일 */
async function publishFixture(k) {
  const { PublishError, joinUrl } = await import('../collect.mjs');
  const ok = (member, at = hours(0)) => ({
    rc: 0, stderr: '', at,
    stdout: JSON.stringify({ ok: true, login: ME, gist: GIST, url: `https://gist.github.com/${ME}/${GIST}`, member, joinUrl: joinUrl(GIST) }) + '\n',
  });
  const fail = (code, detail = '') => {
    const e = new PublishError(code, { detail });
    return { rc: 1, stderr: '', at: hours(0), stdout: JSON.stringify({ ok: false, error: { code: e.code, message: e.ko } }) + '\n' };
  };
  const details = { gist_too_large: '312KB', unknown: 'HTTP 422: Validation Failed (https://api.github.com/gists)' };
  if (k === 'ok-member') return [ok(true)];
  if (k === 'ok-nonmember') return [ok(false)];
  if (k === 'ok-unknown') return [ok(null)];
  // 로그인 셸 설정이 표준 출력에 무언가를 찍은 경우 — 마지막 JSON 줄을 읽어야 한다
  if (k === 'noisy-ok') { const s = ok(false); s.stdout = 'Last login: Tue Oct 14 09:00:00 on ttys001\nnvm: using node v22\n' + s.stdout; return [s]; }
  if (k === 'node_missing') return [ok(true, hours(50)), { rc: 127, stdout: '', stderr: 'zsh:1: command not found: node\n', at: hours(0) }];
  // 앱이 끊었다(Model.timedOut = 124) — 출력은 없다
  if (k === 'timeout') return [ok(true, hours(50)), { rc: 124, stdout: '', stderr: '600초 안에 끝나지 않아 멈췄어요', at: hours(0) }];
  // 바뀐 것이 없어 고치지 않음(collect.mjs 가 unchanged: true 를 붙인다)
  if (k === 'unchanged') {
    const s = ok(true);
    s.stdout = JSON.stringify({ ok: true, unchanged: true, ...JSON.parse(s.stdout) }) + '\n';
    return [ok(true, hours(5)), s];
  }
  if (k.endsWith('-first')) return [fail(k.slice(0, -'-first'.length), details[k.slice(0, -'-first'.length)])];   // 한 번도 성공 못 함
  return [ok(true, hours(50)), fail(k, details[k])];   // 이틀 전에 올렸고 이번에 실패
}

function statsFixture() {
  return [entryOf('claude', 6.2e7, { days: 40 }), entryOf('codex', 3.1e6, { days: 40 }), entryOf('gemini', 4e5, { days: 40, skip: 2 })];
}

// 맨 끝에서 고른다 — 위의 상수들이 먼저 만들어져야 한다
const kind = process.argv[2] || 'mixed';
if (kind === 'board') console.log(JSON.stringify(await boardFixture(process.argv[3] || 'normal')));
else if (kind === 'publish') console.log(JSON.stringify(await publishFixture(process.argv[3] || 'ok-member')));
else if (kind === 'stats') console.log(JSON.stringify(statsFixture()));
else if (kind === 'broken') console.log('not json');
else console.log(JSON.stringify({ now, level: 0.9, history: 222, unreadable: 0, running: kinds[kind] }));
