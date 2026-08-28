/**
 * DASHBOARD BUILDER
 * -----------------
 * Reads data/run_report.json and emits a single self-contained dashboard.html
 * with the run data inlined.
 *
 * Why a generated file and not a React app + dev server: the dashboard has to
 * survive being opened by someone who just cloned the repo. Inlining the data
 * means no npm install, no build step, no server, and no fetch() -- which
 * would be blocked by file:// CORS anyway. Double-click and it works.
 *
 *   node src/dashboard/build.js      (or: npm run dashboard)
 */

const fs = require('fs');
const path = require('path');

const reportFile = path.join(__dirname, '../../data/run_report.json');
const outFile = path.join(__dirname, '../../dashboard.html');

if (!fs.existsSync(reportFile)) {
  console.error('\n  data/run_report.json not found — run `npm start` first.\n');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RecoverAI — Run Report</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --line: #262d36;
    --ink: #e6edf3; --dim: #8b949e;
    --good: #3fb950; --warn: #d29922; --bad: #f85149; --accent: #58a6ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 24px 64px;
    background: var(--bg); color: var(--ink);
    font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -.01em; }
  .sub { color: var(--dim); font-size: 13px; margin-bottom: 28px; }
  .sub code { color: var(--accent); }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--dim); margin: 32px 0 12px; font-weight: 600;
  }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
  .card .label { color: var(--dim); font-size: 12px; margin-bottom: 6px; }
  .card .value { font-size: 24px; font-weight: 650; letter-spacing: -.02em; }
  .card .foot { color: var(--dim); font-size: 12px; margin-top: 4px; }
  .good { color: var(--good); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
          border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--line); }
  th { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .bar { height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; min-width: 60px; }
  .bar > i { display: block; height: 100%; background: var(--accent); }
  .scroll { overflow-x: auto; }
  .note { color: var(--dim); font-size: 12px; margin-top: 10px; }
  .tag { font-family: ui-monospace, monospace; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>RecoverAI — Payment Recovery Run</h1>
  <div class="sub" id="sub"></div>
  <div id="app"></div>
</div>

<script>
const R = ${JSON.stringify(report)};

const inr = p => 'Rs ' + (p/100).toLocaleString('en-IN', {maximumFractionDigits:0});
const pc  = x => (x*100).toFixed(1) + '%';
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

document.getElementById('sub').innerHTML =
  R.config.records + ' failed transactions from <code>' + esc(R.config.source) + '</code>'
  + ' &middot; ' + inr(R.config.batch_at_risk) + ' at risk'
  + ' &middot; generated ' + new Date(R.generated_at).toLocaleString();

const g = R.ground_truth, res = R.result;

const cards = [
  ['Recovered', inr(res.recovered_value), res.recovered_count + ' of ' + g.recoverable_count + ' recoverable', 'good'],
  ['Capture rate', pc(g.capture_rate), pc(g.value_capture_rate) + ' of recoverable value', ''],
  ['Of what\\'s reachable', pc(g.reachable_capture_rate), res.recovered_count + ' of ' + g.reachable_count + ' inside the attempt cap', ''],
  ['Cost of attempt cap', inr(g.beyond_cap_value), g.beyond_cap_count + ' txns only land past attempt ' + R.config.max_attempts, 'warn'],
  ['Retries fired', res.retries_attempted, res.stopped_at_cap + ' hit the attempt cap', ''],
  ['Escalated to human', res.escalated, 'never auto-retried', 'bad'],
  ['Links issued', res.links_issued, res.messages_logged + ' messages logged', ''],
  ['Exceptions', res.exceptions, 'every one carries a reason', ''],
];

function table(head, rows) {
  return '<div class="scroll"><table><thead><tr>' + head + '</tr></thead><tbody>'
    + rows.join('') + '</tbody></table></div>';
}

let h = '<div class="cards">' + cards.map(([l,v,f,c]) =>
  '<div class="card"><div class="label">' + l + '</div>'
  + '<div class="value ' + c + '">' + v + '</div>'
  + '<div class="foot">' + f + '</div></div>').join('') + '</div>';

// --- by cause ---
const maxVal = Math.max(...R.by_cause.map(c => c.value), 1);
h += '<h2>Recovery by root cause</h2>' + table(
  '<th>Root cause</th><th class="n">Seen</th><th class="n">Retried</th><th class="n">Won</th><th class="n">Rate</th><th class="n">Recovered</th><th style="width:140px"></th>',
  R.by_cause.map(c =>
    '<tr><td class="tag">' + esc(c.cause) + '</td>'
    + '<td class="n">' + c.seen + '</td>'
    + '<td class="n">' + c.retried + '</td>'
    + '<td class="n">' + c.recovered + '</td>'
    + '<td class="n">' + (c.rate === null ? '—' : pc(c.rate)) + '</td>'
    + '<td class="n">' + (c.value ? inr(c.value) : '—') + '</td>'
    + '<td><div class="bar"><i style="width:' + (c.value/maxVal*100) + '%"></i></div></td></tr>')
);
h += '<div class="note">Causes with 0 retries are the safety rails working: dead instruments, invalid mandates, risk blocks and unknown codes are never auto-retried.</div>';

// --- actions + guardrails side by side ---
h += '<h2>Actions dispatched</h2>' + table(
  '<th>Action</th><th class="n">Count</th>',
  R.by_action.map(a => '<tr><td class="tag">' + esc(a.action) + '</td><td class="n">' + a.count + '</td></tr>')
);

h += '<h2>Guardrails tripped</h2>' + table(
  '<th>Guardrail</th><th class="n">Trips</th>',
  R.guardrails.map(x => '<tr><td class="tag">' + esc(x.guardrail) + '</td><td class="n">' + x.count + '</td></tr>')
);

// --- exceptions ---
h += '<h2>Exception list — every rupee not recovered, with a reason</h2>' + table(
  '<th>Reason</th><th class="n">Txns</th><th class="n">Value</th>',
  R.exceptions_by_reason.map(e =>
    '<tr><td class="tag">' + esc(e.reason) + '</td><td class="n">' + e.count + '</td><td class="n">' + inr(e.value) + '</td></tr>')
);
h += '<div class="note">Measured against hidden ground truth the agent never reads. '
  + inr(g.recoverable_value) + ' across ' + g.recoverable_count
  + ' transactions was theoretically recoverable — that is the ceiling, not a target.</div>';

document.getElementById('app').innerHTML = h;
</script>
</body>
</html>
`;

fs.writeFileSync(outFile, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`\n  dashboard written -> ${path.relative(process.cwd(), outFile)}  (${kb} KB, self-contained)\n`);
