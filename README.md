# RecoverAI

**Payment failure triage & recovery agent.** Ingests a batch of failed
transactions, diagnoses why each one failed, executes a bounded recovery
action for that specific cause, and reports what it actually recovered —
including what it couldn't, and why.

> Failed payments are earned revenue that quietly disappears. Most recovery
> tooling retries blindly and reports the retries. This reports the rupees.

Razorpay AI Buildathon 2026 · Track 03 (AI Revenue Recovery)

---

## Run it

No dependencies. No database. No API key required.

```bash
npm run seed      # generate a reproducible batch of 180 failed transactions
npm start         # run the agent over the batch
npm run report    # run + build dashboard.html
```

`npm run report` writes a self-contained `dashboard.html` — open it directly
in a browser. No server, no build step.

**Optional:** copy `.env.example` to `.env` and add a free
[Google AI Studio](https://aistudio.google.com) key to enable the LLM
fallback. Without one the agent runs identically and escalates unmapped
codes instead — see below.

---

## Result on the shipped batch

180 failed transactions, ₹6,25,155 at risk.

| | |
|---|---|
| **Recovered** | **₹1,37,932 across 50 transactions** |
| Recoverable ceiling | 71 transactions / ₹2,12,456 |
| Capture rate | 70.4% of recoverable transactions, 64.9% of recoverable value |
| Of what the attempt cap leaves reachable | 50/64 — **78.1%** |
| Escalated to a human | 6 |
| Exceptions, each with a stated reason | 130 |

Rules alone recover 47. The LLM fallback adds 3 more by diagnosing decline
codes the taxonomy doesn't cover — measurable upside from 5 model calls.

That ceiling is not a guess. Every synthetic transaction carries a hidden
`_truth` block deciding whether a retry would genuinely have succeeded. **The
agent never reads it** — only the scorer does. Without that separation, "money
recovered" is self-fulfilling: retry everything, declare victory.

---

## How it works

```
Ingest  →  Diagnose  →  Decide & Act  →  Report
           (rules)      (bounded action,   (money recovered +
                         guardrails)        honest exceptions)
```

**Diagnose** — `src/lib/classifier.js` maps decline codes to root causes
through a lookup table. `U69` → `INSUFFICIENT_FUNDS`. Deterministic, instant,
no failure mode. Codes absent from the taxonomy return `UNKNOWN` and escalate
rather than guess.

**Decide** — `src/lib/executor.js` maps a root cause to exactly one action
from a closed list, then applies guardrails *above* that policy. It throws if
an action ever escapes the allowed set.

**Act** — `src/lib/actions.js` carries it out. Retries move money; everything
else issues a link or a message, which is logged rather than sent.

**Report** — `src/lib/metrics.js` measures against the hidden ceiling and
files every unrecovered rupee with a reason.

### Root causes → actions

| Root cause | Action | Auto-retry? |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `SCHEDULED_RETRY` near a likely credit event | yes, ≤3 |
| `BANK_DOWNTIME` | `RETRY_AFTER_WINDOW` (2h) | yes, ≤3 |
| `UPI_TIMEOUT` | `IMMEDIATE_RETRY` | yes, ≤2 |
| `AUTH_ABANDONED` | `RECOVERY_LINK_ALT_METHOD` | no |
| `MANDATE_INVALID` | `REAUTH_LINK` | no |
| `CARD_EXPIRED` | `UPDATE_INSTRUMENT_REQUEST` | no |
| `INVALID_INSTRUMENT` | `UPDATE_INSTRUMENT_REQUEST` | no |
| `RISK_BLOCKED` | `ESCALATE_HUMAN` | **never** |
| `UNKNOWN` | `ESCALATE_HUMAN` | **never** |

Every policy carries a `rationale` string, and it lands in the audit trail
next to the decision it justified.

---

## Design decisions

**Rules first. The model only where it earns its place.**
Decline codes are unambiguous. Routing them through a language model would add
latency, cost and a failure mode in exchange for nothing. The model's job is
narrow and real: codes the taxonomy doesn't cover. On this batch that's 5
records out of 180 — **2.8%** — and that ratio is the honest argument for
using one at all.

Three things keep that safe:

- **It cannot invent a diagnosis.** Output is constrained to the existing
  root-cause enum; anything off-list is discarded. It proposes a cause and
  never picks an action — the executor still decides that, under the same
  guardrails as every rules-diagnosed transaction.
- **A circuit breaker.** After 3 consecutive provider failures it opens and
  every later call short-circuits without touching the network, so a bad key
  or a rate limit can't become 180 slow timeouts.
- **The fallback is a correct outcome, not an error path.** No key, a
  timeout, an off-list answer — the code stays `UNKNOWN` and escalates to a
  human, which is exactly what the agent does with no LLM at all.

That last point is the important one: **the LLM is pure upside.** It can add
recoveries; it can never break a run. Verify it yourself:

```bash
npm start -- --no-llm      # force rules-only; recovery is identical
```

**Safety rails are absolute, not advisory.**
`RISK_BLOCKED` and `UNKNOWN` are never auto-retried under any circumstance —
pushing a retry through a risk block could complete a fraudulent payment.
Expired cards and invalid instruments are never retried either; the
destination is dead and retrying only burns gateway calls.

**The guardrails are load-bearing, and their cost is reported.**
The 3-attempt cap means 7 transactions worth ₹38,698 are permanently out of
reach — they would only have recovered on a 4th attempt. The report states
that. A rail that never costs anything isn't a rail.

**Value cap scales with the batch.**
Auto-retry value is capped at 60% of the batch's at-risk total, computed at
run start, and counted once per transaction rather than once per attempt —
retrying the same ₹5,000 payment three times doesn't put ₹15,000 at risk,
since only one attempt can succeed. The failure mode it prevents is a runaway
agent retrying a merchant's entire failed volume in one pass, turning a quiet
revenue leak into a live gateway incident. Force it low to watch it engage:

```bash
npm run demo:cap
```

**Everything is auditable.**
Every diagnosis, decision, guardrail trip, dispatch and retry outcome appends
to `data/audit_log.jsonl` — one JSON object per line, ~1,080 events per run.
Plain text, greppable, no service required to read it.

---

## Tests

```bash
npm test
```

Built on `node:test` — no dependencies, no network, no API key. 22 tests
covering the safety rails at both the decision boundary and the outcome
boundary: the full batch runs, and the audit trail is checked to prove
nothing forbidden actually happened.

The suite fails if a risk-blocked or dead-instrument payment is ever
retried, if any transaction exceeds 3 attempts, if the value cap stops
clamping, if the circuit breaker stops opening, if the model's output is
trusted without validation, or if any file outside the scorer reads
`_truth`.

Verified by mutation: each rail was deliberately broken and the suite
caught all nine.

---

## Architecture

Design decisions, the reasoning behind them, and full results:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## Layout

```
src/
  config/taxonomy.js    decline-code map, recovery policies, guardrails
  data/generator.js     synthetic batch + hidden ground truth
  lib/classifier.js     decline code → root cause
  lib/executor.js       root cause → bounded action + guardrails
  lib/actions.js        carries actions out
  lib/simulator.js      retry outcomes + scorer  (only reader of _truth)
  lib/audit.js          append-only JSONL trail
  lib/metrics.js        recovery rates, exception list
  lib/report.js         one serialised run report
  lib/llm.js            LLM fallback + circuit breaker  (unmapped codes only)
  lib/env.js            12-line .env reader, so there are no dependencies
  dashboard/build.js    generates dashboard.html
  index.js              the loop
```

### Commands

| | |
|---|---|
| `npm run seed` | regenerate the batch (`npm run seed 250` for a custom size) |
| `npm start` | run the agent |
| `npm run report` | run + build the dashboard |
| `npm run demo:cap` | force a low value cap to show the rail engaging |
| `npm run exceptions` | print the full exception list |
| `npm start -- --no-llm` | force rules-only, even with a key present |

The batch uses a seeded RNG, so every run reproduces exactly.

---

## Out of scope

Real SMS/WhatsApp delivery (messages are logged), multi-tenant auth, real
payment collection, model training. The recovery layer is built so a real
Razorpay test-mode call slots in where the simulator sits, without the
decision logic changing.
