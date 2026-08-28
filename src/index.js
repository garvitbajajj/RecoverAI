/**
 * RECOVERAI — BATCH RUNNER  (Day 2: end-to-end loop, ZERO AI in the path)
 * ---------------------------------------------------------------------
 * Ingest -> Diagnose (rules) -> Decide & Act (rules + guardrails) -> Report.
 *
 *   node src/index.js                        # data/failed_transactions.json
 *   node src/index.js path/to.json           # custom batch file
 *   node src/index.js --cap-value 5000       # force a low retry-value ceiling
 *                                            # (paise) to demo the rail firing
 *
 * No LLM is imported or called anywhere in this loop. The only file that sees
 * the hidden ground truth is src/lib/simulator.js.
 */

const fs = require('fs');
const path = require('path');

const { classify } = require('./lib/classifier');
const { decide } = require('./lib/executor');
const { simulateRetry, recoverableCeiling } = require('./lib/simulator');
const { GUARDRAILS } = require('./config/taxonomy');

const rupees = (paise) =>
  'Rs ' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Parse an optional positional batch path and an optional --cap-value <paise>. */
function parseArgs(argv) {
  const rest = argv.slice(2);
  const out = { batchFile: null, capValue: null };

  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--cap-value' || a.startsWith('--cap-value=')) {
      const raw = a.includes('=') ? a.split('=')[1] : rest[(i += 1)];
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        console.error('\n  --cap-value needs a non-negative number of paise\n');
        process.exit(1);
      }
      out.capValue = Math.round(v);
    } else if (!a.startsWith('--')) {
      out.batchFile = a;
    } else {
      console.error(`\n  unknown flag: ${a}\n`);
      process.exit(1);
    }
  }
  return out;
}

function loadBatch(batchFile) {
  const file = batchFile
    ? path.resolve(process.cwd(), batchFile)
    : path.join(__dirname, '../data/failed_transactions.json');
  if (!fs.existsSync(file)) {
    console.error(`\n  batch file not found: ${file}\n  run \`npm run seed\` first.\n`);
    process.exit(1);
  }
  return { batch: JSON.parse(fs.readFileSync(file, 'utf8')), file };
}

function run() {
  const { batchFile, capValue } = parseArgs(process.argv);
  const { batch, file } = loadBatch(batchFile);

  // --- Compute the auto-retry value ceiling for THIS run, at run start. ---
  const batchAtRisk = batch.reduce((s, t) => s + (t.amount || 0), 0);
  const fraction = GUARDRAILS.MAX_RETRY_VALUE_FRACTION_OF_BATCH;
  const relativeCeiling = Math.round(batchAtRisk * fraction);
  const retryValueCeiling = capValue != null ? capValue : relativeCeiling;
  const ceilingSource =
    capValue != null
      ? '--cap-value override'
      : `${(fraction * 100).toFixed(0)}% of batch at-risk value`;

  // --- Run header (logged at the top of every run) ---
  console.log('\n  RECOVERAI — BATCH RUN  (rules only, zero AI)');
  console.log('  ' + '='.repeat(52));
  console.log(`  source                     ${path.relative(process.cwd(), file)}`);
  console.log(`  records ingested           ${batch.length}`);
  console.log(`  batch value at risk        ${rupees(batchAtRisk)}`);
  console.log(
    `  auto-retry value ceiling   ${rupees(retryValueCeiling)}  (${ceilingSource})`
  );

  // per-run state the guardrails need
  const messagesPerCustomer = new Map();
  let retryValueSoFar = 0;

  const tally = {
    records: batch.length,
    retries_attempted: 0,
    recovered_count: 0,
    recovered_value: 0,
    failed_retries: 0,
    messages_sent: 0,
  };
  const byAction = {};
  const byCause = {};
  const byGuardrail = {};
  const exceptions = [];

  for (const txn of batch) {
    // --- Stage 2: diagnose (rules only) ---
    const diag = classify(txn);

    // --- Stage 3: decide & act (rules + guardrails) ---
    const ctx = {
      attemptCount: txn.attempt_count || 0,
      customerMessagesToday: messagesPerCustomer.get(txn.customer_id) || 0,
      retryValueSoFar,
      amount: txn.amount,
      retryValueCeiling,
    };
    const decision = decide(diag.root_cause, ctx);

    byAction[decision.action] = (byAction[decision.action] || 0) + 1;
    byCause[decision.root_cause] = (byCause[decision.root_cause] || 0) + 1;
    if (decision.guardrail) {
      byGuardrail[decision.guardrail] = (byGuardrail[decision.guardrail] || 0) + 1;
    }

    if (decision.notify) {
      messagesPerCustomer.set(
        txn.customer_id,
        (messagesPerCustomer.get(txn.customer_id) || 0) + 1
      );
      tally.messages_sent += 1;
    }

    // --- Execute: the only money-movement path ---
    if (decision.execute) {
      retryValueSoFar += txn.amount;
      tally.retries_attempted += 1;
      const result = simulateRetry(txn); // <-- only _truth reader

      if (result.recovered) {
        tally.recovered_count += 1;
        tally.recovered_value += txn.amount;
      } else {
        tally.failed_retries += 1;
        exceptions.push({
          transaction_id: txn.transaction_id,
          reason: 'retry_did_not_recover',
          root_cause: decision.root_cause,
          amount: txn.amount,
        });
      }
    } else {
      // no automated retry -> it's an exception the loop hands off
      exceptions.push({
        transaction_id: txn.transaction_id,
        reason: decision.guardrail || `no_auto_retry:${decision.action}`,
        root_cause: decision.root_cause,
        amount: txn.amount,
      });
    }
  }

  const ceiling = recoverableCeiling(batch);
  report({ tally, byCause, byAction, byGuardrail, exceptions, ceiling });
}

