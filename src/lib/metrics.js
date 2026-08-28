/**
 * METRICS ENGINE  (Stage 4 — Report)
 * ----------------------------------
 * Accumulates the run and produces the numbers the pitch is built on:
 * money recovered, recovery rate per root cause, guardrail activity, and an
 * honest exception list.
 *
 * Design note: this engine records EXCEPTIONS as first-class output, not as
 * leftovers. A recovery agent that reports only its wins is not trustworthy.
 * Every transaction the agent could not recover leaves here with a reason.
 *
 * This file must never read `_truth`. It is handed outcomes, not truth.
 */

class Metrics {
  constructor() {
    this.records = 0;
    this.retries_attempted = 0;
    this.recovered_count = 0;
    this.recovered_value = 0;
    this.messages_sent = 0;
    this.links_issued = 0;
    this.escalated = 0;

    this.byCause = {};       // cause -> { seen, retried, recovered, value, at_risk }
    this.byAction = {};      // action -> count
    this.byGuardrail = {};   // guardrail -> count (all trips, not just binding)
    this.stoppedAtCap = 0;   // txns that exhausted their attempt budget
    this.exceptions = [];
  }

  _cause(c) {
    if (!this.byCause[c]) {
      this.byCause[c] = { seen: 0, retried: 0, recovered: 0, value: 0, at_risk: 0 };
    }
    return this.byCause[c];
  }

  /** Called once per transaction, after diagnosis. */
  seen(txn, rootCause) {
    this.records += 1;
    const c = this._cause(rootCause);
    c.seen += 1;
    c.at_risk += txn.amount || 0;
  }

  /** Called for every action selected, on every attempt. */
  action(name) {
    this.byAction[name] = (this.byAction[name] || 0) + 1;
  }

  /**
   * Called for every guardrail trip. Counts ALL trips independently, so a
   * message cap and a value cap on the same transaction both register --
   * the Day 2 report only counted whichever one happened to bind first,
   * which under-reported the message cap.
   */
  guardrail(name) {
    if (!name) return;
    this.byGuardrail[name] = (this.byGuardrail[name] || 0) + 1;
  }

  message() {
    this.messages_sent += 1;
  }

  link() {
    this.links_issued += 1;
  }

  escalation() {
    this.escalated += 1;
  }

  /** Called for every automated retry attempt fired. */
  retry(txn, rootCause, recovered) {
    this.retries_attempted += 1;
    const c = this._cause(rootCause);
    c.retried += 1;
    if (recovered) {
      this.recovered_count += 1;
      this.recovered_value += txn.amount || 0;
      c.recovered += 1;
      c.value += txn.amount || 0;
    }
  }

  attemptsExhausted() {
    this.stoppedAtCap += 1;
  }

  /** Every transaction the agent did not recover leaves through here. */
  exception(txn, reason, rootCause, detail) {
    this.exceptions.push({
      transaction_id: txn.transaction_id,
      customer_id: txn.customer_id,
      amount: txn.amount,
      root_cause: rootCause,
      reason,
      detail: detail || null,
    });
  }

  /** Group the exception list by reason, largest exposure first. */
  exceptionsByReason() {
    const g = {};
    for (const e of this.exceptions) {
      if (!g[e.reason]) g[e.reason] = { count: 0, value: 0 };
      g[e.reason].count += 1;
      g[e.reason].value += e.amount || 0;
    }
    return Object.entries(g).sort((a, b) => b[1].value - a[1].value);
  }

  /** Recovery rate per cause, sorted by money recovered. */
  causeTable() {
    return Object.entries(this.byCause)
      .map(([cause, s]) => ({
        cause,
        seen: s.seen,
        retried: s.retried,
        recovered: s.recovered,
        value: s.value,
        at_risk: s.at_risk,
        rate: s.retried ? s.recovered / s.retried : null,
      }))
      .sort((a, b) => b.value - a.value);
  }
}

module.exports = { Metrics };
