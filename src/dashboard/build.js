/**
 * DASHBOARD BUILDER
 * -----------------
 * Reads data/run_report.json and emits a single self-contained dashboard.html
 * with the run data inlined, plus an interactive panel that diagnoses a
 * reviewer's own transaction.
 *
 * Why a generated file and not a React app + dev server: the dashboard has to
 * survive being opened by someone who just cloned the repo. Inlining the data
 * means no npm install, no build step, no server, and no fetch() -- which
 * would be blocked by file:// CORS anyway. Double-click and it works.
 *
 * The panel runs the REAL rules modules, inlined from src/ by ./bundle.js, so
 * it cannot drift from the agent. Only the LLM fallback needs a server, and it
 * lives behind /api/diagnose so the key never reaches the browser.
 *
 *   node src/dashboard/build.js      (or: npm run dashboard)
 */

const fs = require('fs');
const path = require('path');
const { buildModuleBundle } = require('./bundle');

const reportFile = path.join(__dirname, '../../data/run_report.json');
const outFile = path.join(__dirname, '../../dashboard.html');

if (!fs.existsSync(reportFile)) {
  console.error('\n  data/run_report.json not found — run `npm start` first.\n');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));

/**
 * Interactive panel logic. Deliberately written with string concatenation and
 * no template literals: this whole file is one big template literal, so a `${`
 * in here would be interpolated at build time instead of shipped to the page.
 */