function report({ tally, byCause, byAction, byGuardrail, exceptions, ceiling }) {
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);

  console.log('\n  DIAGNOSIS (by root cause, rules)');
  console.log('  ' + '-'.repeat(52));
  Object.entries(byCause)
    .sort((a, b) => b[1] - a[1])
    .forEach(([c, n]) => console.log(`  ${pad(c, 22)} ${num(n, 3)}`));

  console.log('\n  ACTIONS SELECTED');
  console.log('  ' + '-'.repeat(52));
  Object.entries(byAction)
    .sort((a, b) => b[1] - a[1])
    .forEach(([a, n]) => console.log(`  ${pad(a, 26)} ${num(n, 3)}`));

  console.log('\n  GUARDRAILS TRIGGERED');
  console.log('  ' + '-'.repeat(52));
  if (Object.keys(byGuardrail).length === 0) {
    console.log('  (none)');
  } else {
    Object.entries(byGuardrail)
      .sort((a, b) => b[1] - a[1])
      .forEach(([g, n]) => console.log(`  ${pad(g, 26)} ${num(n, 3)}`));
  }

  console.log('\n  RECOVERY RESULT');
  console.log('  ' + '-'.repeat(52));
  console.log(`  retries attempted          ${tally.retries_attempted}`);
  console.log(`  recovered (count)          ${tally.recovered_count}`);
  console.log(`  recovered (value)          ${rupees(tally.recovered_value)}`);
  console.log(`  retries that did not land  ${tally.failed_retries}`);
  console.log(`  customer messages sent     ${tally.messages_sent}`);
  console.log(`  exceptions (handed off)    ${exceptions.length}`);

  console.log('\n  MEASURED AGAINST HIDDEN GROUND TRUTH');
  console.log('  ' + '-'.repeat(52));
  console.log(
    `  recoverable ceiling        ${ceiling.count} txns  /  ${rupees(ceiling.value)}`
  );
  const capturePct = ceiling.count
    ? ((tally.recovered_count / ceiling.count) * 100).toFixed(1)
    : '0.0';
  const valuePct = ceiling.value
    ? ((tally.recovered_value / ceiling.value) * 100).toFixed(1)
    : '0.0';
  console.log(
    `  captured                   ${tally.recovered_count}/${ceiling.count} txns (${capturePct}%)  /  ${valuePct}% of value`
  );

  console.log('');
}

run();
