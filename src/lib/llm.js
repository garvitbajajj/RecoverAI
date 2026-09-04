/**
 * LLM DIAGNOSIS FALLBACK  (Stage 2, narrow path)
 * ----------------------------------------------
 * The ONLY place a language model is allowed to run.
 *
 * It sees a decline code exactly when the rules cannot decide — a code absent
 * from the taxonomy. On the shipped batch that is 5 records out of 180. Every
 * other code is resolved by lookup, because routing an unambiguous code
 * through a model would add latency, cost and a failure mode for no gain.
 *
 * THREE THINGS MAKE THIS SAFE TO ADD:
 *
 * 1. The output is constrained to the existing root-cause enum. Anything the
 *    model returns that is not on the list is discarded. It cannot invent a
 *    cause, and it cannot pick an action — the executor still decides that,
 *    under the same guardrails as every rules-diagnosed transaction.
 *
 * 2. A circuit breaker. After MAX_CONSECUTIVE_FAILURES the breaker opens and
 *    every later call short-circuits without touching the network, so one bad
 *    key or a rate limit cannot turn into 180 slow timeouts mid-demo.
 *
 * 3. The fallback is a correct outcome, not an error path. When the model is
 *    unavailable, unusable or wrong-shaped, the code stays UNKNOWN and
 *    escalates to a human — which is exactly what the agent does today with
 *    no LLM at all. The feature is pure upside: it can add recoveries, and it
 *    can never break the run.
 *
 * Provider-agnostic by design: Gemini is the default because it has a real
 * free tier, but the request shape is isolated in one function.
 *
 * This file must never read `_truth`.
 */

const { ROOT_CAUSE } = require('../config/taxonomy');

const VALID_CAUSES = new Set(Object.values(ROOT_CAUSE));
const DIAGNOSABLE = Object.values(ROOT_CAUSE).filter((c) => c !== ROOT_CAUSE.UNKNOWN);

const MAX_CONSECUTIVE_FAILURES = 3;
const TIMEOUT_MS = 8000;

/**
 * Free-tier Flash models are genuinely oversubscribed and return 503 in
 * bursts. That is transient, so it must not count as a provider failure --
 * tripping the breaker on a spike would throw away recoveries we could have
 * had. Retry those; fail fast on 4xx, which will never fix itself.
 */
const MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [400, 1200];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildPrompt(errorCode, ctx) {
  return `You are triaging a failed Indian digital payment for a merchant's recovery system.

A payment failed with a gateway decline code that is not in our taxonomy.
Classify it into exactly one root cause.

Decline code: ${errorCode}
Payment method: ${ctx.method || 'unknown'}
Subscription/mandate payment: ${ctx.is_subscription ? 'yes' : 'no'}

Allowed root causes (respond with EXACTLY one of these, nothing else):
${DIAGNOSABLE.map((c) => `- ${c}`).join('\n')}

If the code does not clearly indicate one of the above, respond with: UNKNOWN

Respond with the root cause identifier only. No explanation, no punctuation.`;
}

/**
 * Gemini REST call. Isolated so another provider is a one-function swap.
 * Uses native fetch — no SDK, so the repo stays dependency-free.
 */
async function callGemini({ apiKey, model, prompt }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 500 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Keep enough of the body to be diagnosable. A 160-char cut once hid
    // Google's "this model is no longer available, use X instead" guidance
    // mid-sentence and turned a one-line config fix into a hunt.
    const err = new Error(
      `HTTP ${res.status} ${body.replace(/\s+/g, ' ').slice(0, 400)}`
    );
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p?.text || '').join('') : '';
  if (!text) throw new Error('empty response from provider');
  return text;
}

/**
 * Retry transient provider trouble before declaring a failure. Bounded and
 * short: at most two extra attempts, ~1.6s of added latency worst case, on a
 * path that only ever sees a handful of records.
 */
async function callWithRetry(args) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await callGemini(args);
    } catch (err) {
      lastErr = err;
      const transient = err.status === undefined || RETRYABLE_STATUS.has(err.status);
      if (!transient || attempt === MAX_RETRIES) break;
      await sleep(BACKOFF_MS[attempt]);
    }
  }
  throw lastErr;
}