const PANEL_JS = `
// ---------------------------------------------------------------------------
// INTERACTIVE PANEL
// Runs the same classify()/decide()/dispatch() the batch agent runs, from the
// bundle inlined above. Shows the DECISION only -- never an outcome. See the
// note rendered into the panel for why.
// ---------------------------------------------------------------------------
(function () {
  var RA = globalThis.RecoverAI;
  if (!RA) return;

  var METHODS = ['upi', 'card', 'netbanking', 'mandate'];

  function el(id) { return document.getElementById(id); }
  function rupees(p) { return 'Rs ' + (Number(p) / 100).toLocaleString('en-IN'); }

  function field(label, inner, hint) {
    return '<label class="fld"><span class="fl">' + label + '</span>' + inner
      + (hint ? '<span class="fh">' + hint + '</span>' : '') + '</label>';
  }

  var form =
    '<div class="panelgrid">'
    + field('error_code <b>*</b>', '<input id="p_code" placeholder="U69, CARD_EXPIRED, ERR_BAL_LOW_RETRY_LATER…" autocomplete="off">', 'the only required field')
    + field('amount (paise)', '<input id="p_amt" type="number" min="0" value="250000">', 'Rs 2,500')
    + field('method', '<select id="p_method">' + METHODS.map(function (m) { return '<option>' + m + '</option>'; }).join('') + '</select>', '')
    + field('attempt_count', '<input id="p_att" type="number" min="0" value="0">', 'retries already spent')
    + field('created_at', '<input id="p_when" type="datetime-local">', 'affects scheduled retries')
    + field('is_subscription', '<select id="p_sub"><option value="false">false</option><option value="true">true</option></select>', '')
    + '</div>'
    + '<details class="batchctx"><summary>Batch context — not applicable to a single transaction</summary>'
    + '<div class="note">These guardrails are batch-level state. A one-off input has no run to accumulate against, so they are <b>not evaluated</b> unless you supply a hypothetical below — in which case the result is labelled as hypothetical, not measured.</div>'
    + '<div class="panelgrid">'
    + field('messages sent to this customer today', '<input id="p_msgs" type="number" min="0" value="0">', 'feeds the 2/day message cap')
    + field('hypothetical batch ceiling (Rs)', '<input id="p_ceil" type="number" min="0" placeholder="leave blank to skip">', 'blank = value cap not evaluated')
    + '</div></details>'
    + '<details class="batchctx"><summary>Or paste JSON — one object or an array, same shape as data/failed_transactions.json</summary>'
    + '<textarea id="p_json" rows="5" placeholder=\\'{"error_code":"U69","amount":250000,"method":"upi"}\\'></textarea>'
    + '<div class="note">If this is non-empty it takes precedence over the form above. Any <code>_truth</code> block is ignored — the panel never reads it.</div>'
    + '</details>'
    + '<div class="prow"><button id="p_go" class="btn">Diagnose</button>'
    + '<span class="note" id="p_hint"></span></div>';

  el('panel').innerHTML =
    '<h2 id="try">Try it — diagnose your own transaction</h2>'
    + '<div class="card">'
    + '<div class="note warnbox"><b>No recovery figure is shown here, on purpose.</b> '
    + 'The batch numbers above are measured against a hidden <code>_truth</code> block that says whether a retry would genuinely have succeeded. '
    + 'Your transaction has no such block, so whether it would actually recover is <b>unknowable</b>. '
    + 'The panel shows the decision the agent would make and stops there. Claiming an outcome would be exactly the self-fulfilling reporting this project exists to avoid.</div>'
    + form + '<div id="p_out"></div></div>';

  // Default created_at to now, in the local-datetime format the input wants.
  var now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  el('p_when').value = now.toISOString().slice(0, 16);

  function readForm() {
    return {
      error_code: (el('p_code').value || '').trim(),
      amount: Number(el('p_amt').value || 0),
      method: el('p_method').value,
      attempt_count: Number(el('p_att').value || 0),
      is_subscription: el('p_sub').value === 'true',
      created_at: el('p_when').value ? new Date(el('p_when').value).toISOString() : new Date().toISOString(),
      order_id: 'order_preview',
      transaction_id: 'pay_preview',
      customer_id: 'cust_preview'
    };
  }

  function batchCtx() {
    var raw = el('p_ceil').value;
    var ceilRupees = raw === '' ? null : Number(raw);
    return {
      messagesToday: Number(el('p_msgs').value || 0),
      ceiling: ceilRupees === null ? null : Math.round(ceilRupees * 100)
    };
  }

  function row(k, v, cls) {
    return '<tr><td class="rk">' + k + '</td><td class="' + (cls || '') + '">' + v + '</td></tr>';
  }

  function tag(s) { return '<span class="tag">' + esc(s) + '</span>'; }

  /** The one sentence a reviewer actually reads. Decision, never outcome. */
  function wouldLine(d, act) {
    if (!d.execute) {
      if (act.escalated) return 'Would <b>not</b> attempt a debit — escalates to a human.';
      if (!act.moves_money) return 'Would <b>not</b> attempt a debit — issues ' + tag(d.action) + ' and waits for the customer.';
      return 'Would <b>not</b> attempt a debit — blocked by ' + tag(d.guardrail || 'a guardrail') + '.';
    }
    var when = act.delay_hours === 0 ? 'immediately'
      : (act.scheduled_for ? 'at ' + new Date(act.scheduled_for).toLocaleString() + ' (T+' + act.delay_hours + 'h)'
        : 'at T+' + act.delay_hours + 'h');
    return 'Would attempt: ' + tag(d.action) + ' ' + when
      + ', attempt ' + d.attempt_number + ' of ' + d.max_attempts + '.';
  }

  function renderOne(txn, ctx, idx) {
    var diag = RA.classify(txn);
    var evaluatedCeiling = ctx.ceiling === null ? Infinity : ctx.ceiling;
    var d = RA.decide(diag.root_cause, {
      attemptCount: txn.attempt_count || 0,
      customerMessagesToday: ctx.messagesToday,
      retryValueSoFar: 0,
      amount: txn.amount || 0,
      retryValueCeiling: evaluatedCeiling
    });
    var act = RA.dispatch(txn, d);

    var tripped = d.guardrails_tripped.length
      ? d.guardrails_tripped.map(tag).join(' ')
      : '<span class="dim">none</span>';

    var capNote = ctx.ceiling === null
      ? '<span class="dim">not evaluated — batch-level state, no run to accumulate against</span>'
      : 'hypothetical ceiling ' + rupees(ctx.ceiling) + ' — '
        + (d.guardrails_tripped.indexOf('RETRY_VALUE_CAP') >= 0 ? 'would clamp this retry' : 'this retry fits under it');

    var head = idx === null ? '' : '<div class="ridx">#' + (idx + 1) + ' &middot; ' + esc(txn.error_code || '(no code)') + '</div>';

    var body = '<table class="rtable">'
      + row('Would do', wouldLine(d, act), 'wl')
      + row('Root cause', tag(d.root_cause) + (diag.mapped ? ' <span class="ok">mapped by rules</span>' : ' <span class="warn">not in taxonomy</span>'))
      + row('Classifier reason', '<span class="dim">' + esc(diag.reason) + '</span>')
      + row('Action', tag(d.action))
      + row('execute / notify', (d.execute ? '<b class="ok">true</b>' : 'false') + ' / ' + (d.notify ? '<b>true</b>' : 'false'))
      + row('Attempts', d.max_attempts === 0
        ? '<span class="dim">no automated attempts permitted for this cause</span>'
        : d.attempt_number + ' of ' + d.max_attempts)
      + row('Binding guardrail', d.guardrail ? tag(d.guardrail) : '<span class="dim">none</span>')
      + row('All guardrails tripped', tripped)
      + row('Value cap', capNote)
      + row('Executor rationale', '<span class="dim">' + esc(d.rationale) + '</span>')
      + (act.link ? row('Link issued', '<span class="dim">' + esc(act.link) + '</span>') : '')
      + (act.message ? row('Message logged', '<span class="dim">' + esc(act.message.body) + '</span>') : '')
      + '</table>';

    var llm = '';
    if (!diag.mapped && txn.error_code) {
      llm = '<div class="llmrow">'
        + '<button class="btn alt" data-code="' + esc(txn.error_code) + '" data-method="' + esc(txn.method || '') + '" data-sub="' + (txn.is_subscription ? '1' : '0') + '">Diagnose with the model</button>'
        + '<span class="note">Rules cannot decide this code. The model runs server-side; it can only return a cause already in the taxonomy, and never picks an action.</span>'
        + '<div class="llmout"></div></div>';
    }

    return '<div class="result">' + head + body + llm + '</div>';
  }

  function parsePaste(raw) {
    var v = JSON.parse(raw);
    return Array.isArray(v) ? v : [v];
  }

  function run() {
    var ctx = batchCtx();
    var out = el('p_out');
    var raw = (el('p_json').value || '').trim();
    var txns;

    if (raw) {
      try {
        txns = parsePaste(raw);
      } catch (e) {
        out.innerHTML = '<div class="err">Could not parse that JSON: ' + esc(e.message) + '</div>';
        return;
      }
      if (!txns.length) { out.innerHTML = '<div class="err">That JSON array is empty.</div>'; return; }
    } else {
      var t = readForm();
      if (!t.error_code) {
        out.innerHTML = '<div class="err">error_code is required — it is the only thing the rules read.</div>';
        return;
      }
      txns = [t];
    }

    var many = txns.length > 1;
    if (txns.length > 200) {
      out.innerHTML = '<div class="err">That is ' + txns.length + ' transactions. Cap is 200 for the panel — run the batch agent for more.</div>';
      return;
    }

    out.innerHTML = (many ? '<div class="note">' + txns.length + ' transactions. Decisions only — no recovery figures, for the reason above.</div>' : '')
      + txns.map(function (t, i) { return renderOne(t, ctx, many ? i : null); }).join('');
    wireLlmButtons();
  }

  function wireLlmButtons() {
    var btns = document.querySelectorAll('.llmrow .btn');
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () {
        var out = b.parentNode.querySelector('.llmout');
        b.disabled = true;
        out.innerHTML = '<span class="dim">asking the model…</span>';

        fetch('/api/diagnose', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            error_code: b.getAttribute('data-code'),
            method: b.getAttribute('data-method'),
            is_subscription: b.getAttribute('data-sub') === '1'
          })
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
          .then(function (res) {
            b.disabled = false;
            var j = res.j || {};
            if (res.ok && j.root_cause) {
              out.innerHTML = '<div class="llmok">Model diagnosed: ' + tag(j.root_cause)
                + '<div class="note">' + esc(j.reason || '') + '</div>'
                + '<div class="note">The executor would now apply the same policy and guardrails as any rules-diagnosed transaction. Still no recovery figure — the outcome remains unknowable.</div></div>';
            } else {
              out.innerHTML = '<div class="llmno"><b>No diagnosis.</b> ' + esc(j.reason || j.error || ('HTTP ' + res.status))
                + '<div class="note">This is the designed fallback, not a crash: the code stays ' + tag('UNKNOWN')
                + ' and escalates to a human — exactly what the agent does with no model at all.</div></div>';
            }
          })
          .catch(function (e) {
            b.disabled = false;
            var offline = !/^https?:$/.test(location.protocol);
            out.innerHTML = '<div class="llmno"><b>Model unreachable.</b> '
              + (offline ? 'This page is not being served over HTTP, so there is no /api endpoint to call. Deploy it, or open it through a web server.' : esc(e.message))
              + '<div class="note">Falls back to what the agent already does: the code stays ' + tag('UNKNOWN') + ' and escalates to a human.</div></div>';
          });
      });
    });
  }

  el('p_go').addEventListener('click', run);
  el('p_code').addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
  el('p_hint').textContent = 'Try U69 (mapped) or ERR_BAL_LOW_RETRY_LATER (unmapped — offers the model).';
})();
`;

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
  .sub a { color: var(--accent); text-decoration: none; }
  .sub a:hover { text-decoration: underline; }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--dim); margin: 32px 0 12px; font-weight: 600;
  }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
  .card .label { color: var(--dim); font-size: 12px; margin-bottom: 6px; }
  .card .value { font-size: 24px; font-weight: 650; letter-spacing: -.02em; }
  .card .foot { color: var(--dim); font-size: 12px; margin-top: 4px; }
  .good, .ok { color: var(--good); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .dim { color: var(--dim); }
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

  /* --- interactive panel --- */
  .warnbox { border-left: 3px solid var(--warn); padding: 10px 12px; background: #1b1d1a;
             border-radius: 4px; margin: 0 0 18px; line-height: 1.55; }
  .panelgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr)); gap: 12px; margin: 14px 0; }
  .fld { display: flex; flex-direction: column; gap: 4px; }
  .fl { font-size: 12px; color: var(--dim); }
  .fh { font-size: 11px; color: #6e7681; }
  input, select, textarea {
    background: #0d1117; color: var(--ink); border: 1px solid var(--line);
    border-radius: 6px; padding: 7px 9px; font: inherit; font-size: 13px; width: 100%;
  }
  textarea { font-family: ui-monospace, monospace; font-size: 12px; margin-top: 8px; resize: vertical; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
  .btn { background: var(--accent); color: #06101f; border: 0; border-radius: 6px;
         padding: 8px 16px; font: inherit; font-weight: 600; cursor: pointer; }
  .btn:hover { filter: brightness(1.1); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.alt { background: #21262d; color: var(--ink); font-weight: 500; padding: 6px 12px; font-size: 13px; }
  .prow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 6px; }
  .prow .note { margin-top: 0; }
  .batchctx { margin: 12px 0; border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; }
  .batchctx summary { cursor: pointer; font-size: 12px; color: var(--dim); }
  .result { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 14px; }
  .ridx { font-size: 12px; color: var(--dim); margin-bottom: 8px; font-family: ui-monospace, monospace; }
  .rtable td { padding: 7px 12px; vertical-align: top; }
  .rtable .rk { color: var(--dim); font-size: 12px; width: 190px; white-space: nowrap; }
  .rtable .wl { font-size: 14px; }
  .err { color: var(--bad); font-size: 13px; margin-top: 14px; }
  .llmrow { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--line); }
  .llmout { margin-top: 10px; }
  .llmok { border-left: 3px solid var(--good); padding: 8px 12px; background: #11170f; border-radius: 4px; }
  .llmno { border-left: 3px solid var(--dim); padding: 8px 12px; background: #14171c; border-radius: 4px; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>RecoverAI — Payment Recovery Run</h1>
  <div class="sub" id="sub"></div>
  <div id="app"></div>
  <div id="panel"></div>
</div>

<script>
${buildModuleBundle()}
</script>

<script>
const R = ${JSON.stringify(report)};

const inr = p => 'Rs ' + (p/100).toLocaleString('en-IN', {maximumFractionDigits:0});
const pc  = x => (x*100).toFixed(1) + '%';
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

document.getElementById('sub').innerHTML =
  R.config.records + ' failed transactions from <code>' + esc(R.config.source) + '</code>'
  + ' &middot; ' + inr(R.config.batch_at_risk) + ' at risk'
  + ' &middot; generated ' + new Date(R.generated_at).toLocaleString()
  + ' &middot; <a href="#try">try your own transaction &darr;</a>';

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
${PANEL_JS}
</script>
</body>
</html>
`;

fs.writeFileSync(outFile, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`\n  dashboard written -> ${path.relative(process.cwd(), outFile)}  (${kb} KB, self-contained)\n`);
