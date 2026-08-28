/**
 * RECOVERY EXECUTOR  (Stage 3 — Decide & Act)
 * ------------------------------------------
 * root cause -> RECOVERY_POLICY -> a single bounded action, with guardrails
 * enforced ABOVE the per-cause policy.
 *
 * Nothing outside taxonomy.ACTION may ever be returned — asserted before return.
 *
 * "execute: true" is the only path that moves money. It is granted only when:
 *   - the policy allows auto-retry for that cause, AND
 *   - the per-cause attempt cap is not yet spent, AND
 *   - the global attempt cap is not yet spent, AND
 *   - the run's cumulative retry value is under GUARDRAILS ceiling.
 * Everything else is a link, an instrument request, or a human escalation —
 * real actions, but no automated debit.
 *
 * This file must never read `_truth`.
 */

const {
  ACTION,
  ROOT_CAUSE,
  RECOVERY_POLICY,
  GUARDRAILS,
} = require('../config/taxonomy');

const VALID_ACTIONS = new Set(Object.values(ACTION));

/**
 * @param {string} rootCause  a ROOT_CAUSE value (from the classifier)
 * @param {object} [context]
 * @param {number} [context.attemptCount=0]           retries already spent on this txn
 * @param {number} [context.customerMessagesToday=0]  messages already sent to this customer today
 * @param {number} [context.retryValueSoFar=0]        cumulative paise already queued for retry this run
 * @param {number} [context.amount=0]                 this txn's amount in paise
 * @param {number} [context.retryValueCeiling=Infinity]  absolute paise ceiling for
 *        auto-retry value this run (computed by the runner from
 *        GUARDRAILS.MAX_RETRY_VALUE_FRACTION_OF_BATCH, or a --cap-value override)
 * @returns {{
 *   root_cause: string,
 *   action: string,
 *   execute: boolean,          // will an automated retry (money movement) fire now?
 *   notify: boolean,           // will a customer message be generated?
 *   attempt_number: number,    // 1-based, the attempt this decision represents
 *   max_attempts: number,      // effective cap (min of policy + global)
 *   auto_retry_allowed: boolean,
 *   guardrail: string|null,      // the BINDING guardrail (drove the outcome)
 *   guardrails_tripped: string[],// every guardrail that fired, for the audit trail
 *   rationale: string,
 * }}
 */
function decide(rootCause, context = {}) {
  const {
    attemptCount = 0,
    customerMessagesToday = 0,
    retryValueSoFar = 0,
    amount = 0,
    retryValueCeiling = Infinity,
  } = context;

  const policy = RECOVERY_POLICY[rootCause] || RECOVERY_POLICY[ROOT_CAUSE.UNKNOWN];
  const effectiveRootCause = RECOVERY_POLICY[rootCause] ? rootCause : ROOT_CAUSE.UNKNOWN;

  const maxAttempts = Math.min(
    policy.maxAttempts,
    GUARDRAILS.MAX_ATTEMPTS_PER_TRANSACTION
  );
  const attemptNumber = attemptCount + 1;

  const decision = {
    root_cause: effectiveRootCause,
    action: policy.action,
    execute: false,
    notify: false,
    attempt_number: attemptNumber,
    max_attempts: maxAttempts,
    auto_retry_allowed: !!policy.autoRetry,
    guardrail: null,
    guardrails_tripped: [],
    rationale: policy.rationale,
  };

  // Record a guardrail trip. The FIRST one to change the outcome is the
  // binding one; the rest are still logged so the audit trail shows every
  // rail that fired, not just whichever happened to bind first.
  const trip = (name, binding = true) => {
    if (!decision.guardrails_tripped.includes(name)) {
      decision.guardrails_tripped.push(name);
    }
    if (binding && !decision.guardrail) decision.guardrail = name;
  };

  // --- Guardrail 1: hard "never auto-retry" list. Absolute. -------------------
  if (GUARDRAILS.NEVER_AUTO_RETRY.includes(effectiveRootCause)) {
    decision.action = ACTION.ESCALATE_HUMAN;
    decision.execute = false;
    decision.notify = false;
    trip('NEVER_AUTO_RETRY');
    decision.rationale =
      `SAFETY RAIL: ${effectiveRootCause} may never be auto-retried. ` +
      'Routed to human review / exception list.';
    return finalise(decision);
  }

  // --- Notification decision (independent of retry) --------------------------
  if (policy.notify) {
    if (customerMessagesToday >= GUARDRAILS.MAX_MESSAGES_PER_CUSTOMER_PER_DAY) {
      decision.notify = false;
      // Suppressing a message does not by itself change the retry outcome,
      // so this claims the binding slot only if no other rail fires.
      trip('MESSAGE_CAP', false);
    } else {
      decision.notify = true;
    }
  }

  // --- Policy says no automated debit for this cause ------------------------
  // (mandate re-auth, auth drop-off, dead instrument). The action still stands;
  // it just isn't a retry.
  if (!policy.autoRetry) {
    decision.execute = false;
    return finalise(decision);
  }

  // --- Guardrail 2: attempt caps ------------------------------------------
  if (attemptNumber > maxAttempts) {
    decision.action = ACTION.ESCALATE_HUMAN;
    decision.execute = false;
    trip('MAX_ATTEMPTS');
    decision.rationale =
      `Attempt cap reached (${attemptCount}/${maxAttempts}). Stopping automated retries; ` +
      'routed to human review / exception list.';
    return finalise(decision);
  }

  // --- Guardrail 3: cumulative retry-value ceiling for the run ------------
  // Prevents a runaway agent from retrying an entire batch at once. The
  // ceiling is relative to batch size (see GUARDRAILS.MAX_RETRY_VALUE_FRACTION
  // _OF_BATCH) and is computed by the runner, then passed in here.
  if (retryValueSoFar + amount > retryValueCeiling) {
    decision.execute = false;
    trip('RETRY_VALUE_CAP');
    decision.rationale =
      `Run retry-value ceiling (${retryValueCeiling} paise) would be exceeded ` +
      `(${retryValueSoFar} already queued + ${amount} this txn). ` +
      'Retry deferred; routed to exception list.';
    return finalise(decision);
  }

  // --- Cleared every guardrail: the retry fires --------------------------
  decision.execute = true;
  return finalise(decision);
}

function finalise(decision) {
  if (!VALID_ACTIONS.has(decision.action)) {
    throw new Error(
      `executor produced an action outside taxonomy.ACTION: "${decision.action}"`
    );
  }
  // No outcome-changing rail fired, but something tripped (e.g. message cap
  // alone) -- surface it rather than reporting "no guardrail".
  if (!decision.guardrail && decision.guardrails_tripped.length > 0) {
    [decision.guardrail] = decision.guardrails_tripped;
  }
  return decision;
}

module.exports = { decide };
