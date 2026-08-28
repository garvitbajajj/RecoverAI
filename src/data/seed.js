/**
 * Seed script. Generates the batch, writes JSON, prints a realism report.
 *
 * Usage:
 *   node src/data/seed.js            # default 180 records
 *   node src/data/seed.js 250        # custom size
 */

const fs = require('fs');
const path = require('path');
const { generateBatch, summarise } = require('./generator');

const size = parseInt(process.argv[2], 10) || 180;
const batch = generateBatch(size);

const outDir = path.join(__dirname, '../../data');
fs.mkdirSync(outDir, { recursive: true });

const outFile = path.join(outDir, 'failed_transactions.json');
fs.writeFileSync(outFile, JSON.stringify(batch, null, 2));

const report = summarise(batch);

console.log('\n  BATCH GENERATED');
console.log('  ' + '-'.repeat(46));
console.log(`  records                    ${report.count}`);
console.log(`  total value at risk        Rs ${Number(report.total_value_inr).toLocaleString('en-IN')}`);
console.log(`  theoretically recoverable  ${report.theoretically_recoverable} (ceiling for the agent)`);
console.log(`  unmapped decline codes     ${report.unmapped_codes} (these force the LLM path)`);

console.log('\n  TRUE ROOT CAUSE DISTRIBUTION');
console.log('  ' + '-'.repeat(46));
Object.entries(report.by_cause)
  .sort((a, b) => b[1] - a[1])
  .forEach(([cause, n]) => {
    const pct = ((n / report.count) * 100).toFixed(1);
    const bar = '#'.repeat(Math.round(n / 2));
    console.log(`  ${cause.padEnd(20)} ${String(n).padStart(3)}  ${pct.padStart(5)}%  ${bar}`);
  });

console.log('\n  BY METHOD');
console.log('  ' + '-'.repeat(46));
Object.entries(report.by_method)
  .sort((a, b) => b[1] - a[1])
  .forEach(([m, n]) => console.log(`  ${m.padEnd(20)} ${String(n).padStart(3)}`));

console.log(`\n  written to ${path.relative(process.cwd(), outFile)}\n`);
