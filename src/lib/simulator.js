/**
 * RETRY SIMULATOR + SCORER
 * ------------------------
 * THE ONLY FILE PERMITTED TO READ `_truth`.
 *
 * In production a real Razorpay test-mode retry call would go here. For the
 * batch demo we consult the hidden ground truth the generator planted:
 * `_truth.would_recover_on_retry`. Keeping this read isolated to one file is
 * what makes "money recovered" an earned number rather than a self-report --
 * the classifier, executor and dispatcher all decide blind.
 *
 * ATTEMPT MODELLING
 * `would_recover_on_retry` says whether a payment will EVER come back. It does
 * not say WHEN. A payment that recovers does so on attempt 1, 2 or 3 -- an
 * account funded tomorrow does not care that we asked today. So we draw the
 * landing attempt deterministically from the transaction id.
 *
 * This is what gives the stopping rules teeth: some payments would have landed
 * on attempt 4, and the 3-attempt cap means we never see that money. That cost
 * is real and the report states it rather than hiding it.
 */

/** Stable 32-bit hash of a string -- reproducible across runs, no shared RNG state. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Which attempt would this payment land on, if it lands at all?
 * Weighted towards early attempts: most recoveries that happen, happen fast.
 *   attempt 1: 55%   attempt 2: 25%   attempt 3: 12%   attempt 4+: 8% (unreachable)
 */
function landingAttempt(transaction) {
  const r = hash(transaction.transaction_id || '');
  if (r < 0.55) return 1;
  if (r < 0.8) return 2;
  if (r < 0.92) return 3;
  return 4; // beyond the global cap -- deliberately out of reach
}

/**
 * Simulate one automated retry attempt.
 * @param {object} transaction   full record (with `_truth`)
 * @param {number} attemptNumber 1-based
 * @returns {{ recovered: boolean, amount: number, attempt: number }}
 */
function simulateRetry(transaction, attemptNumber = 1) {
  const truth = transaction._truth || {};
  const everRecovers = truth.would_recover_on_retry === true;

  return {
    recovered: everRecovers && landingAttempt(transaction) === attemptNumber,
    amount: transaction.amount || 0,
    attempt: attemptNumber,
  };
}

/**
 * Honest denominator: how much of this batch was EVER recoverable by retry,
 * regardless of what the agent chose to do. The ceiling the result is measured
 * against.
 * @returns {{ count: number, value: number }}  value in paise
 */
function recoverableCeiling(batch) {
  let count = 0;
  let value = 0;
  for (const t of batch) {
    if (t._truth && t._truth.would_recover_on_retry === true) {
      count += 1;
      value += t.amount || 0;
    }
  }
  return { count, value };
}

/**
 * The slice of the ceiling that the 3-attempt cap puts permanently out of
 * reach. Reported explicitly -- it is the price of the stopping rule, and
 * naming it is more honest than quietly missing the money.
 * @returns {{ count: number, value: number }}
 */
function beyondAttemptCap(batch, maxAttempts) {
  let count = 0;
  let value = 0;
  for (const t of batch) {
    if (
      t._truth &&
      t._truth.would_recover_on_retry === true &&
      landingAttempt(t) > maxAttempts
    ) {
      count += 1;
      value += t.amount || 0;
    }
  }
  return { count, value };
}

module.exports = { simulateRetry, recoverableCeiling, beyondAttemptCap };
