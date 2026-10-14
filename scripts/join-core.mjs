/**
 * 토큰 계량기 — 참가·탈퇴 처리의 판단 로직 (네트워크·파일 없음)
 *
 * scripts/join.mjs(깃허브 액션)가 부른다. 여기에는 판단만 있고 입출력은 없다 —
 * 그래서 테스트가 가짜 gist·가짜 명단만으로 모든 갈래를 확인할 수 있다.
 *
 *   이슈 제목      → join / leave / 무시
 *   이슈 본문      → gist id (주소 여러 꼴, 또는 id 만)
 *   gist API 응답  → 주인·파일·크기 검사, 파일 내용 → 형식 검사
 *   명단           → 넣기·바꾸기·빼기 (login 대소문자 무시, 정렬, 최대 2000명)
 *   결과           → 이슈에 달 댓글(한국어 먼저, 영어 뒤)
 *
 * 형식 검사는 docs/board.mjs 와 같은 규칙에 하나를 더한다: 모르는 칸이 있으면 거절한다.
 * 순위판은 모르는 칸을 버리고 읽지만, gist 는 이미 공개돼 있고 지난 버전도 영원히 남는다.
 * 이름·프로젝트 같은 칸이 섞인 gist 라면 참가 단계에서 멈추고 알려 주는 편이 낫다.
 */

// ── 상수 ────────────────────────────────────────────────────────────────
export const GIST_FILE = 'token-meter.json';
export const MAX_BYTES = 256 * 1024;       // token-meter.json 크기 상한
export const MAX_MEMBERS = 2000;
export const MAX_MODELS = 100;
export const TOOLS = ['claude', 'codex', 'gemini'];
export const SITE_URL = 'https://min-heee.github.io/token-meter/';
export const RAW_HOST = 'https://gist.githubusercontent.com/';

const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;   // board.mjs 와 같다
const ID_RE = /^[0-9a-f]{20,32}$/i;                   // 본문에서 찾는 gist id — 짧으면 'added' 같은 낱말도 걸린다
const MEMBER_GIST_RE = /^[0-9a-f]{5,64}$/i;           // 명단 파일 검사는 board.mjs 와 같은 너비
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/;

// 화이트리스트 — 계약(contract 1)에 적힌 칸만 허용
const PAYLOAD_KEYS = ['schema', 'app', 'login', 'updatedAt', 'entries'];
const ENTRY_KEYS = ['tool', 'generatedAt', 'tz', 'range', 'totals', 'messages', 'sessions', 'subagents',
  'split', 'byModel', 'byDay', 'estimated'];
const TOTAL_KEYS = ['input', 'output', 'cacheWrite', 'cacheRead', 'total', 'cost', 'messages'];
const RANGE_KEYS = ['from', 'to', 'activeDays'];
const SPLIT_KEYS = ['main', 'sub'];

// ── 작은 도구 ───────────────────────────────────────────────────────────
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;   // board.mjs 와 같은 상한
const lower = (s) => String(s).toLowerCase();
const isIso = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const byteLength = (s) => new TextEncoder().encode(s).length;

/** 검사 실패를 위로 던질 때만 쓰는 값. 밖으로는 { ok:false, code, ... } 로 바뀌어 나간다. */
class Reject {
  constructor(code, data) { this.code = code; this.data = data; }
}
const reject = (code, data = {}) => { throw new Reject(code, data); };

// 실패 위치(path)는 이슈 댓글로 영구히 공개된다. gist 는 지우면 사라지지만 댓글은 남는다 —
// 남이 정한 칸 이름("/Users/me/비밀-프로젝트" 같은 것)은 옮기지 않고, 아는 이름만 보인다.
const KNOWN_NAMES = new Set(['schema', 'app', 'login', 'updatedAt', 'entries', 'tool', 'generatedAt', 'tz', 'range',
  'from', 'to', 'activeDays', 'totals', 'input', 'output', 'cacheWrite', 'cacheRead', 'total', 'cost', 'messages',
  'sessions', 'subagents', 'split', 'main', 'sub', 'byModel', 'byDay', 'estimated',
  // 계약이 '올리지 말 것'으로 꼽은 흔한 칸 이름 — 이름 자체는 개인 정보가 아니고, 무엇을 지울지 알려 준다
  'name', 'nickname', 'projects', 'projectCount', 'cwd', 'path', 'sessionIds', '_stats', 'v']);
