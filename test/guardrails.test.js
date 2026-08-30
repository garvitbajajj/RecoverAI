/**
 * SAFETY RAIL UNIT TESTS
 * ----------------------
 * These assert the rails at the decision boundary, where they are enforced.
 * Pure functions, no I/O, no network, no key required.
 *
 * If any of these fail, the agent can move money it must never move.
 */

const test = require('node:test');
const assert = require('node:assert');

const { decide } = require('../src/lib/executor');
const {
  ROOT_CAUSE,
  ACTION,
  GUARDRAILS,
  RECOVERY_POLICY,
} = require('../src/config/taxonomy');

/** Causes that must never result in an automated debit, under any context. */
const NEVER_RETRY = [
  ROOT_CAUSE.RISK_BLOCKED,
  ROOT_CAUSE.UNKNOWN,
  ROOT_CAUSE.CARD_EXPIRED,
  ROOT_CAUSE.INVALID_INSTRUMENT,
];

test('RISK_BLOCKED is never retried and always escalates', () => {
  const d = decide(ROOT_CAUSE.RISK_BLOCKED, { amount: 100, retryValueCeiling: 1e12 });
  assert.equal(d.execute, false, 'risk-blocked payment was marked executable');
  assert.equal(d.action, ACTION.ESCALATE_HUMAN);
  assert.ok(d.guardrails_tripped.includes('NEVER_AUTO_RETRY'));
});

test('UNKNOWN is never retried — acting on an undiagnosed cause is worse than not acting', () => {
  const d = decide(ROOT_CAUSE.UNKNOWN, { amount: 100, retryValueCeiling: 1e12 });
  assert.equal(d.execute, false);
  assert.equal(d.action, ACTION.ESCALATE_HUMAN);
});

test('CARD_EXPIRED and INVALID_INSTRUMENT are never retried — the instrument is dead', () => {
  for (const cause of [ROOT_CAUSE.CARD_EXPIRED, ROOT_CAUSE.INVALID_INSTRUMENT]) {
    const d = decide(cause, { amount: 100, retryValueCeiling: 1e12 });
    assert.equal(d.execute, false, `${cause} was marked executable`);
    assert.equal(d.action, ACTION.UPDATE_INSTRUMENT_REQUEST);
  }
});

test('no never-retry cause becomes executable at any attempt count or headroom', () => {
  // Sweep the context space that could plausibly unlock a retry.
  for (const cause of NEVER_RETRY) {
    for (const attemptCount of [0, 1, 2, 3, 10]) {
      const d = decide(cause, {
        attemptCount,
        amount: 1,
        retryValueSoFar: 0,
        retryValueCeiling: Number.MAX_SAFE_INTEGER,
        customerMessagesToday: 0,
      });
      assert.equal(
        d.execute,
        false,
        `${cause} became executable at attemptCount=${attemptCount}`
      );
    }
  }
});

// The expected cap is written literally, NOT read from GUARDRAILS. Reading it
// from the config under test makes the assertion tautological: it would pass
// at any value, including 99. A mutation run caught exactly that.
const EXPECTED_MAX_ATTEMPTS = 3;

test('the documented attempt cap has not drifted', () => {
  assert.equal(
    GUARDRAILS.MAX_ATTEMPTS_PER_TRANSACTION,
    EXPECTED_MAX_ATTEMPTS,
    'global attempt cap changed; README and architecture doc say 3'
  );
  for (const [cause, policy] of Object.entries(RECOVERY_POLICY)) {
    assert.ok(
      policy.maxAttempts <= EXPECTED_MAX_ATTEMPTS,
      cause + ' policy allows ' + policy.maxAttempts + ' attempts, above the cap of 3'
    );
  }
});

test('attempt cap stops retries past the maximum', () => {
  const cap = EXPECTED_MAX_ATTEMPTS;

  // At the cap boundary the next attempt must be refused.
  const capped = decide(ROOT_CAUSE.INSUFFICIENT_FUNDS, {
    attemptCount: cap,
    amount: 100,
    retryValueCeiling: 1e12,
  });
  assert.equal(capped.execute, false, `attempt ${cap + 1} was allowed`);
  assert.equal(capped.action, ACTION.ESCALATE_HUMAN);
  assert.ok(capped.guardrails_tripped.includes('MAX_ATTEMPTS'));

  // And no cause may ever report an effective cap above the global one.
  for (const cause of Object.values(ROOT_CAUSE)) {
    const d = decide(cause, { amount: 1, retryValueCeiling: 1e12 });
    assert.ok(
      d.max_attempts <= cap,
      `${cause} allows ${d.max_attempts} attempts, above the global cap of ${cap}`
    );
  }
});

test('value cap clamps the moment the ceiling would be crossed', () => {
  const ceiling = 10000;

  // Just under: allowed.
  const under = decide(ROOT_CAUSE.INSUFFICIENT_FUNDS, {
    retryValueSoFar: 9000,
    amount: 1000,
    retryValueCeiling: ceiling,
  });
  assert.equal(under.execute, true, 'a retry exactly at the ceiling was blocked');

  // One paisa over: blocked.
  const over = decide(ROOT_CAUSE.INSUFFICIENT_FUNDS, {
    retryValueSoFar: 9000,
    amount: 1001,
    retryValueCeiling: ceiling,
  });
  assert.equal(over.execute, false, 'a retry past the ceiling was allowed');
  assert.ok(over.guardrails_tripped.includes('RETRY_VALUE_CAP'));
});

test('every decision returns an action from the closed list', () => {
  const allowed = new Set(Object.values(ACTION));
  for (const cause of Object.values(ROOT_CAUSE)) {
    for (const attemptCount of [0, 3]) {
      const d = decide(cause, { attemptCount, amount: 1, retryValueCeiling: 1e12 });
      assert.ok(allowed.has(d.action), `${cause} produced action "${d.action}"`);
    }
  }
});
