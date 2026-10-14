#!/usr/bin/env node
/**
 * 토큰 계량기 — 참가·탈퇴 이슈 처리 (.github/workflows/join.yml 이 부른다)
 *
 * 흐름:
 *   1. 이벤트 파일(GITHUB_EVENT_PATH)에서 이슈 번호를 읽고, API 로 지금 상태를 다시 읽는다
 *      (줄 서서 늦게 돈 실행이면 그새 닫혔거나 고쳐졌을 수 있다)
 *   2. 제목으로 join / leave 를 정한다. 둘 다 아니면 아무것도 하지 않는다(보통 이슈)
 *   3. join 이면 본문에서 gist id 를 찾고, 인증 없이 GET https://api.github.com/gists/<id> 로
 *      주인 = 이슈 연 사람인지, token-meter.json 이 있고 형식이 맞는지 본다
 *   4. docs/members.json 을 고쳐 github-actions[bot] 이름으로 커밋하고 push 한다
 *   5. 결과를 댓글로 달고(한국어 + 영어) 성공이면 이슈를 닫는다. 실패면 열어 둔다
 *
 * 왜 gist 는 인증 없이 읽나: 액션의 GITHUB_TOKEN 은 gist 를 읽을 권한이 없다. 공개 gist 는
 * 인증 없이 읽히므로 그 요청에는 Authorization 머리를 아예 붙이지 않는다.
 *
 * 이슈 제목·본문은 아무나 쓸 수 있다. 워크플로에서 ${{ }} 로 셸에 끼워 넣지 않고
 * 여기서 이벤트 파일로만 읽는다. 토큰은 어떤 로그에도 찍지 않는다.
 *
 * 판단은 전부 join-core.mjs 에 있고, 이 파일은 네트워크·git·파일만 다룬다. 테스트는 run() 에
 * 가짜 fetch·가짜 git 을 넣어 돌린다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseAction, extractGistId, inspectGist, checkContent, parseMembers, serializeMembers,
  applyJoin, applyLeave, commentFor, isSuccess, siteFor, MAX_BYTES,
} from './join-core.mjs';

// ── 상수 ────────────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const MEMBERS_PATH = path.join(REPO_ROOT, 'docs', 'members.json');
export const PUBLIC_API = 'https://api.github.com';     // gist 확인은 언제나 여기(인증 없이)
const UA = 'token-meter-join';
const API_VERSION = '2022-11-28';
const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
export const PUSH_ATTEMPTS = 5;

// ── gist 확인 (인증 없음) ───────────────────────────────────────────────
/** 응답 본문을 상한까지만 읽는다 — raw 파일이 아무리 커도 메모리를 다 쓰지 않게. 넘으면 null */
async function readCapped(res, max) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return new TextEncoder().encode(text).length > max ? null : text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch {} return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * gist 를 받아 검사한다. → { ok:true, gist:<id> } | { ok:false, code, ... }
 * 토큰을 받지 않는다 — 실수로라도 gist 요청에 붙을 수 없게.
 */
export async function fetchGist(id, author, { fetch = globalThis.fetch } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': UA, 'x-github-api-version': API_VERSION };
  let res;
  try {
    res = await fetch(`${PUBLIC_API}/gists/${encodeURIComponent(id)}`, { headers });
  } catch {
    return { ok: false, code: 'unavailable', status: 'network' };
  }
  if (res.status === 404) return { ok: false, code: 'not_found' };
  if (!res.ok) return { ok: false, code: 'unavailable', status: res.status };
  let gist;
  try { gist = await res.json(); } catch { return { ok: false, code: 'unavailable', status: 'bad response' }; }

  const seen = inspectGist(gist, author);
  if (!seen.ok) return seen;
  let text = seen.content;
  if (text === undefined) {
    // API 가 내용을 잘라 보냈다 — raw 주소에서 원본을 받는다(이것도 인증 없이)
    let raw;
    try { raw = await fetch(seen.rawUrl, { headers: { 'user-agent': UA } }); } catch {
      return { ok: false, code: 'unavailable', status: 'network' };
    }
    if (!raw.ok) return { ok: false, code: 'unavailable', status: raw.status };
    text = await readCapped(raw, MAX_BYTES);
    if (text === null) return { ok: false, code: 'too_large', size: MAX_BYTES + 1 };
  }
  const checked = checkContent(text, author);
  return checked.ok ? { ok: true, gist: typeof gist.id === 'string' ? gist.id.toLowerCase() : id } : checked;
}