class LlmDiagnoser {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.enabled]  set false for a forced rules-only run
   */
  constructor(opts = {}) {
    this.apiKey = process.env.GEMINI_API_KEY || '';
    // Pinned deliberately. The `gemini-flash-lite-latest` alias resolves to a
    // reasoning model that spends ~7s per call thinking about a nine-item
    // classification -- 64s for a 180-record batch, versus ~10s here. Pinning
    // risks the id being retired for new accounts the way gemini-2.5-flash
    // was, but that degrades safely: a 404 is a permanent error, the breaker
    // opens, and unmapped codes escalate exactly as they do with no key.
    // Override with RECOVERAI_MODEL if this id is ever withdrawn.
    this.model = process.env.RECOVERAI_MODEL || 'gemini-3.1-flash-lite';
    this.provider = 'gemini';

    // Disabled is a normal state, not an error: no key means rules-only.
    this.enabled = opts.enabled !== false && Boolean(this.apiKey);
    this.disabledReason = opts.enabled === false
      ? 'disabled by --no-llm'
      : (this.apiKey ? null : 'no GEMINI_API_KEY in environment');

    this.consecutiveFailures = 0;
    this.breakerOpen = false;
    this.stats = {
      enabled: this.enabled,
      provider: this.provider,
      model: this.model,
      attempted: 0,
      resolved: 0,      // model returned a usable, in-enum cause
      inconclusive: 0,  // model answered UNKNOWN or something off-list
      failed: 0,        // network/HTTP/timeout
      short_circuited: 0,
      breaker_open: false,
      disabled_reason: this.disabledReason,
    };
  }

  /**
   * Diagnose an unmapped decline code.
   * Always resolves — never throws. A null root_cause means "stay UNKNOWN".
   *
   * @returns {{root_cause: string|null, source: string, reason: string}}
   */
  async diagnose(errorCode, ctx = {}) {
    if (!this.enabled) {
      return {
        root_cause: null,
        source: 'llm_skipped',
        reason: `LLM fallback unavailable (${this.disabledReason}). Staying UNKNOWN and escalating.`,
      };
    }

    // Circuit breaker: stop paying the timeout cost once the provider is
    // clearly not answering. Cheap, immediate, and keeps the run's wall time
    // bounded no matter how badly the provider is behaving.
    if (this.breakerOpen) {
      this.stats.short_circuited += 1;
      return {
        root_cause: null,
        source: 'llm_circuit_open',
        reason: `Circuit breaker open after ${MAX_CONSECUTIVE_FAILURES} consecutive provider failures. Not called. Staying UNKNOWN.`,
      };
    }

    this.stats.attempted += 1;

    let raw;
    try {
      raw = await callWithRetry({
        apiKey: this.apiKey,
        model: this.model,
        prompt: buildPrompt(errorCode, ctx),
      });
      this.consecutiveFailures = 0;
    } catch (err) {
      this.stats.failed += 1;
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.breakerOpen = true;
        this.stats.breaker_open = true;
      }
      return {
        root_cause: null,
        source: 'llm_error',
        reason: `Provider call failed (${err.message}). Staying UNKNOWN and escalating.`,
      };
    }

    // Constrain the output to the enum. The model proposes; the taxonomy
    // disposes. An off-list answer is treated as no answer.
    const answer = String(raw).trim().toUpperCase().replace(/[^A-Z_]/g, '');

    if (!VALID_CAUSES.has(answer) || answer === ROOT_CAUSE.UNKNOWN) {
      this.stats.inconclusive += 1;
      return {
        root_cause: null,
        source: 'llm_inconclusive',
        reason: `Model returned "${String(raw).trim().slice(0, 40)}", which is not an actionable root cause. Staying UNKNOWN.`,
      };
    }

    this.stats.resolved += 1;
    return {
      root_cause: answer,
      source: 'llm',
      reason: `Decline code "${errorCode}" is not in the taxonomy. ${this.provider}/${this.model} diagnosed it as ${answer}; the executor applies the same policy and guardrails as any rules-diagnosed cause.`,
    };
  }
}

module.exports = { LlmDiagnoser, MAX_CONSECUTIVE_FAILURES };
