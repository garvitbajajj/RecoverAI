/**
 * GROUND-TRUTH CONTAINMENT TEST
 * -----------------------------
 * Wires scripts/verify-truth-containment.js into the suite, so the claim the
 * whole recovery metric rests on is enforced by `npm test` rather than by
 * discipline.
 *
 * If a future change lets the classifier, executor or metrics engine read
 * `_truth`, the agent could grade its own homework and every number in the
 * report becomes meaningless. This fails the build instead.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('_truth is read only by the generator and the scorer', () => {
  let out;
  try {
    out = execFileSync('node', ['scripts/verify-truth-containment.js'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch (err) {
    assert.fail(
      'containment check failed — a file outside the scorer reads _truth:\n' +
        (err.stdout || '') +
        (err.stderr || '')
    );
  }
  assert.match(out, /PASSED/);
  assert.match(out, /simulator\.js/);
});

test('the agent decision path does not import the simulator', () => {
  // Containment by file-read is necessary but not sufficient: pulling in the
  // scorer would give the decision path an indirect route to the truth.
  const fs = require('node:fs');
  const decisionPath = [
    'src/lib/classifier.js',
    'src/lib/executor.js',
    'src/lib/actions.js',
    'src/lib/llm.js',
    'src/lib/metrics.js',
  ];
  for (const rel of decisionPath) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(
      !/require\(['"].*simulator['"]\)/.test(src),
      `${rel} imports the simulator, which reads _truth`
    );
  }
});
