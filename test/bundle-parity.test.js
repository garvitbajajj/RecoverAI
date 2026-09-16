/**
 * BUNDLE PARITY TESTS
 * -------------------
 * The interactive panel runs the rules client-side. These assert that the
 * browser bundle and the Node modules return IDENTICAL decisions.
 *
 * Why this test carries weight: the panel's only claim to being trustworthy is
 * that it executes the same source the batch agent does. If the bundle ever
 * diverges -- a build change, a module that stops being browser-safe, a
 * well-meaning hand-edit -- the panel would keep producing confident, wrong
 * answers and nothing else in the suite would notice. This is what makes the
 * "inline from src/, never copy" rule enforceable rather than aspirational.
 *
 * The bundle is evaluated in a vm context with no `require` and no Node
 * globals, which also proves the four modules really are browser-safe.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');

const { buildModuleBundle } = require('../src/dashboard/bundle');
const nodeClassifier = require('../src/lib/classifier');
const nodeExecutor = require('../src/lib/executor');
const { ROOT_CAUSE } = require('../src/config/taxonomy');

/** Evaluate the bundle the way a browser would: no require, no module, no fs. */
function loadBundle() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(buildModuleBundle(), context);
  return context.RecoverAI;
}

const browser = loadBundle();

/**
 * Fixed inputs. Deliberately spans every guardrail path, both never-retry
 * families, and an unmapped code -- the case the panel hands to the model.
 */
const CASES = [
  { label: 'mapped: NPCI insufficient balance', error_code: 'U69', method: 'upi' },
  { label: 'mapped: plain insufficient funds', error_code: 'INSUFFICIENT_FUNDS', method: 'card' },
  { label: 'mapped: bank downtime', error_code: 'BT', method: 'netbanking' },
  { label: 'mapped: UPI collect expired', error_code: 'UPI_COLLECT_EXPIRED', method: 'upi' },
  { label: 'mapped: 3DS abandoned', error_code: '3DS_AUTH_FAILED', method: 'card' },
  { label: 'mapped: mandate revoked', error_code: 'MANDATE_REVOKED', method: 'mandate' },
  { label: 'mapped: dead card', error_code: 'CARD_EXPIRED', method: 'card' },
  { label: 'mapped: invalid VPA', error_code: 'INVALID_VPA', method: 'upi' },
  { label: 'mapped: risk block', error_code: 'SUSPECTED_FRAUD', method: 'card' },
  { label: 'UNMAPPED: gateway variant', error_code: 'ERR_BAL_LOW_RETRY_LATER', method: 'upi' },
  { label: 'UNMAPPED: bank error string', error_code: 'DEBIT_FAILED_ACCT_BAL', method: 'upi' },
  { label: 'UNMAPPED: never-before-seen', error_code: 'SOME_BRAND_NEW_CODE', method: 'card' },
  { label: 'no error code at all', error_code: null, method: 'card' },
];

/** Contexts that exercise each guardrail branch in decide(). */
const CONTEXTS = [
  { label: 'fresh', attemptCount: 0, customerMessagesToday: 0, retryValueSoFar: 0, amount: 50000, retryValueCeiling: Infinity },
  { label: 'at attempt cap', attemptCount: 3, customerMessagesToday: 0, retryValueSoFar: 0, amount: 50000, retryValueCeiling: Infinity },
  { label: 'message cap hit', attemptCount: 0, customerMessagesToday: 5, retryValueSoFar: 0, amount: 50000, retryValueCeiling: Infinity },
  { label: 'value ceiling crossed', attemptCount: 0, customerMessagesToday: 0, retryValueSoFar: 99000, amount: 50000, retryValueCeiling: 100000 },
  { label: 'mid-attempt', attemptCount: 1, customerMessagesToday: 1, retryValueSoFar: 1000, amount: 999900, retryValueCeiling: 5000000 },
];

test('the bundle exposes the same surface the agent uses', () => {
  assert.equal(typeof browser.classify, 'function');
  assert.equal(typeof browser.decide, 'function');
  assert.equal(typeof browser.dispatch, 'function');
  assert.deepEqual(browser.taxonomy.ROOT_CAUSE, ROOT_CAUSE, 'taxonomy drifted between bundle and source');
});

test('classify() is identical in the browser bundle and in Node', () => {
  for (const c of CASES) {
    const txn = { error_code: c.error_code, method: c.method };
    assert.deepEqual(
      browser.classify(txn),
      nodeClassifier.classify(txn),
      `classify() diverged for ${c.label} (${c.error_code})`
    );
  }
});

test('decide() is identical in the browser bundle and in Node, across every guardrail path', () => {
  for (const c of CASES) {
    const cause = nodeClassifier.classify({ error_code: c.error_code }).root_cause;
    for (const ctx of CONTEXTS) {
      assert.deepEqual(
        browser.decide(cause, ctx),
        nodeExecutor.decide(cause, ctx),
        `decide() diverged for ${c.label} / ${ctx.label}`
      );
    }
  }
});

test('unmapped codes resolve to UNKNOWN in the bundle, exactly as in Node', () => {
  // The panel routes on `mapped:false` to offer the model. If the bundle ever
  // reported these as mapped, the LLM path would silently stop being offered.
  for (const code of ['ERR_BAL_LOW_RETRY_LATER', 'DEBIT_FAILED_ACCT_BAL', 'SOME_BRAND_NEW_CODE']) {
    const b = browser.classify({ error_code: code });
    assert.equal(b.mapped, false, `${code} reported as mapped in the bundle`);
    assert.equal(b.root_cause, ROOT_CAUSE.UNKNOWN);
    assert.deepEqual(b, nodeClassifier.classify({ error_code: code }));
  }
});

test('every mapped decline code in the taxonomy agrees across both', () => {
  // Not a sample: the whole table. This is the assertion that actually fails
  // when someone edits taxonomy.js and forgets the panel exists.
  const codes = Object.keys(browser.taxonomy.DECLINE_CODE_MAP);
  assert.ok(codes.length > 20, `only ${codes.length} codes found; taxonomy not loaded?`);
  for (const code of codes) {
    assert.deepEqual(
      browser.classify({ error_code: code }),
      nodeClassifier.classify({ error_code: code }),
      `classify() diverged for mapped code ${code}`
    );
  }
});

test('the bundle runs with no Node globals present', () => {
  // Proves the four modules are genuinely browser-safe: the vm context has no
  // require, module, process or fs. If one grows a Node dependency, this throws.
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(buildModuleBundle(), context);
  assert.equal(typeof context.RecoverAI.classify, 'function');
  assert.equal(typeof context.require, 'undefined');
  assert.equal(typeof context.process, 'undefined');
});
