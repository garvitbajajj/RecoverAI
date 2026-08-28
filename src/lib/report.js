/**
 * RUN REPORT
 * ----------
 * Serialises a finished run into one plain object. The console printer, the
 * dashboard and any future API all read from this shape, so the numbers can
 * never disagree between surfaces.
 *
 * This file must never read `_truth`. It is handed outcomes, not truth.
 */

function buildReport({ m, ceiling, unreachable, batchAtRisk, config }) {
  const reachable = ceiling.count - unreachable.count;

  return {
    generated_at: new Date().toISOString(),

    config: {
      source: config.source,
      records: m.records,
      batch_at_risk: batchAtRisk,
      retry_value_ceiling: config.retryValueCeiling,
      ceiling_source: config.ceilingSource,
      max_attempts: config.maxAttempts,
    },

    result: {
      retries_attempted: m.retries_attempted,
      recovered_count: m.recovered_count,
      recovered_value: m.recovered_value,
      links_issued: m.links_issued,
      messages_logged: m.messages_sent,
      escalated: m.escalated,
      exceptions: m.exceptions.length,
      stopped_at_cap: m.stoppedAtCap,
    },

    // The honest denominators. Everything the agent claims is measured
    // against these, and the attempt cap's cost is stated rather than hidden.
    ground_truth: {
      recoverable_count: ceiling.count,
      recoverable_value: ceiling.value,
      beyond_cap_count: unreachable.count,
      beyond_cap_value: unreachable.value,
      reachable_count: reachable,
      capture_rate: ceiling.count ? m.recovered_count / ceiling.count : 0,
      value_capture_rate: ceiling.value ? m.recovered_value / ceiling.value : 0,
      reachable_capture_rate: reachable ? m.recovered_count / reachable : 0,
    },

    by_cause: m.causeTable(),
    by_action: Object.entries(m.byAction)
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count),
    guardrails: Object.entries(m.byGuardrail)
      .map(([guardrail, count]) => ({ guardrail, count }))
      .sort((a, b) => b.count - a.count),
    exceptions_by_reason: m.exceptionsByReason().map(([reason, s]) => ({
      reason,
      count: s.count,
      value: s.value,
    })),
    exceptions: m.exceptions,
  };
}

module.exports = { buildReport };
