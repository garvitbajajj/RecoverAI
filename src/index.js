/**
 * RECOVERAI — BATCH RUNNER
 * ------------------------
 * Ingest -> Diagnose (rules) -> Decide & Act (rules + guardrails) -> Report.
 *
 *   node src/index.js                        # data/failed_transactions.json
 *   node src/index.js path/to.json           # custom batch file
 *   node src/index.js --cap-value 5000       # force a low retry-value ceiling
 *                                            # (paise) to demo the rail firing
 *   node src/index.js --exceptions           # print the full exception list
 *
 * ZERO AI in this path. No LLM is imported or called anywhere in the loop.
 * The only file that sees the hidden ground truth is src/lib/simulator.js.
 */

const fs = require('fs');
const path = require('path');

const { classify } = require('./lib/classifier');
const { decide } = require('./lib/executor');
const { dispatch } = require('./lib/actions');
const { simulateRetry, recoverableCeiling, beyondAttemptCap } = require('./lib/simulator');
const { Metrics } = require('./lib/metrics');
const { JsonlAuditLog, STAGE } = require('./lib/audit');
const { buildReport } = require('./lib/report');
const { GUARDRAILS } = require('./config/taxonomy');

const rupees = (paise) =>
  'Rs ' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');

function parseArgs(argv) {
  const rest = argv.slice(2);
  const out = { batchFile: null, capValue: null, showExceptions: false };

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
    } else if (a === '--exceptions') {
      out.showExceptions = true;
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

async function run() {
  const { batchFile, capValue, showExceptions } = parseArgs(process.argv);
  const { batch, file } = loadBatch(batchFile);

  // --- Auto-retry value ceiling for THIS run, computed at run start. ---
  const batchAtRisk = batch.reduce((s, t) => s + (t.amount || 0), 0);
  const fraction = GUARDRAILS.MAX_RETRY_VALUE_FRACTION_OF_BATCH;
  const retryValueCeiling =
    capValue != null ? capValue : Math.round(batchAtRisk * fraction);
  const ceilingSource =
    capValue != null
      ? '--cap-value override'
      : `${(fraction * 100).toFixed(0)}% of batch at-risk value`;

  const auditFile = path.join(__dirname, '../data/audit_log.jsonl');
  const audit = new JsonlAuditLog(auditFile).open();

  console.log('\n  RECOVERAI — BATCH RUN  (rules only, zero AI)');
  console.log('  ' + '='.repeat(56));
  console.log(`  source                     ${path.relative(process.cwd(), file)}`);
  console.log(`  records ingested           ${batch.length}`);
  console.log(`  batch value at risk        ${rupees(batchAtRisk)}`);
  console.log(`  auto-retry value ceiling   ${rupees(retryValueCeiling)}  (${ceilingSource})`);
  console.log(`  attempt cap                ${GUARDRAILS.MAX_ATTEMPTS_PER_TRANSACTION} per transaction`);

  const m = new Metrics();
  const messagesPerCustomer = new Map();
  let retryValueSoFar = 0;

  for (const txn of batch) {
    // ---- Stage 2: diagnose (rules only) ----
    const diag = classify(txn);
    const cause = diag.root_cause;
    m.seen(txn, cause);
    audit.write({
      stage: STAGE.DIAGNOSE,
      transaction_id: txn.transaction_id,
      error_code: diag.error_code,
      root_cause: cause,
      mapped: diag.mapped,
      source: diag.source,
      reason: diag.reason,
    });

    // ---- Stage 3: decide, act, and keep retrying until a stopping rule ----
    let attempts = 0;
    let recovered = false;
    let lastDecision = null;
    let lastDispatch = null;

    // Bounded by the attempt cap; every exit below is an explicit stopping rule.
    for (;;) {
      const decision = decide(cause, {
        attemptCount: attempts,
        customerMessagesToday: messagesPerCustomer.get(txn.customer_id) || 0,
        retryValueSoFar,
        amount: txn.amount,
        retryValueCeiling,
      });
      lastDecision = decision;

      m.action(decision.action);
      decision.guardrails_tripped.forEach((g) => m.guardrail(g));

      audit.write({
        stage: STAGE.DECIDE,
        transaction_id: txn.transaction_id,
        attempt: decision.attempt_number,
        root_cause: decision.root_cause,
        action: decision.action,
        execute: decision.execute,
        notify: decision.notify,
        guardrail: decision.guardrail,
        guardrails_tripped: decision.guardrails_tripped,
        rationale: decision.rationale,
      });

      // ---- Act ----
      const act = dispatch(txn, decision);
      lastDispatch = act;

      if (act.message) {
        messagesPerCustomer.set(
          txn.customer_id,
          (messagesPerCustomer.get(txn.customer_id) || 0) + 1
        );
        m.message();
      }
      if (act.link) m.link();
      if (act.escalated) m.escalation();

      audit.write({
        stage: STAGE.DISPATCH,
        transaction_id: txn.transaction_id,
        attempt: decision.attempt_number,
        action: act.action,
        scheduled_for: act.scheduled_for,
        delay_hours: act.delay_hours,
        link: act.link,
        message: act.message,
        detail: act.detail,
      });

      // STOPPING RULE 1: the action does not move money. One pass only --
      // re-issuing the same link three times is spam, not recovery.
      if (!act.moves_money || !decision.execute) break;

      // ---- Execute the retry (only money-movement path) ----
      retryValueSoFar += txn.amount;
      attempts += 1;
      const result = simulateRetry(txn, attempts);
      m.retry(txn, cause, result.recovered);

      audit.write({
        stage: STAGE.RETRY,
        transaction_id: txn.transaction_id,
        attempt: attempts,
        amount: txn.amount,
        recovered: result.recovered,
      });

      // STOPPING RULE 2: success. Stop immediately -- never retry a payment
      // that already went through.
      if (result.recovered) {
        recovered = true;
        break;
      }

      // STOPPING RULE 3: attempt budget spent.
      if (attempts >= decision.max_attempts) {
        m.attemptsExhausted();
        audit.write({
          stage: STAGE.STOP,
          transaction_id: txn.transaction_id,
          attempt: attempts,
          reason: 'MAX_ATTEMPTS',
          detail: `Attempt budget of ${decision.max_attempts} spent without recovery.`,
        });
        break;
      }
    }

    // ---- Exception accounting: anything not recovered leaves with a reason ----
    // The reason must be what actually BLOCKED recovery. A suppressed message
    // never blocked a recovery, so MESSAGE_CAP is deliberately not a reason
    // here even when it tripped -- filing "awaiting customer" cases under it
    // would overstate the rail and hide the real state of those payments.
    if (!recovered) {
      let reason;
      if (attempts > 0) {
        reason = 'retries_exhausted';
      } else if (lastDispatch.escalated) {
        reason = lastDecision.guardrail || 'ESCALATE_HUMAN';
      } else if (!lastDispatch.moves_money) {
        reason = `awaiting_customer:${lastDecision.action}`;
      } else {
        // Money-moving action that never fired: a rail stopped it pre-attempt.
        reason = lastDecision.guardrail || 'not_attempted';
      }

      m.exception(txn, reason, cause, lastDispatch ? lastDispatch.detail : null);
    }
  }

  await audit.close();

  const ceiling = recoverableCeiling(batch);
  const unreachable = beyondAttemptCap(batch, GUARDRAILS.MAX_ATTEMPTS_PER_TRANSACTION);

  // One serialised run report. Console, dashboard and any future API all read
  // this same object, so the numbers cannot disagree between surfaces.
  const runReport = buildReport({
    m,
    ceiling,
    unreachable,
    batchAtRisk,
    config: {
      source: path.relative(process.cwd(), file),
      retryValueCeiling,
      ceilingSource,
      maxAttempts: GUARDRAILS.MAX_ATTEMPTS_PER_TRANSACTION,
    },
  });
  const reportFile = path.join(__dirname, '../data/run_report.json');
  fs.writeFileSync(reportFile, JSON.stringify(runReport, null, 2));

  report({ m, ceiling, unreachable, batchAtRisk, audit, auditFile, showExceptions, reportFile });
}

function report({ m, ceiling, unreachable, batchAtRisk, audit, auditFile, showExceptions, reportFile }) {
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);

  console.log('\n  DIAGNOSIS & RECOVERY BY ROOT CAUSE');
  console.log('  ' + '-'.repeat(56));
  console.log(`  ${pad('cause', 20)} ${num('seen', 5)} ${num('retried', 8)} ${num('won', 5)} ${num('rate', 7)}   recovered`);
  for (const r of m.causeTable()) {
    const rate = r.rate === null ? '   --' : `${(r.rate * 100).toFixed(0)}%`;
    console.log(
      `  ${pad(r.cause, 20)} ${num(r.seen, 5)} ${num(r.retried, 8)} ${num(r.recovered, 5)} ${num(rate, 7)}   ${r.value ? rupees(r.value) : '-'}`
    );
  }

  console.log('\n  ACTIONS DISPATCHED');
  console.log('  ' + '-'.repeat(56));
  Object.entries(m.byAction)
    .sort((a, b) => b[1] - a[1])
    .forEach(([a, n]) => console.log(`  ${pad(a, 28)} ${num(n, 4)}`));

  console.log('\n  GUARDRAILS TRIPPED  (all trips, independently counted)');
  console.log('  ' + '-'.repeat(56));
  const rails = Object.entries(m.byGuardrail).sort((a, b) => b[1] - a[1]);
  if (rails.length === 0) console.log('  (none)');
  else rails.forEach(([g, n]) => console.log(`  ${pad(g, 28)} ${num(n, 4)}`));
  console.log(`  ${pad('stopped at attempt cap', 28)} ${num(m.stoppedAtCap, 4)}`);

  console.log('\n  RECOVERY RESULT');
  console.log('  ' + '-'.repeat(56));
  console.log(`  retries attempted          ${m.retries_attempted}`);
  console.log(`  recovered (count)          ${m.recovered_count}`);
  console.log(`  recovered (value)          ${rupees(m.recovered_value)}`);
  console.log(`  recovery links issued      ${m.links_issued}`);
  console.log(`  customer messages logged   ${m.messages_sent}`);
  console.log(`  escalated to human         ${m.escalated}`);
  console.log(`  exceptions (handed off)    ${m.exceptions.length}`);

  console.log('\n  EXCEPTION LIST  (every rupee not recovered, with a reason)');
  console.log('  ' + '-'.repeat(56));
  for (const [reason, s] of m.exceptionsByReason()) {
    console.log(`  ${pad(reason, 32)} ${num(s.count, 4)}   ${rupees(s.value)}`);
  }

  console.log('\n  MEASURED AGAINST HIDDEN GROUND TRUTH');
  console.log('  ' + '-'.repeat(56));
  console.log(`  batch at risk              ${rupees(batchAtRisk)}`);
  console.log(`  recoverable ceiling        ${ceiling.count} txns  /  ${rupees(ceiling.value)}`);
  console.log(
    `  captured                   ${m.recovered_count}/${ceiling.count} txns (${pct(m.recovered_count, ceiling.count)}%)  /  ${pct(m.recovered_value, ceiling.value)}% of recoverable value`
  );
  console.log(
    `  cost of the attempt cap    ${unreachable.count} txns / ${rupees(unreachable.value)} would only have landed beyond attempt ${GUARDRAILS.MAX_ATTEMPTS_PER_TRANSACTION}`
  );
  const reachable = ceiling.count - unreachable.count;
  console.log(
    `  captured of what's reachable  ${m.recovered_count}/${reachable} (${pct(m.recovered_count, reachable)}%)`
  );

  console.log(`\n  audit trail                ${audit.count} events -> ${path.relative(process.cwd(), auditFile)}`);
  console.log(`  run report                 ${path.relative(process.cwd(), reportFile)}`);

  if (showExceptions) {
    console.log('\n  FULL EXCEPTION LIST');
    console.log('  ' + '-'.repeat(56));
    for (const e of m.exceptions) {
      console.log(`  ${pad(e.transaction_id, 18)} ${pad(e.root_cause, 20)} ${pad(e.reason, 26)} ${rupees(e.amount)}`);
    }
  }

  console.log('');
}

run();
