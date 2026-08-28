/**
 * RULES CLASSIFIER  (Stage 2 — Diagnose)
 * --------------------------------------
 * Decline code -> root cause, by deterministic lookup. No AI.
 *
 * Every mapped code resolves here in microseconds with zero failure modes.
 * Codes ABSENT from DECLINE_CODE_MAP return UNKNOWN on purpose — Day 5 hands
 * those (and only those) to the LLM diagnosis layer. Do not "fix" an UNKNOWN
 * by extending the taxonomy; the unmapped codes are deliberate test material.
 *
 * This file must never read `_truth`.
 */

const { DECLINE_CODE_MAP, ROOT_CAUSE } = require('../config/taxonomy');

/**
 * Classify a single failed transaction (or a bare error code string).
 *
 * @param {object|string} input  transaction object, or an error_code string
 * @returns {{ root_cause: string, error_code: string|null, mapped: boolean,
 *             source: 'rules', reason: string }}
 */
function classify(input) {
  const errorCode =
    typeof input === 'string' ? input : (input && input.error_code) || null;

  const mappedCause = errorCode ? DECLINE_CODE_MAP[errorCode] : undefined;

  if (mappedCause) {
    return {
      root_cause: mappedCause,
      error_code: errorCode,
      mapped: true,
      source: 'rules',
      reason: `Decline code "${errorCode}" maps deterministically to ${mappedCause}.`,
    };
  }

  return {
    root_cause: ROOT_CAUSE.UNKNOWN,
    error_code: errorCode,
    mapped: false,
    source: 'rules',
    reason: errorCode
      ? `Decline code "${errorCode}" is not in the taxonomy. Rules cannot decide — routes to UNKNOWN (LLM fallback on Day 5).`
      : 'No decline code present. Rules cannot decide — routes to UNKNOWN.',
  };
}

module.exports = { classify };