// ── 이슈 API (GITHUB_TOKEN) ─────────────────────────────────────────────
function issueApi({ fetch, token, api, repo }) {
  async function call(method, p, body) {
    const headers = {
      accept: 'application/vnd.github+json', 'user-agent': UA, 'x-github-api-version': API_VERSION,
      authorization: `Bearer ${token}`,
    };
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch(`${api}/repos/${repo}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    // 오류 문구에는 경로·상태만 — 머리(토큰)는 절대 넣지 않는다
    if (!res.ok) throw new Error(`GitHub API ${method} ${p} → HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }
  return {
    get: (n) => call('GET', `/issues/${n}`),
    comment: (n, body) => call('POST', `/issues/${n}/comments`, { body }),
    close: (n) => call('PATCH', `/issues/${n}`, { state: 'closed', state_reason: 'completed' }),
    // GITHUB_TOKEN 으로 한 push 는 Pages 빌드를 일으키지 않는다(GitHub 문서) — 직접 부탁한다(pages: write)
    pagesBuild: () => call('POST', '/pages/builds'),
  };
}

// ── git ─────────────────────────────────────────────────────────────────
/** git 을 부르는 함수. 실패해도 던지지 않고 { ok:false } 로 돌려준다(push 거절은 흔한 일이라). */
export function realGit(cwd) {
  return (args) => {
    try {
      const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, stdout };
    } catch (e) {
      return { ok: false, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
    }
  };
}

function must(r, what) {
  if (!r.ok) throw new Error(`${what} 실패: ${String(r.stderr || '').trim().slice(0, 300)}`);
  return r;
}

function readMembers(read, file) {
  let text;
  try { text = read(file); } catch (e) {
    if (e && e.code === 'ENOENT') return [];   // 파일이 아직 없으면 빈 명단부터
    throw e;
  }
  return parseMembers(text);
}

/**
 * 명단을 고쳐 push 한다. 매번 원격의 최신 커밋으로 맞춘 뒤 고친다 — 액션은 이벤트가 생긴 때의
 * 커밋을 받아 오므로, 줄 서 있던 사이 다른 실행이 명단을 바꿨을 수 있다. push 가 거절되면
 * (그 사이 또 누가 바꿨으면) 다시 받아서 처음부터 다시 고친다. 강제 push 는 하지 않는다.
 * change(members) → applyJoin/applyLeave 의 결과. 바뀐 게 없으면 커밋하지 않는다.
 */
export async function saveMembers({
  change, message, branch, git, read, write, membersPath, relPath, log, sleep, attempts = PUSH_ATTEMPTS,
}) {
  for (let n = 1; n <= attempts; n++) {
    must(git(['fetch', '--quiet', 'origin', branch]), 'git fetch');
    must(git(['reset', '--quiet', '--hard', 'FETCH_HEAD']), 'git reset');
    const result = change(readMembers(read, membersPath));
    if (!result.changed) return { ...result, committed: false };
    const text = serializeMembers(result.members);
    // 쓰기 전에 다시 읽어 본다 — 이상한 줄이 한 번 들어가면 다음 실행부터 parseMembers 가 던져서
    // 모든 참가·탈퇴가 멈춘다. 그럴 바엔 이번 한 건만 내부 오류로 끝낸다.
    parseMembers(text);
    write(membersPath, text);
    must(git(['add', '--', relPath]), 'git add');
    must(git(['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, 'commit', '--quiet', '-m', message]), 'git commit');
    if (git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]).ok) return { ...result, committed: true, attempts: n };
    log(`push 가 거절됐어요(${n}/${attempts}) — 그사이 명단이 바뀐 것 같아요. 최신 명단으로 다시 해요.`);
    if (n < attempts) await sleep(400 * n + Math.floor(Math.random() * 800));
  }
  throw new Error(`명단을 ${attempts}번 올려 봤지만 push 가 계속 거절됐어요`);
}

// ── 실행 ────────────────────────────────────────────────────────────────
/**
 * → { skipped } | { action, code, closed, exitCode }
 * 사용자 쪽 문제(gist 없음·형식 틀림 등)는 댓글로 알리고 exitCode 0. 저장 실패 같은 내부 문제만 1.
 */
export async function run({
  env = process.env,
  fetch = globalThis.fetch,
  git = null,
  read = (p) => fs.readFileSync(p, 'utf8'),
  write = (p, s) => fs.writeFileSync(p, s),
  repoRoot = REPO_ROOT,
  membersPath = MEMBERS_PATH,
  now = () => new Date(),
  log = (...a) => console.log(...a),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH 가 없어요 — 깃허브 액션에서만 돌려요');
  // 진짜 git 으로는 액션 안에서만 돈다 — saveMembers 가 git reset --hard 를 하므로,
  // 누가 내 컴퓨터의 작업 폴더에서 돌리면 커밋 안 한 변경이 날아간다
  if (!git && env.GITHUB_ACTIONS !== 'true') throw new Error('깃허브 액션 밖에서는 돌리지 않아요(git reset --hard 를 해요)');
  const event = JSON.parse(read(env.GITHUB_EVENT_PATH));
  if (!event.issue) { log('이슈 이벤트가 아니에요 — 할 일 없음'); return { skipped: 'not_issue', exitCode: 0 }; }

  const repo = env.GITHUB_REPOSITORY || event.repository?.full_name;
  const token = env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY 와 GITHUB_TOKEN 이 필요해요');
  const api = issueApi({ fetch, token, api: (env.GITHUB_API_URL || PUBLIC_API).replace(/\/+$/, ''), repo });
  const branch = event.repository?.default_branch || env.GITHUB_REF_NAME || 'main';

  let issue = event.issue;
  try { issue = await api.get(issue.number); } catch (e) {
    log(`이슈를 다시 읽지 못해 이벤트에 담긴 내용으로 해요: ${e.message}`);
  }
  const n = issue.number;
  if (issue.state !== 'open') { log(`#${n} 은 이미 닫혀 있어요 — 건너뜀`); return { skipped: 'closed', exitCode: 0 }; }
  if (issue.pull_request) return { skipped: 'pull_request', exitCode: 0 };
  const action = parseAction(issue.title);
  if (!action) { log(`#${n} 은 참가·탈퇴 이슈가 아니에요 — 건너뜀`); return { skipped: 'not_join_or_leave', exitCode: 0 }; }
  const author = issue.user?.login;
  if (typeof author !== 'string' || !author) throw new Error(`#${n} 을 연 사람을 알 수 없어요`);

  const store = {
    branch, git: git || realGit(repoRoot), read, write, membersPath, log, sleep,
    relPath: path.relative(repoRoot, membersPath).split(path.sep).join('/'),
  };
  log(`#${n} ${action} — ${author}`);

  let outcome;
  try {
    if (action === 'join') {
      const found = extractGistId(issue.body);
      if (!found.ok) outcome = found;
      else {
        const checked = await fetchGist(found.id, author, { fetch });
        outcome = checked.ok
          ? await saveMembers({
            ...store,
            change: (m) => applyJoin(m, { login: author, gist: checked.gist, now: now() }),
            message: `members: join ${author} (#${n})`,
          })
          : { ...checked, id: found.id };
      }
    } else {
      outcome = await saveMembers({
        ...store,
        change: (m) => applyLeave(m, { login: author }),
        message: `members: leave ${author} (#${n})`,
      });
    }
  } catch (e) {
    log(`처리하다 오류가 났어요: ${e.message}`);
    try { await api.comment(n, commentFor({ code: 'internal' })); } catch (e2) { log(`댓글도 못 달았어요: ${e2.message}`); }
    return { action, code: 'internal', closed: false, exitCode: 1 };
  }

  log(`결과: ${outcome.code}${outcome.committed ? ' (커밋·push 함)' : ''}`);
  if (outcome.committed) {
    // 사이트(GitHub Pages)의 members.json 이 바뀌어야 순위판·수집기가 새 명단을 본다.
    // 안 돼도 명단은 이미 올라갔으니 참가는 성공으로 두고, 관리자가 보도록 경고만 남긴다.
    try { await api.pagesBuild(); log('Pages 다시 빌드를 부탁했어요'); } catch (e) {
      log(`::warning::Pages 빌드를 부탁하지 못했어요 — 사이트 명단이 다음 push 때까지 옛것일 수 있어요: ${e.message}`);
    }
  }
  const ok = isSuccess(outcome.code);
  // login_mismatch 는 outcome.login(gist 안의 login)을 보여 줘야 하므로 outcome 을 뒤에 둔다
  await api.comment(n, commentFor({ login: author, author, site: siteFor(repo), ...outcome }));
  if (ok) await api.close(n);
  return { action, code: outcome.code, closed: ok, exitCode: 0 };
}

// 직접 실행할 때만 돈다(테스트가 import 하면 돌지 않는다).
// 실제 경로로 견준다 — 심볼릭 링크를 거쳐 부르면 import.meta.url(풀린 경로)과 argv 가 달라서,
// 그냥 견주면 아무것도 안 하고 성공(0)으로 끝나 버린다.
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) {
  run().then(
    (r) => { process.exitCode = r.exitCode ?? 0; },
    (e) => { console.error(`참가 처리 실패: ${e.message}`); process.exitCode = 1; },
  );
}
