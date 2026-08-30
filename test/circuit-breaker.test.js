/**
 * CIRCUIT BREAKER TESTS
 * ---------------------
 * The breaker is what stops one bad key from becoming 180 sequential
 * timeouts mid-demo. These prove it opens, and that opening is a safe
 * outcome rather than a crash.
 *
 * `fetch` is stubbed, so the suite never touches the network and needs no
 * key. That also makes the failure modes deterministic — a real bad key
 * would depend on Google returning the error we expect.
 */

const test = require('node:test');
const assert = require('node:assert');

const { LlmDiagnoser, MAX_CONSECUTIVE_FAILURES } = require('../src/lib/llm');

const realFetch = globalThis.fetch;

/** Stub returning a fixed HTTP status. 400 is non-retryable, so it fails fast. */
function stubStatus(status, body = '{"error":"stubbed"}') {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  return () => calls;
}

function stubOk(text) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
      text: async () => text,
    };
  };
  return () => calls;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

function diagnoser() {
  process.env.GEMINI_API_KEY = 'test-key-not-real';
  const d = new LlmDiagnoser();
  assert.equal(d.enabled, true, 'diagnoser should be enabled with a key present');
  return d;
}

test('breaker opens after 3 consecutive failures and stops calling the provider', async () => {
  const callCount = stubStatus(400);
  const d = diagnoser();

  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
    const r = await d.diagnose('SOME_UNMAPPED_CODE', {});
    assert.equal(r.root_cause, null);
    assert.equal(r.source, 'llm_error');
  }

  assert.equal(d.breakerOpen, true, 'breaker did not open after 3 failures');
  const callsAtOpen = callCount();

  // Every later call must short-circuit without touching the network.
  for (let i = 0; i < 5; i += 1) {
    const r = await d.diagnose('SOME_UNMAPPED_CODE', {});
    assert.equal(r.source, 'llm_circuit_open');
    assert.equal(r.root_cause, null);
  }

  assert.equal(callCount(), callsAtOpen, 'provider was called after the breaker opened');
  assert.equal(d.stats.short_circuited, 5);
});

test('an open breaker degrades to UNKNOWN rather than throwing', async () => {
  stubStatus(400);
  const d = diagnoser();
  for (let i = 0; i < 10; i += 1) {
    const r = await d.diagnose('SOME_UNMAPPED_CODE', {});
    assert.equal(r.root_cause, null, 'a failed diagnosis must not invent a cause');
  }
  assert.equal(d.stats.breaker_open, true);
});

test('transient 503s are retried before counting as a failure', async () => {
  const callCount = stubStatus(503);
  const d = diagnoser();

  await d.diagnose('SOME_UNMAPPED_CODE', {});

  // One logical failure, but more than one HTTP attempt: free-tier capacity
  // spikes must not trip the breaker on the first blip.
  assert.equal(d.stats.failed, 1);
  assert.ok(callCount() > 1, `503 was not retried (${callCount()} attempt)`);
  assert.equal(d.breakerOpen, false, 'breaker opened on a single transient failure');
});

test('a permanent 400 is not retried — it never self-heals', async () => {
  const callCount = stubStatus(400);
  const d = diagnoser();
  await d.diagnose('SOME_UNMAPPED_CODE', {});
  assert.equal(callCount(), 1, `400 was retried ${callCount()} times`);
});

test('an off-list answer is discarded rather than trusted', async () => {
  stubOk('DEFINITELY_NOT_A_ROOT_CAUSE');
  const d = diagnoser();
  const r = await d.diagnose('SOME_UNMAPPED_CODE', {});
  assert.equal(r.root_cause, null, 'the model invented a cause and it was accepted');
  assert.equal(r.source, 'llm_inconclusive');
});

test('a valid in-enum answer is accepted', async () => {
  stubOk('INSUFFICIENT_FUNDS');
  const d = diagnoser();
  const r = await d.diagnose('ERR_BAL_LOW_RETRY_LATER', { method: 'upi' });
  assert.equal(r.root_cause, 'INSUFFICIENT_FUNDS');
  assert.equal(r.source, 'llm');
});

test('with no key the diagnoser is disabled and never calls out', async () => {
  const callCount = stubStatus(500);
  delete process.env.GEMINI_API_KEY;
  const d = new LlmDiagnoser();
  assert.equal(d.enabled, false);

  const r = await d.diagnose('SOME_UNMAPPED_CODE', {});
  assert.equal(r.source, 'llm_skipped');
  assert.equal(r.root_cause, null);
  assert.equal(callCount(), 0, 'a call was made without a key');
});
