// 맥 앱(macapp/) 점검 — 앱은 화면 밖 그림 모드(--snapshot)로만 띄운다. 메뉴바에 뜨는 일반 실행·--popover-test 는
// 하지 않는다(일반 실행은 30초 뒤 공개 gist 에 올리고, --popover-test 는 화면에 진짜 팝오버를 띄운다).
// 맥에 swiftc 가 있을 때만 돈다 — 다른 곳(CI 리눅스 등)에서는 건너뛴다. Xcode 라이선스에 아직 동의하지 않은 맥은
// 명령줄 도구(CommandLineTools)로 빌드한다(build.sh 가 알아서 고른다) — 그냥 건너뛰면 시험이 조용히 사라진다.
//
// 이 시험이 지키는 것:
//  - 모든 실행에 가짜 gh(불리면 기록만 남기고 실패)를 물리고 빈 임시 HOME 을 준다 — 진짜 gh 로그인·진짜 기록에 닿지 않는다.
//  - 번들 id 를 시험용으로 바꿔 진짜 앱 설정(dev.tokenmeter.mac, 옛 앱 dev.tokenmeter.menubar)을 읽지도 쓰지도 않는다.
//  - 순위판은 이 시험이 띄운 가짜 사이트(127.0.0.1)만 읽는다.
//  - 앱이 보이는 상태는 --state-out(JSON)으로 확인한다. 고정 자료는 macapp/mkfixture.mjs 가 진짜 모듈로 만든다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLT = '/Library/Developer/CommandLineTools';
const swiftOK = (env) => spawnSync('swiftc', ['--version'], { env }).status === 0;
const canRun = process.platform === 'darwin' && (swiftOK(process.env) || swiftOK({ ...process.env, DEVELOPER_DIR: CLT }));
const skip = canRun ? false : '맥 + swiftc 가 있어야 합니다';

const BUNDLE_ID = 'dev.tokenmeter.menubar.selftest';
const GIST = '0123456789abcdef0123456789abcdef';
const JOIN = `https://github.com/Min-heee/token-meter/issues/new?template=join.yml&title=join&gist=${GIST}`;

let tmp, exe, home, binDir, fakeGh, trip, server, site;
let members = { status: 200, body: JSON.stringify({ schema: 1, members: [] }) };   // 가짜 사이트의 members.json