const shown = (k) => (KNOWN_NAMES.has(k) ? k : '…');
const shownModel = (n) => (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(n) ? n : '…');   // 흔한 모델 이름꼴만
const shownDay = (d) => (DAY_RE.test(d) ? d : '…');
const badSchema = (path, why) => reject('bad_schema', { path, why });
const badEntry = (path, why) => reject('bad_entries', { path, why });
const missingOr = (v, why) => (v === undefined ? 'missing' : why);

// ── 이슈 제목 → 할 일 ───────────────────────────────────────────────────
/**
 * 'join' / 'leave' / null. 대소문자 무시. 앞뒤 괄호·문장부호는 벗긴다("[Join]", "join!").
 * 낱말 뒤에는 끝이거나 구분 기호(: - | /)만 온다 — "Join button is broken" 같은 버그 제보를
 * 참가 신청으로 잘못 읽지 않으려고.
 */
export function parseAction(title) {
  const t = String(title ?? '').normalize('NFC').toLowerCase()
    .replace(/^[\s[\](){}<>"'`*#.,!?_~]+/, '')
    .replace(/[\s[\](){}<>"'`*#.,!?_~]+$/, '');
  const m = /^(join|leave)(?:$|\s*[:|/\-–—])/.exec(t);
  return m ? m[1] : null;
}

// ── 이슈 본문 → gist id ─────────────────────────────────────────────────
// 주소 뒤는 ASCII 주소 글자만 — "…/<id>입니다", "…/<id>。" 처럼 한글·전각 문장부호가 붙어도 끊긴다
const URL_RE = /(?:https?:\/\/)?(?:www\.)?(gist\.githubusercontent\.com|gist\.github\.com|api\.github\.com\/gists)\/([A-Za-z0-9\-._~%/?#=&+:@!$,;*']*)/gi;
const SSH_RE = /git@gist\.github\.com:([0-9a-z]+)(?:\.git)?/gi;
const BARE_RE = /(?<![0-9a-z])[0-9a-f]{20,32}(?![0-9a-z])/gi;

function idFromUrl(host, rest) {
  // 마디마다 앞쪽 영숫자만 — "<id>.git", 문장 끝 "<id>.", 굵게 쓴 "**…/<id>**" 의 꼬리를 떼어 낸다
  const segs = rest.split(/[?#]/)[0].split('/').filter(Boolean).map((s) => /^[0-9a-z]*/i.exec(s)[0]);
  if (host === 'api.github.com/gists') return segs[0];
  if (host === 'gist.githubusercontent.com') return segs[1];   // /<login>/<id>/raw/...
  // gist.github.com/<login>/<id>[/<revision>] 또는 gist.github.com/<id>
  if (segs.length >= 2 && ID_RE.test(segs[1])) return segs[1];
  return segs[0];
}

/**
 * 본문 어디에 있든 gist 주소·id 를 찾는다. 주소를 먼저 뽑고 지운 뒤 남은 글에서 id 만 있는 것을 찾는다
 * (주소 속 아이디가 16진수처럼 생겼어도 id 로 오인하지 않게). 서로 다른 id 가 둘 이상이면 고르지 않는다.
 * → { ok:true, id } | { ok:false, code:'no_gist' } | { ok:false, code:'multiple_gists', ids }
 */
export function extractGistId(body) {
  let text = String(body ?? '').normalize('NFC');
  const ids = [];
  const add = (id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return;
    const k = id.toLowerCase();
    if (!ids.includes(k)) ids.push(k);
  };
  text = text.replace(SSH_RE, (_, id) => { add(id); return ' '; });
  text = text.replace(URL_RE, (_, host, rest) => { add(idFromUrl(host.toLowerCase(), rest)); return ' '; });
  for (const m of text.matchAll(BARE_RE)) add(m[0]);
  if (ids.length === 0) return { ok: false, code: 'no_gist' };
  if (ids.length > 1) return { ok: false, code: 'multiple_gists', ids };
  return { ok: true, id: ids[0] };
}

// ── gist API 응답 검사 ──────────────────────────────────────────────────
/**
 * GET /gists/<id> 의 응답을 본다. 내용이 잘렸으면(1MB 초과 등) raw 주소를 돌려준다 —
 * 그 주소를 받아 오는 일은 join.mjs 몫이다.
 * → { ok:true, content } | { ok:true, rawUrl } | { ok:false, code, ... }
 */
export function inspectGist(gist, author) {
  if (!isObj(gist)) return { ok: false, code: 'unavailable', status: 'bad response' };
  const owner = isObj(gist.owner) && typeof gist.owner.login === 'string' ? gist.owner.login : null;
  if (!owner || lower(owner) !== lower(author)) {
    return { ok: false, code: 'owner_mismatch', owner: owner || '?', author };
  }
  const file = isObj(gist.files) ? gist.files[GIST_FILE] : null;
  if (!isObj(file)) return { ok: false, code: 'missing_file' };
  if (isNum(file.size) && file.size > MAX_BYTES) return { ok: false, code: 'too_large', size: file.size };
  if (file.truncated === true || typeof file.content !== 'string') {
    // raw 주소는 gist 전용 호스트만 따라간다
    const url = typeof file.raw_url === 'string' && file.raw_url.startsWith(RAW_HOST) ? file.raw_url : null;
    return url ? { ok: true, rawUrl: url } : { ok: false, code: 'unavailable', status: 'raw_url' };
  }
  return { ok: true, content: file.content };
}

/** token-meter.json 의 글 그대로 → 크기·JSON·형식 검사 */
export function checkContent(text, author) {
  const size = byteLength(String(text));
  if (size > MAX_BYTES) return { ok: false, code: 'too_large', size };
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, code: 'bad_json' }; }
  return checkPayload(doc, author);
}

// ── 내용 형식 검사 ──────────────────────────────────────────────────────
function onlyKeys(obj, allowed, at, fail) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(at ? `${at}.${shown(k)}` : shown(k), 'unknown_key');
}
/** 없어도 되는 숫자(null 도 없음으로 친다) */
function optNum(v, at) {
  if (v !== undefined && v !== null && !isNum(v)) badEntry(at, 'not_number');
}

function checkEntry(e, i, seen) {
  const at = `entries[${i}]`;
  if (!isObj(e)) badEntry(at, 'not_object');
  onlyKeys(e, ENTRY_KEYS, at, badEntry);

  if (!TOOLS.includes(e.tool)) badEntry(`${at}.tool`, missingOr(e.tool, 'bad_tool'));
  if (seen.has(e.tool)) badEntry(`${at}.tool`, 'duplicate_tool');
  seen.add(e.tool);

  // totals — 누적 순위의 근거. 7칸 모두 있어야 하고, 그 밖의 칸은 없어야 한다
  // (칸 이름도 공개된다 — 숫자 값이어도 "/Users/me/비밀-프로젝트" 같은 이름을 받지 않는다)
  if (!isObj(e.totals)) badEntry(`${at}.totals`, missingOr(e.totals, 'not_object'));
  onlyKeys(e.totals, TOTAL_KEYS, `${at}.totals`, badEntry);
  for (const k of TOTAL_KEYS) if (e.totals[k] === undefined) badEntry(`${at}.totals.${k}`, 'missing');
  for (const [k, v] of Object.entries(e.totals)) if (!isNum(v)) badEntry(`${at}.totals.${k}`, 'not_number');

  // byDay — 오늘·이번 주·이번 달 순위의 근거. { "YYYY-MM-DD": [총, 출력, 환산] }
  if (!isObj(e.byDay)) badEntry(`${at}.byDay`, missingOr(e.byDay, 'not_object'));
  for (const [day, v] of Object.entries(e.byDay)) {
    if (!DAY_RE.test(day)) badEntry(`${at}.byDay.${shownDay(day)}`, 'bad_day');
    if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) badEntry(`${at}.byDay.${day}`, 'not_day_triple');
  }

  if (e.byModel !== undefined && e.byModel !== null) {
    if (!isObj(e.byModel)) badEntry(`${at}.byModel`, 'not_object');
    const models = Object.entries(e.byModel);
    if (models.length > MAX_MODELS) badEntry(`${at}.byModel`, 'too_many');
    for (const [name, m] of models) {
      // __proto__ 는 수집기가 (other) 로 바꿔 올린다 — 손으로 만든 gist 라면 사이트 코드가 obj[이름] 으로
      // 원형을 건드릴 여지를 참가 단계에서 막는다
      if (!name || name.length > 100 || name === '__proto__' || CTRL_RE.test(name)) badEntry(`${at}.byModel`, 'bad_model_name');
      const mat = `${at}.byModel.${shownModel(name)}`;
      if (!isObj(m)) badEntry(mat, 'not_object');
      onlyKeys(m, TOTAL_KEYS, mat, badEntry);   // 모델마다의 칸도 totals 와 같은 7칸만
      for (const [k, v] of Object.entries(m)) if (!isNum(v)) badEntry(`${mat}.${k}`, 'not_number');
    }
  }

  if (e.range !== undefined && e.range !== null) {
    if (!isObj(e.range)) badEntry(`${at}.range`, 'not_object');
    onlyKeys(e.range, RANGE_KEYS, `${at}.range`, badEntry);
    for (const k of ['from', 'to']) {
      const v = e.range[k];
      if (v !== undefined && v !== null && !(typeof v === 'string' && DAY_RE.test(v))) badEntry(`${at}.range.${k}`, 'bad_day');
    }
    optNum(e.range.activeDays, `${at}.range.activeDays`);
  }

  if (e.split !== undefined && e.split !== null) {
    if (!isObj(e.split)) badEntry(`${at}.split`, 'not_object');
    onlyKeys(e.split, SPLIT_KEYS, `${at}.split`, badEntry);
    for (const k of SPLIT_KEYS) optNum(e.split[k], `${at}.split.${k}`);
  }

  if (e.generatedAt !== undefined && e.generatedAt !== null && !isIso(e.generatedAt)) badEntry(`${at}.generatedAt`, 'not_date');
  if (e.tz !== undefined && e.tz !== null && !(typeof e.tz === 'string' && TZ_RE.test(e.tz))) badEntry(`${at}.tz`, 'bad_tz');
  for (const k of ['messages', 'sessions', 'subagents']) optNum(e[k], `${at}.${k}`);
  if (e.estimated !== undefined && typeof e.estimated !== 'boolean') badEntry(`${at}.estimated`, 'not_bool');
}

/**
 * JSON 을 푼 gist 내용 → { ok:true } | { ok:false, code, path?, why?, login?, author? }
 * 순서: 형식(schema) → 모르는 칸 → login(이슈 연 사람과 같은지) → 나머지 → 기록들
 */
export function checkPayload(doc, author) {
  try {
    if (!isObj(doc)) badSchema('$', 'not_object');
    if (doc.schema !== 1) badSchema('schema', missingOr(doc.schema, 'bad_value'));
    onlyKeys(doc, PAYLOAD_KEYS, '', badSchema);
    if (typeof doc.login !== 'string' || !LOGIN_RE.test(doc.login)) badSchema('login', missingOr(doc.login, 'bad_login'));
    if (lower(doc.login) !== lower(author)) reject('login_mismatch', { login: doc.login, author });
    if (doc.app !== undefined && doc.app !== 'token-meter') badSchema('app', 'bad_value');
    if (doc.updatedAt !== undefined && !isIso(doc.updatedAt)) badSchema('updatedAt', 'not_date');
    if (!Array.isArray(doc.entries)) badSchema('entries', missingOr(doc.entries, 'not_array'));
    if (doc.entries.length > TOOLS.length) badEntry('entries', 'too_many');
    const seen = new Set();
    doc.entries.forEach((e, i) => checkEntry(e, i, seen));
    return { ok: true };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, code: e.code, ...e.data };
    throw e;
  }
}

// ── 명단 ────────────────────────────────────────────────────────────────
// GitHub 아이디는 영숫자·하이픈뿐이라 소문자 비교로 충분하다(localeCompare 는 환경마다 다를 수 있다)
const byLogin = (a, b) => {
  const x = lower(a.login), y = lower(b.login);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** 겹치는 login(대소문자 무시)은 앞의 것만 남기고 login 순으로 정렬 */
export function normalizeMembers(list) {
  const seen = new Set(), out = [];
  for (const m of list) {
    const k = lower(m.login);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ login: m.login, gist: m.gist, joinedAt: m.joinedAt ?? null });
  }
  return out.sort(byLogin);
}

/** docs/members.json 글 → 명단 배열. 손으로 고치다 깨졌으면 던진다(추측해서 고치지 않는다). */
export function parseMembers(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('members.json 을 JSON 으로 읽지 못했어요'); }
  if (!isObj(doc) || doc.schema !== 1 || !Array.isArray(doc.members)) {
    throw new Error('members.json 형식이 달라요(schema 1, members 배열이어야 해요)');
  }
  const list = doc.members.map((m) => {
    if (!isObj(m) || typeof m.login !== 'string' || !LOGIN_RE.test(m.login)
        || typeof m.gist !== 'string' || !MEMBER_GIST_RE.test(m.gist)) {
      throw new Error(`members.json 에 이상한 줄이 있어요: ${JSON.stringify(m).slice(0, 80)}`);
    }
    return { login: m.login, gist: m.gist, joinedAt: isIso(m.joinedAt) ? m.joinedAt : null };
  });
  return normalizeMembers(list);
}

/** 명단 → docs/members.json 글 (2칸 들여쓰기, 끝 줄바꿈) */
export function serializeMembers(members) {
  return JSON.stringify({ schema: 1, members: normalizeMembers(members) }, null, 2) + '\n';
}

/**
 * 참가: 없으면 넣고, 있으면(login 대소문자 무시) gist 를 바꾼다. 처음 참가한 시각(joinedAt)은 지킨다.
 * → { changed, code: 'joined'|'replaced'|'unchanged'|'full', members, gist, prev? }
 */
export function applyJoin(members, { login, gist, now = new Date() }) {
  const i = members.findIndex((m) => lower(m.login) === lower(login));
  if (i >= 0) {
    const prev = members[i];
    const next = { login, gist, joinedAt: prev.joinedAt ?? now.toISOString() };
    const changed = prev.login !== next.login || prev.gist !== next.gist || prev.joinedAt !== next.joinedAt;
    const list = members.slice();
    list[i] = next;
    return {
      changed, code: prev.gist === gist ? 'unchanged' : 'replaced',
      members: normalizeMembers(list), gist, prev: prev.gist,
    };
  }
  if (members.length >= MAX_MEMBERS) return { changed: false, code: 'full', members, gist, max: MAX_MEMBERS };
  return {
    changed: true, code: 'joined',
    members: normalizeMembers([...members, { login, gist, joinedAt: now.toISOString() }]), gist,
  };
}

/** 탈퇴: 이슈를 연 사람만 뺀다. → { changed, code: 'left'|'not_member', members, gist? } */
export function applyLeave(members, { login }) {
  const prev = members.find((m) => lower(m.login) === lower(login));
  if (!prev) return { changed: false, code: 'not_member', members };
  return { changed: true, code: 'left', members: members.filter((m) => m !== prev), gist: prev.gist };
}

// ── 댓글 ────────────────────────────────────────────────────────────────
export const SUCCESS_CODES = ['joined', 'replaced', 'unchanged', 'left', 'not_member'];
export const isSuccess = (code) => SUCCESS_CODES.includes(code);

/**
 * 남이 정한 글자(모델 이름·login 등)는 꼭 인라인 코드로 감싼다 — @멘션이 울리거나
 * 마크다운이 깨지지 않게. 백틱·줄바꿈·제어 문자는 빈칸으로, 80자에서 자른다.
 */
export const code = (s) => '`' + String(s ?? '').replace(/[`\u0000-\u001f\u007f]/g, ' ').slice(0, 80) + '`';

const WHY = {
  missing:        ['빠졌어요', 'missing'],
  not_object:     ['객체가 아니에요', 'not an object'],
  not_array:      ['배열이 아니에요', 'not an array'],
  not_number:     ['0 이상의 숫자가 아니에요', 'not a non-negative number'],
  not_date:       ['날짜·시각 꼴이 아니에요', 'not a valid date/time'],
  not_bool:       ['true/false 가 아니에요', 'not true/false'],
  bad_value:      ['값이 달라요', 'unexpected value'],
  bad_login:      ['GitHub 아이디 꼴이 아니에요', 'not a GitHub login'],
  bad_tool:       ['claude·codex·gemini 중 하나가 아니에요', 'not one of claude, codex, gemini'],
  duplicate_tool: ['같은 도구가 두 번 나와요', 'the same tool appears twice'],
  too_many:       ['너무 많아요', 'too many items'],
  bad_day:        ['날짜 꼴(YYYY-MM-DD)이 아니에요', 'not a YYYY-MM-DD date'],
  not_day_triple: ['[총 토큰, 출력 토큰, 환산액] 숫자 3개가 아니에요', 'not [total, output, cost]'],
  bad_tz:         ['시간대 이름 꼴이 아니에요', 'not a time zone name'],
  bad_model_name: ['모델 이름이 이상해요', 'odd model name'],
  unknown_key:    ['올리면 안 되는 칸이에요', 'a field that must not be published'],
};
const why = (w, lang) => (WHY[w] || [String(w), String(w)])[lang === 'ko' ? 0 : 1];
const status = (s) => code(typeof s === 'number' ? `HTTP ${s}` : (s ?? 'unknown'));
const kb = (n) => Math.ceil(n / 1024);

// 코드마다 [한국어, 영어]. d = 결과 + { login, author, site }
const TEXT = {
  joined: (d) => [
    `참가 완료! ${code(d.login)} 님의 gist(${code(d.gist)})를 순위판 명단에 넣었어요. 사이트에 보이기까지 몇 분 걸릴 수 있어요: ${d.site}\n앞으로 \`node collect.mjs --publish\` 로 올릴 때마다 순위판 숫자도 바뀌어요.`,
    `You're in! Added ${code(d.login)}'s gist (${code(d.gist)}) to the leaderboard members list. It can take a few minutes to show up: ${d.site}\nFrom now on, every \`node collect.mjs --publish\` updates your numbers on the board.`,
  ],
  replaced: (d) => [
    `gist를 바꿨어요. 이제 ${code(d.login)} 님의 숫자는 ${code(d.gist)} 에서 읽어요(전에는 ${code(d.prev)}).`,
    `Switched your gist. ${code(d.login)}'s numbers are now read from ${code(d.gist)} (previously ${code(d.prev)}).`,
  ],
  unchanged: (d) => [
    `이미 참가 중이에요. ${code(d.login)} 님의 gist(${code(d.gist)})가 명단에 그대로 있어요.`,
    `You're already in. ${code(d.login)}'s gist (${code(d.gist)}) is already on the members list.`,
  ],
  left: (d) => [
    `명단에서 뺐어요. 사이트에서 사라지기까지 몇 분 걸릴 수 있어요.\ngist는 직접 지워 주세요: https://gist.github.com/${d.login}/${d.gist}\n지우기 전까지는 gist와 지난 버전(revision)이 모두 공개로 남아요.`,
    `Removed you from the members list. It can take a few minutes to disappear from the site.\nPlease delete the gist yourself: https://gist.github.com/${d.login}/${d.gist}\nUntil you delete it, the gist and all its past revisions stay public.`,
  ],
  not_member: (d) => [
    `${code(d.login)} 님은 명단에 없어서 바꿀 게 없어요. 올려 둔 gist가 있다면 직접 지워 주세요: https://gist.github.com/${d.login}`,
    `${code(d.login)} is not on the members list, so nothing changed. If you published a gist, please delete it yourself: https://gist.github.com/${d.login}`,
  ],
  no_gist: () => [
    '본문에서 gist 주소나 ID를 찾지 못했어요. `node collect.mjs --publish` 가 보여 주는 참가 링크로 이슈를 열거나, gist 칸에 `https://gist.github.com/<아이디>/<gist ID>` 꼴로 적어 주세요.',
    'Could not find a gist URL or ID in this issue. Open the join link that `node collect.mjs --publish` prints, or put something like `https://gist.github.com/<login>/<gist id>` in the gist field.',
  ],
  multiple_gists: (d) => [
    `gist가 여러 개 적혀 있어요: ${d.ids.map(code).join(', ')}. 하나만 남겨 주세요.`,
    `Found more than one gist: ${d.ids.map(code).join(', ')}. Please leave just one.`,
  ],
  not_found: (d) => [
    `gist(${code(d.id)})를 찾지 못했어요. 지워졌거나 ID가 틀렸을 수 있어요.`,
    `Gist ${code(d.id)} was not found. It may have been deleted, or the ID is wrong.`,
  ],
  owner_mismatch: (d) => [
    `이 gist(${code(d.id)})의 주인(${code(d.owner)})과 이슈를 연 사람(${code(d.author)})이 달라요. 내 계정에 올린 gist로만 참가할 수 있어요.`,
    `This gist (${code(d.id)}) belongs to ${code(d.owner)}, but this issue was opened by ${code(d.author)}. You can only join with a gist in your own account.`,
  ],
  missing_file: (d) => [
    `이 gist(${code(d.id)})에 \`token-meter.json\` 파일이 없어요. \`node collect.mjs --publish\` 로 다시 올려 주세요.`,
    `This gist (${code(d.id)}) has no \`token-meter.json\` file. Run \`node collect.mjs --publish\` again.`,
  ],
  too_large: (d) => [
    `\`token-meter.json\` 파일이 너무 커요(${kb(d.size)} KB, 최대 256 KB).`,
    `\`token-meter.json\` is too large (${kb(d.size)} KB, max 256 KB).`,
  ],
  bad_json: () => [
    '`token-meter.json` 파일을 JSON으로 읽지 못했어요. `node collect.mjs --publish` 로 다시 올려 주세요.',
    '`token-meter.json` is not valid JSON. Run `node collect.mjs --publish` again.',
  ],
  bad_schema: (d) => [
    `\`token-meter.json\` 파일의 형식이 달라요 — ${code(d.path)}: ${why(d.why, 'ko')}. 최신 \`collect.mjs\` 로 다시 올려 주세요.`,
    `\`token-meter.json\` has an unexpected format — ${code(d.path)}: ${why(d.why, 'en')}. Publish again with the latest \`collect.mjs\`.`,
  ],
  login_mismatch: (d) => [
    `\`token-meter.json\` 파일 안의 login(${code(d.login)})이 이슈를 연 사람(${code(d.author)})과 달라요.`,
    `The login inside \`token-meter.json\` (${code(d.login)}) does not match the issue author (${code(d.author)}).`,
  ],
  bad_entries: (d) => [
    `기록 칸이 잘못됐어요 — ${code(d.path)}: ${why(d.why, 'ko')}. 최신 \`collect.mjs\` 로 다시 올려 주세요.`,
    `An entry is malformed — ${code(d.path)}: ${why(d.why, 'en')}. Publish again with the latest \`collect.mjs\`.`,
  ],
  full: (d) => [
    `명단이 꽉 찼어요(최대 ${d.max ?? MAX_MEMBERS}명). 관리자에게 알려 주세요.`,
    `The members list is full (${d.max ?? MAX_MEMBERS} max). Please let the maintainer know.`,
  ],
  unavailable: (d) => [
    `지금 GitHub에서 gist를 읽지 못했어요(${status(d.status)}). 잠시 뒤 다시 시도해 주세요.`,
    `Could not read the gist from GitHub right now (${status(d.status)}). Please try again in a little while.`,
  ],
  internal: () => [
    '명단을 저장하다 문제가 생겼어요. 관리자가 확인할게요.',
    'Something went wrong while saving the members list. The maintainer will take a look.',
  ],
};

export const RETRY_FOOTER = [
  '고친 뒤 이 이슈의 제목이나 본문을 수정(Edit)하거나, 닫았다가 다시 열면 다시 확인해요.',
  'Once fixed, edit this issue (or close and reopen it) and it will be checked again.',
];

/**
 * 결과 → 이슈 댓글. 한국어 문단 먼저, 빈 줄, 영어 문단. 실패(내부 오류 빼고)에는 다시 시도하는 법을 붙인다.
 * 맨 끝의 HTML 주석은 화면에 안 보인다 — 봇 댓글을 나중에 골라낼 때 쓰는 표시.
 */
export function commentFor(result) {
  const d = { site: SITE_URL, ...result };
  const make = TEXT[d.code] || TEXT.internal;
  const [ko, en] = make(d);
  const footer = !isSuccess(d.code) && d.code !== 'internal' && TEXT[d.code];
  return [
    footer ? `${ko}\n${RETRY_FOOTER[0]}` : ko,
    footer ? `${en}\n${RETRY_FOOTER[1]}` : en,
    `<!-- token-meter-join:${TEXT[d.code] ? d.code : 'internal'} -->`,
  ].join('\n\n');
}

/** owner/repo → GitHub Pages 주소 (https://<owner 소문자>.github.io/<repo>/) */
export function siteFor(repo) {
  const [owner, name] = String(repo || '').split('/');
  return owner && name ? `https://${owner.toLowerCase()}.github.io/${name}/` : SITE_URL;
}
