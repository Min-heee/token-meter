// collect.mjs 수집 결과 검증 — 임시 폴더의 합성 로그만 쓴다(실제 ~/.claude·~/.codex·~/.gemini 는 건드리지 않는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'collect.mjs');
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function collect(files, extra = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-test-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    const out = execFileSync(process.execPath, [SRC, '--json-only',
      '--dir', path.join(root, 'claude'), '--codex-dir', path.join(root, 'codex'), '--gemini-dir', path.join(root, 'gemini'), ...extra],
    { env: { ...process.env, TZ: 'UTC', HOME: root }, encoding: 'utf8' });
    const r = JSON.parse(out);
    return Object.fromEntries((Array.isArray(r) ? r : [r]).map((e) => [e.tool, e]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('Claude: 날짜가 붙은 모델 이름(claude-haiku-4-5-20251001)도 단가표의 단가로 환산한다', () => {
  const r = collect({
    'claude/p/s.jsonl': jl([{ type: 'assistant', sessionId: 's', timestamp: '2026-11-01T00:00:00Z',
      message: { id: 'm1', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }]),
  }).claude;
  assert.equal(r.totals.cost, 1, 'haiku 4.5 입력 1M = $1 (모르는 모델 기본값 $5 가 아니라)');
  assert.equal(r.estimated, false);
  assert.ok(r.byModel['claude-haiku-4-5-20251001'], '모델 이름은 로그에 적힌 그대로 둔다');
});

test('Gemini: 단가는 가장 긴 접두어로 찾는다(flash-lite 가 flash 로 잡히지 않게)', () => {
  const r = collect({
    'gemini/tmp/h/chats/session.json': JSON.stringify({ sessionId: 'g', projectHash: 'h', messages: [
      { id: '1', type: 'gemini', timestamp: '2026-11-01T00:00:00Z', model: 'gemini-2.5-flash-lite-preview-06-17', tokens: { input: 1_000_000, output: 0, cached: 0 } }] }),
  }).gemini;
  assert.equal(r.totals.cost, 0.1);
});

test('Codex: 응답 수도 --since/--until 기간 안의 것만 센다', () => {
  const ev = (ts, payload) => ({ type: 'event_msg', timestamp: ts, payload });
  const r = collect({
    'codex/sessions/rollout-2026-10-01T00-00-00.jsonl': jl([
      { type: 'session_meta', timestamp: '2026-10-01T00:00:00Z', payload: { id: 'c' } },
      { type: 'turn_context', timestamp: '2026-10-01T00:00:00Z', payload: { model: 'gpt-5' } },
      ev('2026-10-01T00:00:01Z', { type: 'agent_message', message: 'x' }),
      ev('2026-10-01T00:00:01Z', { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, total_tokens: 15 } } }),
      ev('2026-11-02T00:00:01Z', { type: 'agent_message', message: 'x' }),
      ev('2026-11-02T00:00:01Z', { type: 'token_count', info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 10, total_tokens: 30 } } }),
    ]),
  }, ['--since', '2026-11-01']).codex;
  assert.equal(r.totals.total, 15);
  assert.equal(r.totals.messages, 1);
});
