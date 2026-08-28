/**
 * RETRY SIMULATOR + SCORER
 * ------------------------
 * THE ONLY FILE PERMITTED TO READ `_truth`.
 *
 * In production a real Razorpay test-mode retry call would go here. For the
 * batch demo we consult the hidden ground truth the generator planted:
 * `_truth.would_recover_on_retry`. Keeping this read isolated to one file is
 * what makes "money recovered" an earned number rather than a self-report —
 * the classifier and executor decide blind.
 */

/**
 * Simulate a single automated retry.
 * @param {object} transaction  a full transaction record (with `_truth`)
 * @returns {{ recovered: boolean, amount: number }}
 */
function simulateRetry(transaction) {
  const truth = transaction._truth || {};
  return {
    recovered: truth.would_recover_on_retry === true,
    amount: transaction.amount || 0,
  };
}

/**
 * Honest denominator: how much of this batch was EVER recoverable by retry,
 * regardless of what the agent chose to do. This is the ceiling the agent's
 * result is measured against.
 * @param {object[]} batch
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

module.exports = { simulateRetry, recoverableCeiling };