// ── 준비: 시험용 번들 빌드(build.sh 그대로, 한 아키텍처) ──────────────────
before(async () => {
  if (!canRun) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-macapp-'));
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
  const b = spawnSync('zsh', [path.join(ROOT, 'macapp', 'build.sh')], {
    env: { ...process.env, TOKEN_METER_OUT: tmp, TOKEN_METER_ARCHS: arch }, encoding: 'utf8',
  });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  const app = path.join(tmp, 'TokenMeter.app');
  for (const f of ['collect.mjs', 'eta.mjs', 'board.mjs']) assert.ok(fs.existsSync(path.join(app, 'Contents/Resources', f)), `번들에 ${f} 가 있어야 한다`);
  // 시험용 번들 id — 진짜 앱 설정을 읽지도 쓰지도 않게. 바꾼 뒤 다시 서명한다.
  assert.equal(spawnSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', BUNDLE_ID, path.join(app, 'Contents/Info.plist')]).status, 0);
  assert.equal(spawnSync('codesign', ['--force', '--deep', '-s', '-', app]).status, 0);
  exe = path.join(app, 'Contents/MacOS/TokenMeter');

  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  trip = path.join(tmp, 'gh-calls.log');
  fakeGh = path.join(binDir, 'gh');
  // 불리면 안 되는 gh — 불렸다는 기록만 남기고 실패한다
  fs.writeFileSync(fakeGh, `#!/bin/sh\necho "$*" >> '${trip}'\necho 'fake gh' >&2\nexit 1\n`, { mode: 0o755 });

  server = http.createServer((req, res) => {
    if (req.url.startsWith('/members.json')) { res.writeHead(members.status, { 'content-type': 'application/json' }); res.end(members.body); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${server.address().port}/`;
});

after(() => {
  if (server) server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ── 실행 도우미 ─────────────────────────────────────────────────────────
// 환경은 처음부터 만든다 — GH_TOKEN 같은 진짜 인증 변수가 섞이지 않게
const envFor = (over = {}) => ({
  HOME: home, PATH: `${binDir}:${process.env.PATH}`, TMPDIR: os.tmpdir(), LANG: 'ko_KR.UTF-8',
  USER: os.userInfo().username, LOGNAME: os.userInfo().username,
  TOKEN_METER_GH: fakeGh, TM_SITE_URL: site, ...over,
});

/** 앱을 띄우고 끝나기를 기다린다(비동기 — 가짜 사이트가 같은 프로세스에서 답해야 한다) */
function launch(args, { env = envFor(), timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);   // 일반 실행으로 새면 여기서 끊는다
    p.on('close', (status, signal) => { clearTimeout(t); resolve({ status, signal, out, err }); });
  });
}

let seq = 0;
const file = (text) => { const p = path.join(tmp, `f${++seq}.json`); fs.writeFileSync(p, typeof text === 'string' ? text : JSON.stringify(text)); return p; };
const mk = (...a) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'macapp', 'mkfixture.mjs'), ...a], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

/** --snapshot 한 번 → { state, png, out } (워크플로는 따로 주지 않으면 '없음') */
async function snap(extra = [], opts) {
  const id = ++seq;
  const png = path.join(tmp, `s${id}.png`), stateFile = path.join(tmp, `s${id}.state.json`);
  const args = ['--snapshot', png, '--state-out', stateFile, ...extra];
  if (!extra.includes('--fixture')) args.push('--fixture', file(mk('none')));
  const r = await launch(args, opts);
  assert.equal(r.status, 0, `종료 ${r.status}/${r.signal}: ${r.err}`);
  return { ...r, png, state: JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
}

/** 수집기(--publish --json) 출력 한 단계 */
const step = (stdout, { rc = 0, stderr = '', at = new Date().toISOString() } = {}) =>
  ({ rc, stderr, at, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout) + '\n' });
const okOut = (o = {}) => ({ ok: true, login: 'Min-heee', gist: GIST, url: `https://gist.github.com/Min-heee/${GIST}`, member: true, joinUrl: JOIN, ...o });
const publishWith = (...steps) => ['--publish-fixture', file(steps)];

// ── 일반 실행으로 새지 않는다 ───────────────────────────────────────────
test('인자가 이상하면 일반 실행(30초 뒤 자동 올리기)으로 넘어가지 않고 2로 끝난다', { skip }, async () => {
  const png = path.join(tmp, 'never.png');
  const f = file(mk('none'));
  for (const args of [
    ['--snapshott', png],                          // 오타
    ['--popover-tset'],                            // 오타
    ['--fixture', f],                              // 점검 모드를 빠뜨림
    ['--board-live'],
    ['--snapshot'],                                // 값이 없음
    ['--snapshot', '--fixture', f],                // 값 자리에 다른 인자
    ['--snapshot', png, '--state-out'],
  ]) {
    const r = await launch(args, { timeoutMs: 15_000 });
    assert.equal(r.status, 2, `${args.join(' ')} → ${r.status}/${r.signal} ${r.err}`);
  }
  assert.ok(!fs.existsSync(png));
});

test('--fixture 파일을 못 읽으면 지금 도는 진짜 워크플로를 그리지 않고 2로 끝난다', { skip }, async () => {
  const png = path.join(tmp, 'nofixture.png');
  const r = await launch(['--snapshot', png, '--fixture', path.join(tmp, 'missing.json')], { timeoutMs: 15_000 });
  assert.equal(r.status, 2, r.err);
  assert.ok(!fs.existsSync(png));
});

test('점검 실행은 잠겨 있다 — 올리기 결과를 넣어도 설정을 저장하지 않는다', { skip }, async () => {
  const { state, png } = await snap(['--publish-fixture', file(mk('publish', 'ok-member'))]);
  assert.equal(state.live, false);
  assert.equal(state.login, 'Min-heee');   // 화면에는 반영되고
  assert.ok(fs.statSync(png).size > 1000);
  // 저장은 안 된다 — 시험용 번들 id 의 설정이 생기지 않았다
  assert.notEqual(spawnSync('defaults', ['read', BUNDLE_ID], { encoding: 'utf8' }).status, 0, '시험용 설정 도메인이 생기면 안 된다');
  assert.ok(!fs.existsSync(path.join(home, 'Library/Preferences', BUNDLE_ID + '.plist')));
});

// ── 올리기 결과 해석 (collect.mjs --publish --json) ─────────────────────
test('올리기 실패 코드마다 한국어 안내와 칠 명령을 보이고, 그 전 성공 시각은 남긴다', { skip }, async () => {
  const want = {
    gh_missing: 'brew install gh',
    gh_not_logged_in: 'gh auth login',
    gh_no_gist_scope: 'gh auth refresh -s gist',
    network: null,
    gist_too_large: /^node \S*\/TokenMeter\.app\/Contents\/Resources\/collect\.mjs --publish --since \d{4}-\d{2}-\d{2}$/,
    unknown: null,
    node_missing: 'brew install node',
    timeout: null,
  };
  for (const [code, command] of Object.entries(want)) {
    const { state } = await snap(['--publish-fixture', file(mk('publish', code))]);
    assert.equal(state.problem?.code, code, code);
    if (command instanceof RegExp) assert.match(state.problem.command, command, code);   // 터미널의 지금 폴더가 아니라 앱 안의 수집기
    else assert.equal(state.problem.command, command, code);
    assert.ok(state.problem.text.length > 0);
    assert.ok(state.lastPublish, `${code}: 이틀 전 성공은 남는다`);
    assert.equal(state.status, '올리지 못함');
  }
  const big = (await snap(['--publish-fixture', file(mk('publish', 'gist_too_large'))])).state;
  assert.match(big.problem.text, /312KB/);
  const unk = (await snap(['--publish-fixture', file(mk('publish', 'unknown'))])).state;
  assert.match(unk.problem.text, /HTTP 422/, '안내가 따로 없는 오류는 수집기 문구를 그대로');
  const first = (await snap(['--publish-fixture', file(mk('publish', 'gh_missing-first'))])).state;
  assert.equal(first.lastPublish, null);
  assert.equal(first.consented, true, '한 번 시도했으면 동의한 것 — 동의 상자 대신 실패 알림');
});

test('명단에 없으면 참가 링크를 보이고, 있거나 모르면 보이지 않는다', { skip }, async () => {
  const non = (await snap(['--publish-fixture', file(mk('publish', 'ok-nonmember'))])).state;
  assert.equal(non.member, false);
  assert.equal(non.joinLink, JOIN);
  assert.equal(non.problem, null);
  const mem = (await snap(['--publish-fixture', file(mk('publish', 'ok-member'))])).state;
  assert.equal(mem.member, true);
  assert.equal(mem.joinLink, null);
  const unknown = (await snap(['--publish-fixture', file(mk('publish', 'ok-unknown'))])).state;
  assert.equal(unknown.member, null);
  assert.equal(unknown.joinLink, null);
  // 로그인 셸 설정이 앞에 글을 찍어도 마지막 JSON 줄을 읽는다
  const noisy = (await snap(['--publish-fixture', file(mk('publish', 'noisy-ok'))])).state;
  assert.equal(noisy.login, 'Min-heee');
  assert.equal(noisy.joinLink, JOIN);
  // 처음(올린 적 없음)에는 동의 상자 — 참가 링크도 없다
  const fresh = (await snap()).state;
  assert.equal(fresh.consented, false);
  assert.equal(fresh.joinLink, null);
});

test('수집기 출력이 이상해도 엉뚱한 주소를 열지 않고, 실패는 이유를 남긴다', { skip }, async () => {
  // gist·참가 주소는 GitHub 것만 연다
  const bad = (await snap(publishWith(step(okOut({ url: 'file:///etc/passwd', joinUrl: 'javascript:alert(1)', member: false }))))).state;
  assert.equal(bad.gistURL, null);
  assert.equal(bad.joinURL, null);
  assert.equal(bad.joinLink, null);
  // member:null(명단을 못 읽음)이면 같은 gist 의 지난 답을 두고, gist 가 바뀌었으면 지운다
  const keep = (await snap(publishWith(step(okOut({ member: true })), step(okOut({ member: null }))))).state;
  assert.equal(keep.member, true);
  const other = 'fedcba9876543210fedcba9876543210';
  const reset = (await snap(publishWith(step(okOut({ member: true })), step(okOut({ gist: other, member: null }))))).state;
  assert.equal(reset.member, null);
  assert.equal(reset.gistID, other);
  // ok:false 인데 error 가 없다 → 알 수 없는 실패
  const bare = (await snap(publishWith(step({ ok: false }, { rc: 1 })))).state;
  assert.equal(bare.problem.code, 'unknown');
  assert.equal(bare.problem.text, '이유를 알 수 없는 실패예요');
  // JSON 이 없다 → 표준 오류의 마지막 줄
  const crash = (await snap(publishWith(step('', { rc: 1, stderr: 'first\nboom\n' })))).state;
  assert.equal(crash.problem.code, 'unknown');
  assert.equal(crash.problem.text, 'boom');
  // zsh 가 node 를 못 찾음(127)
  const nonode = (await snap(publishWith(step('', { rc: 127, stderr: 'zsh:1: command not found: node\n' })))).state;
  assert.equal(nonode.problem.code, 'node_missing');
  // 앞뒤로 셸 글(.zprofile 인사, .zlogout 작별)이 붙어도
  const wrapped = (await snap(publishWith(step('Last login: Tue\n' + JSON.stringify(okOut()) + '\nbye from zlogout\n')))).state;
  assert.equal(wrapped.problem, null);
  assert.equal(wrapped.login, 'Min-heee');
});

// ── 순위판 해석 (board.mjs --json) ──────────────────────────────────────
test('순위판: 내 줄 찾기, 참가 반영, 못 읽은 참가자, 못 읽으면 그 전 순위 유지', { skip }, async () => {
  const pub = (kind) => ['--publish-fixture', file(mk('publish', kind))];
  const far = (await snap([...pub('ok-member'), '--board-fixture', file(mk('board', 'far'))])).state;
  const mine = far.ranks.filter((r) => r.mine);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].login, 'Min-heee');
  assert.ok(mine[0].rank > 6, '7등 밖');
  assert.ok(far.boardUpdatedAt);

  // 참가 신청 뒤 순위판이 방금 올린 내 기록을 읽으면 참가된 것 — 다음 올리기를 기다리지 않는다
  const joined = (await snap([...pub('ok-nonmember'), '--board-fixture', file(mk('board', 'joined'))])).state;
  assert.equal(joined.member, true);
  assert.equal(joined.joinLink, null);
  // 순위판이 읽는 내 기록이 오래됐으면(옛 gist) 참가로 보지 않는다
  const stale = (await snap([...pub('ok-nonmember'), '--board-fixture', file(mk('board', 'normal'))])).state;
  assert.equal(stale.member, false);

  const failed = (await snap([...pub('ok-member'), '--board-fixture', file(mk('board', 'me-failed'))])).state;
  assert.deepEqual(failed.boardFailed.map((f) => f.login).sort(), ['Min-heee', 'old-gist-user']);
  assert.equal(failed.boardFailed.find((f) => f.login === 'Min-heee').text, '계정이 다름');

  const seqFile = file(`[${mk('board', 'normal').trim()},${mk('board', 'network').trim()}]`);
  const kept = (await snap(['--board-fixture', seqFile])).state;
  assert.ok(kept.ranks.length >= 6, '그 전 순위는 그대로');
  assert.match(kept.boardError, /닿지 못했어요/);

  const missing = (await snap(['--board-fixture', file(mk('board', 'members_missing'))])).state;
  assert.equal(missing.boardError, '순위판이 아직 열리지 않았어요');

  // 모양이 어긋난 줄은 버리고, 숫자가 아닌 값은 0 으로
  const odd = (await snap(['--board-fixture', file({ ok: true, fetchedAt: new Date().toISOString(), failed: [{ reason: 'x' }],
    people: [{ login: 'ok-user', rank: 1, tools: ['claude'], total: { week: 'lots', all: 5 } }, { rank: 2 }, 'junk'] })])).state;
  assert.deepEqual(odd.ranks.map((r) => [r.login, r.week, r.all]), [['ok-user', 0, 5]]);
  assert.deepEqual(odd.boardFailed, []);
});

// ── 늦어도 몇 시: 세션 이름 ─────────────────────────────────────────────
test('워크플로 줄은 세션 이름을 먼저 읽는다(없으면 워크플로 이름)', { skip }, async () => {
  const { state, out } = await snap(['--fixture', file(mk('mixed'))]);
  const byId = Object.fromEntries(state.runs.map((r) => [r.id, r]));
  assert.equal(byId['wf_chaeum-gold-v3-docs'].sessionTitle, '채움 문서 정리');
  assert.equal(byId['wf_session-fix-review-r2'].sessionTitle, null);
  assert.equal(state.runs.length, 5);
  assert.match(out, /menu title: \[ 늦어도 \d/);
});

// ── 진짜로 띄우는 경로: 번들의 collect.mjs · board.mjs ─────────────────
test('사용량 수집: node 가 .zshrc 에서만 PATH 에 들어가는 설치(nvm 등)에서도 번들 수집기가 돈다', { skip }, async () => {
  // 로그인 셸에는 node 가 없고(.zshenv 에서 /etc/zprofile 의 path_helper 를 끈다), 대화형 셸(.zshrc)에만 있는 집
  const nvmHome = path.join(tmp, 'nvm-home');
  const nodeDir = path.join(nvmHome, '.nvm-like', 'bin');
  fs.mkdirSync(nodeDir, { recursive: true });
  const used = path.join(nvmHome, 'node-used');
  fs.writeFileSync(path.join(nodeDir, 'node'), `#!/bin/sh\n: > '${used}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(nvmHome, '.zshenv'), 'unsetopt GLOBAL_RCS\n');
  fs.writeFileSync(path.join(nvmHome, '.zshrc'), `export PATH='${nodeDir}':$PATH\n`);
  // 가짜 Claude Code 기록 하나 (입력 100 + 출력 50)
  const proj = path.join(nvmHome, '.claude', 'projects', '-fake-project');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's1.jsonl'), JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(), sessionId: 's1',
    message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 } },
  }) + '\n');
  const sysPath = '/usr/bin:/bin:/usr/sbin:/sbin';   // launchd 가 앱에 주는 PATH
  assert.notEqual(spawnSync('/bin/zsh', ['-lc', 'node --version'], { env: { HOME: nvmHome, PATH: sysPath } }).status, 0, '전제: 로그인 셸에는 node 가 없다');

  const { state } = await snap(['--stats-live'], { env: envFor({ HOME: nvmHome, PATH: sysPath }) });
  assert.deepEqual(state.stats.map((s) => [s.tool, s.total]), [['claude', 150]], state.status);
  assert.ok(fs.existsSync(used), '.zshrc 의 node 로 돌았다');
});

test('순위판 읽기: 번들의 board.mjs 로 사이트를 읽고, 명단이 없으면 그렇게 말한다', { skip }, async () => {
  members = { status: 200, body: JSON.stringify({ schema: 1, members: [] }) };
  const empty = (await snap(['--board-live'])).state;
  assert.equal(empty.boardError, null);
  assert.deepEqual(empty.ranks, []);
  assert.ok(empty.boardFetchedAt);
  members = { status: 404, body: 'not found' };
  const missing = (await snap(['--board-live'])).state;
  assert.equal(missing.boardError, '순위판이 아직 열리지 않았어요');
  members = { status: 200, body: 'not json' };
  const broken = (await snap(['--board-live'])).state;
  assert.equal(broken.boardError, '순위판 명단을 읽지 못했어요');
});

// ── 바뀐 것이 없어 그대로 둔 올리기(unchanged) ─────────────────────────
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

test('바뀐 것이 없어 그대로 둔 올리기는 성공으로 받고, gist 를 고친 시각(lastUpload)은 그대로 둔다', { skip }, async () => {
  const { state } = await snap(['--publish-fixture', file(mk('publish', 'unchanged'))]);
  assert.equal(state.problem, null);
  assert.equal(state.status, '바뀐 것 없음');
  assert.equal(state.lastUnchanged, true);
  assert.ok(Date.now() - Date.parse(state.lastPublish) < 60_000, '확인은 방금');
  assert.ok(Date.now() - Date.parse(state.lastUpload) > 4 * 3600_000, '고친 것은 다섯 시간 전 그대로');
  // 처음 성공이 '그대로 둠'이면(다른 곳에서 이미 올려 둠) 고친 시각은 모른다
  const first = (await snap(publishWith(step(okOut({ unchanged: true }))))).state;
  assert.equal(first.problem, null);
  assert.equal(first.lastUpload, null);
  assert.equal(first.gistID, GIST);
  // unchanged 가 true 가 아닌 값이면 바뀐 것으로 본다
  const odd = (await snap(publishWith(step(okOut({ unchanged: 'yes' }))))).state;
  assert.equal(odd.lastUnchanged, false);
  assert.ok(odd.lastUpload);
});

test('참가 반영: 그대로 둔 올리기 뒤에도 순위판이 마지막으로 고친 내 기록을 읽으면 참가된 것', { skip }, async () => {
  // 세 시간 전에 고쳐 올렸고(아직 명단에 없음), 한 시간 전에는 바뀐 것이 없어 그대로 뒀다(그때도 명단에 없음).
  // 그 뒤 참가 신청이 처리돼 순위판이 세 시간 전 기록(board 'normal' 의 내 줄)을 읽고 있다.
  const steps = publishWith(step(okOut({ member: false }), { at: hoursAgo(3) }), step(okOut({ member: false, unchanged: true }), { at: hoursAgo(1) }));
  const joined = (await snap([...steps, '--board-fixture', file(mk('board', 'normal'))])).state;
  assert.equal(joined.member, true, '그대로 둔 시각(한 시간 전)과 견주면 안 된다');
  assert.equal(joined.joinLink, null);
  // 순위판이 읽는 내 기록이 고친 시각보다 한참 전이면(옛 gist) 여전히 참가 전
  const old = publishWith(step(okOut({ member: false })), step(okOut({ member: false, unchanged: true })));
  assert.equal((await snap([...old, '--board-fixture', file(mk('board', 'normal'))])).state.member, false);
});

test('순위 기록이 하루 넘게 묵었다는 말: 하루 안에 올리기(그대로 둠 포함)에 성공했으면 하지 않는다', { skip }, async () => {
  const board = file({ ok: true, fetchedAt: new Date().toISOString(), failed: [],
    people: [{ login: 'Min-heee', rank: 1, tools: ['claude'], total: { week: 5, all: 9 }, updatedAt: hoursAgo(30) }] });
  // 서른 시간 전에 고친 뒤로 바뀐 것이 없다 — 방금 확인했으니 순위의 기록은 지금 것과 같다
  const fresh = (await snap([...publishWith(step(okOut(), { at: hoursAgo(30) }), step(okOut({ unchanged: true }))), '--board-fixture', board])).state;
  assert.equal(fresh.boardLagSince, null);
  // 서른 시간 전이 마지막 성공이면 묵었다고 말한다
  const stale = (await snap([...publishWith(step(okOut(), { at: hoursAgo(30) })), '--board-fixture', board])).state;
  assert.ok(stale.boardLagSince);
  // 그 뒤 실패만 이어지는 중이어도(실패 알림이 따로 뜬다) 기록은 묵은 것
  const failing = (await snap([...publishWith(step(okOut(), { at: hoursAgo(30) }),
    step({ ok: false, error: { code: 'network', message: 'x' } }, { rc: 1 })), '--board-fixture', board])).state;
  assert.ok(failing.boardLagSince);
});

// ── 자동 올리기 간격 · 동의 ─────────────────────────────────────────────
test('자동 올리기: 동의 전에는 절대 안 하고, 마지막 시도(실패 포함)에서 간격(기본 6시간)이 지나야 한다', { skip }, async () => {
  const fresh = (await snap()).state;
  assert.equal(fresh.consented, false);
  assert.equal(fresh.autoDue, false, '처음 한 번은 사람이 눌러야 한다');
  assert.equal(fresh.intervalMin, 360);
  const fail = () => step({ ok: false, error: { code: 'network', message: 'x' } }, { rc: 1 });
  const justFailed = (await snap(publishWith(fail()))).state;
  assert.equal(justFailed.consented, true);
  assert.equal(justFailed.autoDue, false, '방금 실패했으면 1분마다 두드리지 않는다');
  assert.equal((await snap(publishWith(step(okOut(), { at: hoursAgo(5.9) })))).state.autoDue, false);
  assert.equal((await snap(publishWith(step(okOut(), { at: hoursAgo(6.1) })))).state.autoDue, true);
  // 시도 시각은 가장 늦은 것 — 오래전 성공 뒤 방금 실패했으면 아직
  assert.equal((await snap(publishWith(step(okOut(), { at: hoursAgo(50) }), fail()))).state.autoDue, false);
});

// ── 멈춘 자식 프로세스 ──────────────────────────────────────────────────
test('수집기가 끝나지 않으면 끊는다 — busy 가 영영 남아 자동 올리기가 멈추지 않게', { skip }, async () => {
  // .zshrc 에서만 PATH 에 들어가는 node 가 끝나지 않는다(셸 설정이 멈춘 경우와 같다)
  const h = path.join(tmp, 'hang-home');
  const nodeDir = path.join(h, 'bin');
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.writeFileSync(path.join(nodeDir, 'node'), '#!/bin/sh\nexec sleep 47.25\n', { mode: 0o755 });   // 이 시험에서만 쓰는 길이 — 남았는지 찾는 표시
  fs.writeFileSync(path.join(h, '.zshenv'), 'unsetopt GLOBAL_RCS\n');
  fs.writeFileSync(path.join(h, '.zshrc'), `export PATH='${nodeDir}':$PATH\n`);
  const t0 = Date.now();
  const { state } = await snap(['--stats-live'], { env: envFor({ HOME: h, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TM_TIMEOUT_SEC: '4' }), timeoutMs: 25_000 });
  assert.equal(state.status, '수집이 끝나지 않아 멈췄어요');
  assert.ok(Date.now() - t0 < 20_000, `끊는 데 ${Date.now() - t0}ms`);
  // 셸만 죽고 멈춘 프로그램이 고아로 남지 않았다(로그인 셸은 마지막 명령을 exec 하지 않는다 — 앱이 exec 를 붙인다)
  const alive = () => spawnSync('pgrep', ['-f', 'sleep 47.25']).status === 0;
  for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(), '끊은 프로그램이 아직 돌고 있다');
  // 올리기가 끊긴 결과(124, 출력 없음)는 '시간 초과' 안내로
  const cut = (await snap(['--publish-fixture', file(mk('publish', 'timeout'))])).state;
  assert.equal(cut.problem.code, 'timeout');
  assert.match(cut.problem.text, /오래 끝나지 않아/);
});

// ── 사고 재발 방지 · 비밀 ───────────────────────────────────────────────
test('번들 id 는 옛 앱(dev.tokenmeter.menubar)과 다르다 — 점검 실행이 돌고 있는 옛 앱의 설정을 건드리지 않게', { skip }, () => {
  const r = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(ROOT, 'macapp', 'TokenMeter', 'Info.plist')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'dev.tokenmeter.mac');
});

test('표시·저장되는 실패 문구에서 토큰처럼 생긴 것은 가린다', { skip }, async () => {
  const tokenish = 'ghp_' + 'Z9y'.repeat(12);
  const crash = (await snap(publishWith(step('', { rc: 1, stderr: `export GH_TOKEN=${tokenish}\n` })))).state;
  assert.ok(!JSON.stringify(crash).includes(tokenish), JSON.stringify(crash.problem));
  const msg = (await snap(publishWith(step({ ok: false, error: { code: 'unknown', message: `올리지 못했어요: Authorization: token ${tokenish}` } }, { rc: 1 })))).state;
  assert.ok(!JSON.stringify(msg).includes(tokenish), JSON.stringify(msg.problem));
});

// 맨 끝: 위의 어떤 실행도 gh 를 부르지 않았다(점검 실행은 올리지 않는다 — 사용량 수집도 gh 없이)
test('어떤 점검 실행도 gh 를 부르지 않았다', { skip }, () => {
  assert.ok(!fs.existsSync(trip), fs.existsSync(trip) ? fs.readFileSync(trip, 'utf8') : '');
});
