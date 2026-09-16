/**
 * LLM DIAGNOSIS ENDPOINT  (Vercel serverless function)
 * ----------------------------------------------------
 * The only server-side piece. The dashboard panel runs the rules client-side;
 * this exists solely because the model needs GEMINI_API_KEY, and that key must
 * never reach the browser.
 *
 * It reuses src/lib/llm.js unchanged — the same LlmDiagnoser the batch agent
 * uses, with the same enum allowlist, the same circuit breaker, and the same
 * rule that an unusable answer leaves the code UNKNOWN. A second, endpoint-only
 * implementation would be a second thing to keep honest.
 *
 * This is a public endpoint that spends money, so it is deliberately unfriendly:
 * POST only, tiny body cap, short code cap, and a per-IP rate limit.
 *
 * On the rate limiter: it is an in-memory map, which on serverless means
 * per-instance and best-effort, NOT a global guarantee — a burst spread across
 * cold starts can exceed it. It is a brake on casual abuse, not a security
 * control. A real one needs shared state (Vercel KV, Redis), which would mean a
 * dependency, and the zero-dependency property is deliberate. The honest
 * backstop is the model itself: the batch job's usage is bounded, and Google's
 * free tier fails closed rather than billing.
 */

const { LlmDiagnoser } = require('../src/lib/llm');
const { ROOT_CAUSE } = require('../src/config/taxonomy');

const MAX_BODY_BYTES = 2048;
const MAX_CODE_LENGTH = 64;
const RATE_LIMIT = 12; // requests per IP per window
const RATE_WINDOW_MS = 60_000;

/** ip -> timestamps[]. Per-instance; see the note above. */
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);

  // Keep the map from growing without bound on a long-lived instance.
  if (hits.size > 500) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] > RATE_WINDOW_MS) hits.delete(k);
    }
  }
  return recent.length > RATE_LIMIT;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

/** Vercel usually parses JSON for us; fall back to reading the stream. */
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) throw new Error('body too large');
    return JSON.parse(req.body);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Every non-success path returns the SAME shape and the same meaning: no
 * diagnosis, the code stays UNKNOWN, a human takes it. That is the agent's
 * normal behaviour without a model, not an error state.
 */
function escalate(res, status, reason) {
  return res.status(status).json({
    root_cause: null,
    source: 'escalated',
    reason,
    fallback: ROOT_CAUSE.UNKNOWN,
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return escalate(res, 405, 'This endpoint accepts POST only.');
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return escalate(res, 413, 'Request body too large.');
  }

  if (rateLimited(clientIp(req))) {
    res.setHeader('retry-after', '60');
    return escalate(res, 429, 'Rate limit reached for this IP. The code stays UNKNOWN and escalates.');
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return escalate(res, 400, 'Could not read the request body: ' + err.message);
  }

  const errorCode = typeof body.error_code === 'string' ? body.error_code.trim() : '';
  if (!errorCode) {
    return escalate(res, 400, 'error_code is required.');
  }
  if (errorCode.length > MAX_CODE_LENGTH) {
    return escalate(res, 400, 'error_code is longer than ' + MAX_CODE_LENGTH + ' characters.');
  }

  if (!process.env.GEMINI_API_KEY) {
    return escalate(
      res,
      200,
      'No model is configured on this deployment, so the code stays UNKNOWN and escalates to a human — exactly what the agent does with no key.'
    );
  }

  try {
    const diagnoser = new LlmDiagnoser();
    const result = await diagnoser.diagnose(errorCode, {
      method: typeof body.method === 'string' ? body.method.slice(0, 32) : undefined,
      is_subscription: body.is_subscription === true,
    });

    // LlmDiagnoser already discards anything outside the root-cause enum, but
    // this endpoint is the public surface, so the allowlist is asserted here
    // too rather than trusted across a module boundary.
    if (!result.root_cause || !Object.values(ROOT_CAUSE).includes(result.root_cause)) {
      return escalate(res, 200, result.reason || 'The model returned no usable root cause.');
    }

    return res.status(200).json({
      root_cause: result.root_cause,
      source: result.source,
      reason: result.reason,
    });
  } catch (err) {
    // Never leak internals from a public endpoint.
    return escalate(res, 200, 'The model call failed. The code stays UNKNOWN and escalates to a human.');
  }
};
