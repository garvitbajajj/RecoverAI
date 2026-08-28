/**
 * FAILURE TAXONOMY
 * ----------------
 * The deterministic backbone of the recovery agent.
 *
 * Design decision (defend this in the pitch):
 * Most payment failures arrive with an unambiguous decline code. Mapping
 * those with a lookup table is faster, cheaper and more reliable than an
 * LLM call. The LLM is reserved for codes NOT in this table -- gateway
 * variants, new bank error strings, free-text failure reasons.
 *
 * Rules first. LLM only where it earns its place.
 */

/** Root causes the agent can diagnose. */
const ROOT_CAUSE = {
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  BANK_DOWNTIME: 'BANK_DOWNTIME',
  UPI_TIMEOUT: 'UPI_TIMEOUT',
  MANDATE_INVALID: 'MANDATE_INVALID',
  AUTH_ABANDONED: 'AUTH_ABANDONED',
  CARD_EXPIRED: 'CARD_EXPIRED',
  INVALID_INSTRUMENT: 'INVALID_INSTRUMENT',
  RISK_BLOCKED: 'RISK_BLOCKED',
  UNKNOWN: 'UNKNOWN',
};

/** Bounded recovery actions. Nothing outside this list may ever execute. */
const ACTION = {
  IMMEDIATE_RETRY: 'IMMEDIATE_RETRY',
  RETRY_AFTER_WINDOW: 'RETRY_AFTER_WINDOW',
  SCHEDULED_RETRY: 'SCHEDULED_RETRY',
  REAUTH_LINK: 'REAUTH_LINK',
  RECOVERY_LINK_ALT_METHOD: 'RECOVERY_LINK_ALT_METHOD',
  UPDATE_INSTRUMENT_REQUEST: 'UPDATE_INSTRUMENT_REQUEST',
  ESCALATE_HUMAN: 'ESCALATE_HUMAN',
  NO_ACTION: 'NO_ACTION',
};

/**
 * DECLINE CODE -> ROOT CAUSE
 * Deterministic. No AI involved. Codes absent here fall through to the
 * LLM diagnosis layer, which is exactly the point.
 */
const DECLINE_CODE_MAP = {
  // --- Balance ---
  INSUFFICIENT_FUNDS: ROOT_CAUSE.INSUFFICIENT_FUNDS,
  NOT_SUFFICIENT_FUNDS: ROOT_CAUSE.INSUFFICIENT_FUNDS,
  U69: ROOT_CAUSE.INSUFFICIENT_FUNDS, // NPCI: insufficient balance

  // --- Issuer / acquirer availability ---
  BANK_DOWNTIME: ROOT_CAUSE.BANK_DOWNTIME,
  ISSUER_UNAVAILABLE: ROOT_CAUSE.BANK_DOWNTIME,
  GATEWAY_ERROR: ROOT_CAUSE.BANK_DOWNTIME,
  U30: ROOT_CAUSE.BANK_DOWNTIME, // NPCI: debit request failed
  BT: ROOT_CAUSE.BANK_DOWNTIME, // NPCI: beneficiary bank timeout

  // --- UPI collect lifecycle ---
  UPI_COLLECT_EXPIRED: ROOT_CAUSE.UPI_TIMEOUT,
  PAYMENT_TIMED_OUT: ROOT_CAUSE.UPI_TIMEOUT,
  ZM: ROOT_CAUSE.UPI_TIMEOUT, // NPCI: MPIN validation timeout

  // --- Subscription mandates ---
  MANDATE_REVOKED: ROOT_CAUSE.MANDATE_INVALID,
  MANDATE_EXPIRED: ROOT_CAUSE.MANDATE_INVALID,
  MANDATE_NOT_FOUND: ROOT_CAUSE.MANDATE_INVALID,

  // --- Authentication drop-off ---
  '3DS_AUTH_FAILED': ROOT_CAUSE.AUTH_ABANDONED,
  AUTHENTICATION_FAILED: ROOT_CAUSE.AUTH_ABANDONED,
  OTP_NOT_ENTERED: ROOT_CAUSE.AUTH_ABANDONED,

  // --- Instrument validity ---
  CARD_EXPIRED: ROOT_CAUSE.CARD_EXPIRED,
  EXPIRED_CARD: ROOT_CAUSE.CARD_EXPIRED,
  INVALID_VPA: ROOT_CAUSE.INVALID_INSTRUMENT,
  INVALID_CARD_NUMBER: ROOT_CAUSE.INVALID_INSTRUMENT,
  ACCOUNT_CLOSED: ROOT_CAUSE.INVALID_INSTRUMENT,

  // --- Risk ---
  RISK_BLOCKED: ROOT_CAUSE.RISK_BLOCKED,
  PAYMENT_BLOCKED_BY_RISK: ROOT_CAUSE.RISK_BLOCKED,
  SUSPECTED_FRAUD: ROOT_CAUSE.RISK_BLOCKED,
};

