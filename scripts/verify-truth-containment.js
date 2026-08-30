/**
 * CONTAINMENT TEST
 * ----------------
 * Asserts that the hidden ground truth is read in exactly the two files
 * allowed to touch it: the generator that writes it, and the scorer that
 * grades against it.
 *
 * This is what makes "money recovered" an earned number. If any file on the
 * agent's decision path -- classifier, executor, actions, llm, metrics --
 * could read `_truth`, the agent could cheat and the metric would mean
 * nothing. Run it and see for yourself:
 *
 *   npm run verify:truth
 */

const fs = require('fs');
const path = require('path');

const ALLOWED = ['src/data/generator.js', 'src/lib/simulator.js'];

/** Strip comments, so "must never read _truth" in a docblock isn't a hit. */
function codeOnly(text) {
  const out = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (inBlock) {
      if (s.includes('*/')) inBlock = false;
      continue;
    }
    if (s.startsWith('/*')) {
      if (!s.includes('*/')) inBlock = true;
      continue;
    }
    if (s.startsWith('//') || s.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (entry.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const readers = [];
const offenders = [];

for (const file of walk('src')) {
  const rel = file.split(path.sep).join('/');
  const hits = codeOnly(fs.readFileSync(file, 'utf8')).filter((l) =>
    /[.['"]_truth/.test(l)
  ).length;
  if (!hits) continue;
  readers.push({ rel, hits });
  if (!ALLOWED.includes(rel)) offenders.push(rel);
}

console.log('\n  GROUND-TRUTH CONTAINMENT');
console.log('  ' + '-'.repeat(52));
for (const r of readers) {
  const tag = ALLOWED.includes(r.rel) ? 'allowed' : 'LEAKED ';
  console.log(`  ${tag}  ${r.rel.padEnd(28)} ${r.hits} reads`);
}

if (offenders.length) {
  console.error(
    `\n  FAILED: ${offenders.length} file(s) outside the scorer read _truth.` +
      '\n  The recovery metric cannot be trusted while this is true.\n'
  );
  process.exit(1);
}

console.log(
  '\n  PASSED: _truth is read only by the generator that writes it and the\n' +
    '  scorer that grades against it. The agent decides blind.\n'
);
