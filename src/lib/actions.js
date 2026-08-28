/**
 * ACTION DISPATCH  (Stage 3 — Act)
 * --------------------------------
 * The executor DECIDES an action; this module CARRIES IT OUT. Splitting the
 * two keeps the decision logic pure and testable, and means every side effect
 * in the system funnels through one file.
 *
 * Only the three retry actions move money, and they do not move it here --
 * they hand off to the simulator (real Razorpay test-mode calls would slot in
 * at exactly that seam). Everything else produces a link or a message, which
 * we LOG rather than send: real SMS/WhatsApp delivery is explicitly out of
 * scope, and a logged message is auditable while a sent one is not.
 *
 * This file must never read `_truth`.
 */

const { ACTION } = require('../config/taxonomy');

/** Actions that result in an automated debit attempt. */
const MONEY_MOVING = new Set([
  ACTION.IMMEDIATE_RETRY,
  ACTION.RETRY_AFTER_WINDOW,
  ACTION.SCHEDULED_RETRY,
]);

/**
 * Insufficient funds is the one cause where WHEN matters more than WHETHER.
 * Retrying a drained account an hour later fails again; retrying just after a
 * salary credit works. Indian salary credits cluster at month-end / month-start,
 * so a failure late in the month waits for the 1st rather than burning attempts.
 */
function scheduleForCreditEvent(failedAt) {
  const d = new Date(failedAt);
  const day = d.getUTCDate();
  const target = new Date(d);

  if (day >= 25) {
    // Late month: wait for the 1st of next month, ~10:00.
    target.setUTCMonth(target.getUTCMonth() + 1, 1);
    target.setUTCHours(10, 0, 0, 0);
  } else {
    // Mid month: no credit event to wait for. Short 24h hold.
    target.setUTCDate(target.getUTCDate() + 1);
    target.setUTCHours(10, 0, 0, 0);
  }

  const delayHours = Math.max(
    1,
    Math.round((target.getTime() - d.getTime()) / 3_600_000)
  );
  return { scheduledFor: target.toISOString(), delayHours };
}

function recoveryLink(txn, kind) {
  // Deterministic pseudo-link. A real build would mint a Razorpay payment link.
  return `https://pay.example.test/${kind}/${txn.order_id}`;
}

function message(txn, body) {
  return {
    channel: 'sms',
    to_customer: txn.customer_id,
    body,
    delivered: false, // out of scope: we log, we do not send
  };
}

/**
 * Carry out a decided action.
 *
 * @param {object} txn       the transaction
 * @param {object} decision  output of executor.decide()
 * @returns {{
 *   action: string,
 *   moves_money: boolean,      // caller must run the retry simulation
 *   scheduled_for: string|null,
 *   delay_hours: number|null,
 *   link: string|null,
 *   message: object|null,
 *   escalated: boolean,
 *   detail: string,
 * }}
 */
function dispatch(txn, decision) {
  const out = {
    action: decision.action,
    moves_money: false,
    scheduled_for: null,
    delay_hours: null,
    link: null,
    message: null,
    escalated: false,
    detail: '',
  };

  switch (decision.action) {
    case ACTION.IMMEDIATE_RETRY:
      out.moves_money = true;
      out.delay_hours = 0;
      out.detail = 'Re-sent the collect request immediately; customer intent was present.';
      break;

    case ACTION.RETRY_AFTER_WINDOW:
      out.moves_money = true;
      out.delay_hours = 2;
      out.detail = 'Held 2h for the issuer outage window to clear, then retried.';
      break;

    case ACTION.SCHEDULED_RETRY: {
      const { scheduledFor, delayHours } = scheduleForCreditEvent(txn.created_at);
      out.moves_money = true;
      out.scheduled_for = scheduledFor;
      out.delay_hours = delayHours;
      out.detail = `Scheduled to ${scheduledFor} to land after a likely credit event (+${delayHours}h).`;
      break;
    }

    case ACTION.REAUTH_LINK:
      out.link = recoveryLink(txn, 'reauth');
      out.detail = 'Issued a re-authorisation link. No debit attempted: the mandate is invalid.';
      break;

    case ACTION.RECOVERY_LINK_ALT_METHOD:
      out.link = recoveryLink(txn, 'pay');
      out.detail = 'Issued a recovery link offering UPI, bypassing the 3DS/OTP step that was abandoned.';
      break;

    case ACTION.UPDATE_INSTRUMENT_REQUEST:
      out.link = recoveryLink(txn, 'update-instrument');
      out.detail = 'Requested a new payment instrument. The stored one can never succeed.';
      break;

    case ACTION.ESCALATE_HUMAN:
      out.escalated = true;
      out.detail = decision.guardrail
        ? `Escalated to human review (${decision.guardrail}).`
        : 'Escalated to human review.';
      break;

    case ACTION.NO_ACTION:
      out.detail = 'No action taken.';
      break;

    default:
      // executor.finalise() should make this unreachable.
      throw new Error(`dispatch received an unknown action: "${decision.action}"`);
  }

  // Customer-facing message, only where policy allows it and the guardrails
  // did not suppress it. Plain English for now; the Hinglish variant is a
  // separate, deletable module (Day 6 stretch).
  if (decision.notify) {
    const rupees = (txn.amount / 100).toLocaleString('en-IN');
    if (out.link) {
      out.message = message(
        txn,
        `Your payment of Rs ${rupees} could not be completed. Complete it here: ${out.link}`
      );
    } else if (out.moves_money) {
      out.message = message(
        txn,
        `Your payment of Rs ${rupees} failed. We will retry it automatically — no action needed.`
      );
    }
  }

  return out;
}

module.exports = { dispatch, MONEY_MOVING, scheduleForCreditEvent };
