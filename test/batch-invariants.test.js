/**
 * BATCH INVARIANT TESTS
 * ---------------------
 * The unit tests assert the rails at the decision boundary. These assert them
 * at the outcome boundary: run the real loop over the real batch, then read
 * the audit trail and prove nothing forbidden actually happened.
 *
 * That distinction matters. A rail can be correct in `decide()` and still be
 * bypassed by a wiring bug in the runner. Only the audit log shows what the
 * agent did.
 *
 * Runs with --no-llm, so the suite never touches the network and needs no key.
 * Regenerates data/audit_log.jsonl, which is a gitignored build artifact.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const AUDIT = path.join(ROOT, 'data', 'audit_log.jsonl');

const NEVER_RETRY = new Set([
  'RISK_BLOCKED',
  'UNKNOWN',
  'CARD_EXPIRED',
  'INVALID_INSTRUMENT',
]);

let events;
let diagnosedCause;

test.before(() => {
  execFileSync('node', ['src/index.js', '--no-llm'], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, GEMINI_API_KEY: '' },
  });

  events = fs
    .readFileSync(AUDIT, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

  diagnosedCause = new Map();
  for (const e of events) {
    if (e.stage === 'diagnose') diagnosedCause.set(e.transaction_id, e.root_cause);
  }
});

test('the run produced a usable audit trail', () => {
  assert.ok(events.length > 100, `only ${events.length} audit events`);
  assert.ok(diagnosedCause.size === 180, `diagnosed ${diagnosedCause.size} of 180`);
});

test('no never-retry transaction was ever retried', () => {
  const violations = [];
  for (const e of events) {
    if (e.stage !== 'retry') continue;
    const cause = diagnosedCause.get(e.transaction_id);
    if (NEVER_RETRY.has(cause)) {
      violations.push(`${e.transaction_id} (${cause}) attempt ${e.attempt}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `money was moved on ${violations.length} forbidden transaction(s):\n  ` +
      violations.slice(0, 5).join('\n  ')
  );
});

test('no transaction exceeded 3 attempts', () => {
  const attempts = new Map();
  for (const e of events) {
    if (e.stage !== 'retry') continue;
    attempts.set(e.transaction_id, (attempts.get(e.transaction_id) || 0) + 1);
  }

  const over = [...attempts.entries()].filter(([, n]) => n > 3);
  assert.deepEqual(
    over.map(([id, n]) => `${id}: ${n}`),
    [],
    'transactions exceeded the 3-attempt cap'
  );

  // Guard against the inverse failure: a cap that "passes" because the loop
  // silently stopped retrying everything.
  assert.ok(attempts.size > 50, `only ${attempts.size} transactions were retried at all`);
});

test('every dispatched action is in the closed action list', () => {
  const ALLOWED = new Set([
    'IMMEDIATE_RETRY',
    'RETRY_AFTER_WINDOW',
    'SCHEDULED_RETRY',
    'REAUTH_LINK',
    'RECOVERY_LINK_ALT_METHOD',
    'UPDATE_INSTRUMENT_REQUEST',
    'ESCALATE_HUMAN',
    'NO_ACTION',
  ]);
  const bad = events
    .filter((e) => e.stage === 'dispatch' && !ALLOWED.has(e.action))
    .map((e) => e.action);
  assert.deepEqual([...new Set(bad)], [], 'an action escaped the closed list');
});

test('the run completes with no LLM and no key', () => {
  const report = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'run_report.json'), 'utf8')
  );
  assert.equal(report.llm.enabled, false);
  assert.equal(report.llm.attempted, 0, 'the LLM was called during a --no-llm run');
  assert.ok(report.result.recovered_count > 0, 'rules-only run recovered nothing');
});
