/**
 * SYNTHETIC FAILED-TRANSACTION GENERATOR
 * --------------------------------------
 * Produces a realistic batch of failed Razorpay-style payments.
 *
 * Two design decisions worth defending in the pitch:
 *
 * 1. HIDDEN GROUND TRUTH.
 *    Every transaction carries a `_truth` block the agent never reads.
 *    It decides whether a retry would ACTUALLY have succeeded. Without
 *    this, "money recovered" is self-fulfilling -- you retry everything
 *    and declare victory. With it, the number is earned.
 *
 * 2. DELIBERATE UNMAPPED CODES.
 *    ~5% of records carry decline codes absent from the taxonomy. These
 *    exist so the LLM diagnosis layer has real work to do. If every code
 *    were mappable, the honest answer would be "don't use an LLM at all".
 */

const { ROOT_CAUSE } = require('../config/taxonomy');

// --- deterministic RNG so batches are reproducible for the demo ---
let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function randInt(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

/**
 * Failure mix. Proportions matter: a panel that knows payments will
 * immediately spot an unrealistic distribution. Insufficient funds
 * dominates; risk blocks are rare.
 */
const FAILURE_MIX = [
  { weight: 0.34, cause: ROOT_CAUSE.INSUFFICIENT_FUNDS,
    codes: ['INSUFFICIENT_FUNDS', 'U69', 'NOT_SUFFICIENT_FUNDS'],
    methods: ['upi', 'card', 'netbanking'] },

  { weight: 0.15, cause: ROOT_CAUSE.UPI_TIMEOUT,
    codes: ['UPI_COLLECT_EXPIRED', 'PAYMENT_TIMED_OUT', 'ZM'],
    methods: ['upi'] },

  { weight: 0.13, cause: ROOT_CAUSE.BANK_DOWNTIME,
    codes: ['BANK_DOWNTIME', 'ISSUER_UNAVAILABLE', 'U30', 'BT'],
    methods: ['upi', 'netbanking', 'card'] },

  { weight: 0.12, cause: ROOT_CAUSE.AUTH_ABANDONED,
    codes: ['3DS_AUTH_FAILED', 'OTP_NOT_ENTERED', 'AUTHENTICATION_FAILED'],
    methods: ['card'] },

  { weight: 0.09, cause: ROOT_CAUSE.MANDATE_INVALID,
    codes: ['MANDATE_REVOKED', 'MANDATE_EXPIRED', 'MANDATE_NOT_FOUND'],
    methods: ['mandate'] },

  { weight: 0.06, cause: ROOT_CAUSE.CARD_EXPIRED,
    codes: ['CARD_EXPIRED', 'EXPIRED_CARD'],
    methods: ['card'] },

  { weight: 0.05, cause: ROOT_CAUSE.INVALID_INSTRUMENT,
    codes: ['INVALID_VPA', 'ACCOUNT_CLOSED', 'INVALID_CARD_NUMBER'],
    methods: ['upi', 'card'] },

  { weight: 0.03, cause: ROOT_CAUSE.RISK_BLOCKED,
    codes: ['RISK_BLOCKED', 'SUSPECTED_FRAUD'],
    methods: ['card', 'netbanking'] },

  // Unmapped on purpose -> forces the LLM path
  { weight: 0.03, cause: ROOT_CAUSE.INSUFFICIENT_FUNDS,
    codes: ['ERR_BAL_LOW_RETRY_LATER', 'DEBIT_FAILED_ACCT_BAL'],
    methods: ['upi'], unmapped: true },
];

/**
 * Probability a retry actually succeeds, per true cause.
 * This is the hidden truth the agent is scored against.
 */
const TRUE_RECOVERABILITY = {
  [ROOT_CAUSE.INSUFFICIENT_FUNDS]: 0.42, // often recovers after a credit event
  [ROOT_CAUSE.UPI_TIMEOUT]: 0.61,        // intent was there; highest recovery
  [ROOT_CAUSE.BANK_DOWNTIME]: 0.55,      // recovers once the outage clears
  [ROOT_CAUSE.AUTH_ABANDONED]: 0.28,     // needs the customer to come back
  [ROOT_CAUSE.MANDATE_INVALID]: 0.19,    // requires re-authorisation
  [ROOT_CAUSE.CARD_EXPIRED]: 0.11,       // needs a new instrument
  [ROOT_CAUSE.INVALID_INSTRUMENT]: 0.04, // essentially dead
  [ROOT_CAUSE.RISK_BLOCKED]: 0.0,        // must never be auto-recovered
};

const BANKS = ['HDFC', 'ICICI', 'SBI', 'Axis', 'Kotak', 'PNB', 'BoB', 'Yes'];
const VPA_HANDLES = ['@okhdfcbank', '@ybl', '@paytm', '@okaxis', '@ibl'];

/** Bank downtime clusters in windows -- realistic, and useful for the agent. */
function inDowntimeWindow(date) {
  const h = date.getHours();
  return (h >= 1 && h < 4) || (h >= 23);
}

/** Amounts: long tail, most transactions small. */
function generateAmount() {
  const r = rand();
  if (r < 0.55) return randInt(99, 999) * 100;      // paise
  if (r < 0.85) return randInt(1000, 4999) * 100;
  if (r < 0.97) return randInt(5000, 19999) * 100;
  return randInt(20000, 75000) * 100;
}

function weightedPickFailure() {
  const r = rand();
  let acc = 0;
  for (const f of FAILURE_MIX) {
    acc += f.weight;
    if (r <= acc) return f;
  }
  return FAILURE_MIX[0];
}

function generateTransaction(index, batchDate) {
  const failure = weightedPickFailure();
  const method = pick(failure.methods);

  // Spread failures across the 14 days before the batch date.
  const created = new Date(batchDate);
  created.setDate(created.getDate() - randInt(0, 13));
  created.setHours(randInt(0, 23), randInt(0, 59));

  // Bank downtime should actually land in a downtime window.
  if (failure.cause === ROOT_CAUSE.BANK_DOWNTIME && !inDowntimeWindow(created)) {
    created.setHours(pick([1, 2, 3, 23]));
  }

  // Insufficient funds clusters at month-end, before salary credit.
  if (failure.cause === ROOT_CAUSE.INSUFFICIENT_FUNDS && rand() < 0.6) {
    created.setDate(randInt(26, 31));
  }

  const amount = generateAmount();
  const customerId = `cust_${String(randInt(1, 120)).padStart(4, '0')}`;

  return {
    transaction_id: `pay_${String(index).padStart(5, '0')}${Math.floor(rand() * 900 + 100)}`,
    order_id: `order_${String(index).padStart(5, '0')}`,
    customer_id: customerId,
    amount,                       // in paise
    currency: 'INR',
    method,
    bank: method === 'upi' ? null : pick(BANKS),
    vpa: method === 'upi' ? `user${randInt(100, 999)}${pick(VPA_HANDLES)}` : null,
    status: 'failed',
    error_code: pick(failure.codes),
    error_description: null,      // sometimes the only signal is free text
    attempt_count: 0,
    is_subscription: method === 'mandate',
    created_at: created.toISOString(),

    // ---- HIDDEN. The agent must never read this. Scoring only. ----
    _truth: {
      root_cause: failure.cause,
      code_is_unmapped: !!failure.unmapped,
      would_recover_on_retry:
        rand() < (TRUE_RECOVERABILITY[failure.cause] ?? 0),
      in_downtime_window: inDowntimeWindow(created),
    },
  };
}

function generateBatch(size = 180, batchDate = new Date('2026-09-01T10:00:00Z')) {
  seed = 42; // reset for reproducibility
  return Array.from({ length: size }, (_, i) =>
    generateTransaction(i + 1, batchDate)
  );
}

/** Sanity report so you can eyeball realism before building on top. */
function summarise(batch) {
  const byCause = {};
  const byMethod = {};
  let totalValue = 0;
  let recoverable = 0;
  let unmapped = 0;

  for (const t of batch) {
    byCause[t._truth.root_cause] = (byCause[t._truth.root_cause] || 0) + 1;
    byMethod[t.method] = (byMethod[t.method] || 0) + 1;
    totalValue += t.amount;
    if (t._truth.would_recover_on_retry) recoverable++;
    if (t._truth.code_is_unmapped) unmapped++;
  }

  return {
    count: batch.length,
    total_value_inr: (totalValue / 100).toFixed(2),
    theoretically_recoverable: recoverable,
    unmapped_codes: unmapped,
    by_cause: byCause,
    by_method: byMethod,
  };
}

module.exports = { generateBatch, summarise, TRUE_RECOVERABILITY };