/**
 * ROOT CAUSE -> RECOVERY POLICY
 *
 * `maxAttempts`  hard stop. Never exceeded, regardless of outcome.
 * `autoRetry`    false means no money movement may be attempted at all.
 * `notify`       whether a customer-facing message is generated.
 * `delayHours`   how long to wait before the retry fires.
 */
const RECOVERY_POLICY = {
  [ROOT_CAUSE.INSUFFICIENT_FUNDS]: {
    action: ACTION.SCHEDULED_RETRY,
    autoRetry: true,
    maxAttempts: 3,
    delayHours: null, // computed dynamically -- see salary-cycle logic
    notify: true,
    rationale:
      'Balance is transient. Retrying near a likely credit event beats retrying immediately.',
  },
  [ROOT_CAUSE.BANK_DOWNTIME]: {
    action: ACTION.RETRY_AFTER_WINDOW,
    autoRetry: true,
    maxAttempts: 3,
    delayHours: 2,
    notify: false, // not the customer's fault; do not alarm them
    rationale: 'Issuer-side outage. Wait for the window to clear, then retry.',
  },
  [ROOT_CAUSE.UPI_TIMEOUT]: {
    action: ACTION.IMMEDIATE_RETRY,
    autoRetry: true,
    maxAttempts: 2,
    delayHours: 0,
    notify: true,
    rationale:
      'Customer intent was present; the collect request simply expired. Re-send fast.',
  },
  [ROOT_CAUSE.MANDATE_INVALID]: {
    action: ACTION.REAUTH_LINK,
    autoRetry: false, // cannot debit without a valid mandate
    maxAttempts: 1,
    delayHours: 0,
    notify: true,
    rationale:
      'No valid authorisation exists. Debiting would be non-compliant. Customer must re-authorise.',
  },
  [ROOT_CAUSE.AUTH_ABANDONED]: {
    action: ACTION.RECOVERY_LINK_ALT_METHOD,
    autoRetry: false, // a silent retry would fail the same way
    maxAttempts: 2,
    delayHours: 1,
    notify: true,
    rationale:
      'Customer dropped at the OTP/3DS step. Offer a link with an easier method (UPI).',
  },
  [ROOT_CAUSE.CARD_EXPIRED]: {
    action: ACTION.UPDATE_INSTRUMENT_REQUEST,
    autoRetry: false,
    maxAttempts: 1,
    delayHours: 0,
    notify: true,
    rationale: 'Instrument is dead. Retrying can never succeed.',
  },
  [ROOT_CAUSE.INVALID_INSTRUMENT]: {
    action: ACTION.UPDATE_INSTRUMENT_REQUEST,
    autoRetry: false,
    maxAttempts: 1,
    delayHours: 0,
    notify: true,
    rationale: 'Destination does not exist. Retrying wastes gateway calls.',
  },
  [ROOT_CAUSE.RISK_BLOCKED]: {
    action: ACTION.ESCALATE_HUMAN,
    autoRetry: false, // SAFETY RAIL: never auto-retry a risk block
    maxAttempts: 0,
    delayHours: null,
    notify: false,
    rationale:
      'SAFETY RAIL. Auto-retrying a risk-blocked payment could push through fraud. Humans only.',
  },
  [ROOT_CAUSE.UNKNOWN]: {
    action: ACTION.ESCALATE_HUMAN,
    autoRetry: false,
    maxAttempts: 0,
    delayHours: null,
    notify: false,
    rationale:
      'Undiagnosed. Acting on an unknown cause is worse than not acting. Goes to the exception list.',
  },
};

/** Global guardrails, enforced above per-cause policy. */
const GUARDRAILS = {
  MAX_ATTEMPTS_PER_TRANSACTION: 3,
  MAX_MESSAGES_PER_CUSTOMER_PER_DAY: 2,

  /**
   * Ceiling on the total value the agent may queue for automated retry in a
   * single run, expressed as a FRACTION of the batch's total at-risk value
   * (the absolute paise figure is computed at run start — see src/index.js).
   *
   * Why a value cap exists at all: the failure mode it guards against is a
   * runaway agent. A bad batch, a regression in the classifier, or a decline
   * code that suddenly all maps to "retry" could make the agent fire retries
   * at the merchant's entire failed-payment volume in one pass — turning a
   * quiet revenue leak into a live gateway incident and a pile of duplicate
   * debits. A relative ceiling lets the agent chase most of a batch but never
   * the whole thing without a human deliberately raising the limit. Set it
   * absolute (a flat paise number) and it either never fires on a small batch
   * or strangles a large one; set it relative and it scales with exposure.
   * Overridable per run via `--cap-value <paise>` so the rail can be
   * demonstrated engaging on demand.
   */
  MAX_RETRY_VALUE_FRACTION_OF_BATCH: 0.6,

  NEVER_AUTO_RETRY: [ROOT_CAUSE.RISK_BLOCKED, ROOT_CAUSE.UNKNOWN],
};

module.exports = {
  ROOT_CAUSE,
  ACTION,
  DECLINE_CODE_MAP,
  RECOVERY_POLICY,
  GUARDRAILS,
};
