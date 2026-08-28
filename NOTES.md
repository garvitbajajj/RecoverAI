# Build Log

> Log every real obstacle here **as it happens**. On 4 September this file
> becomes the "Build Challenges & Technical Obstacles" answer on the
> submission form. That field maps to **Failure Recovery**, one of the four
> scored criteria. Vague answers written from memory on the last day score
> badly; dated, specific ones score well.
>
> Format for each entry: what broke → what you tried → what you chose → what
> you traded away.

---

## Day 1 — 28 Aug

**Obstacle: recovery metrics were going to be self-fulfilling.**
First cut of the generator produced failed transactions with no notion of
whether a retry *should* succeed. That makes "money recovered" meaningless —
the agent retries everything and claims 100%.

Fix: added a hidden `_truth` block per transaction with a
`would_recover_on_retry` flag, drawn from per-cause probabilities
(UPI timeout 61%, insufficient funds 42%, invalid instrument 4%, risk
blocked 0%). The agent never reads `_truth`; only the scorer does. This
gives the batch a real recovery ceiling — currently 71 of 180 — so the
agent's number is earned rather than asserted.

Trade-off: the recoverability probabilities are my modelling assumption,
not observed data. Documented them explicitly rather than hiding them.

**Obstacle: with a complete decline-code lookup table, the LLM had no job.**
Every code mapped deterministically, which made an LLM layer pure decoration —
and "AI Judgment" penalises forced AI.

Fix: seeded ~3% of records with decline codes deliberately absent from the
taxonomy (`ERR_BAL_LOW_RETRY_LATER`, `DEBIT_FAILED_ACCT_BAL`). These model
real gateway variance — new bank error strings appear constantly. The LLM
now has a genuine, narrow job: diagnose codes the rules cannot.

---

## Day 2 — 29 Aug

<!-- checkpoint: end-to-end loop running with ZERO AI -->

**Checkpoint met.** `classifier -> executor -> simulator -> index` runs the
full 180-record batch with no LLM imported anywhere in the path. `_truth` is
read in exactly one file (`simulator.js`).

**Obstacle: the retry-value guardrail was a dead rail.**
`MAX_TOTAL_RETRY_VALUE_PER_RUN` was a flat `500000` paise (Rs 5,000) — a Day-1
placeholder. Against a Rs 6.25L batch it fired on the 9th retry and dumped the
other ~94 eligible txns into the exception list as `RETRY_VALUE_CAP`. "Money
recovered" came out at Rs 2,111 / 1% of the recoverable ceiling — the headline
number for Track 03, rendered meaningless by one bad constant.

What I tried: bumping it to a big flat number (Rs 5L). That just moves the
problem — too low on a large batch, never fires on a small one, so it becomes
decoration and there's nothing to demo.

What I chose: made it **relative** — `MAX_RETRY_VALUE_FRACTION_OF_BATCH: 0.6`.
The runner sums batch at-risk value at start and derives the absolute paise
ceiling, logged in the run header. Added `--cap-value <paise>` to override it
so the rail can be shown engaging live in the pitch video. Rationale comment in
`taxonomy.js` now states the failure mode it exists for: a runaway agent (bad
batch / classifier regression) retrying a merchant's entire failed volume in
one pass, turning a revenue leak into a gateway incident.

Results: default 60% cap -> 103 retries, **53/71 recovered (74.6%), 71.2% of
recoverable value**. `--cap-value 5000` -> ceiling Rs 50, all 103 retries
deferred, `RETRY_VALUE_CAP` x103, exception list holds the whole batch.

What I traded away: `byGuardrail` in the report counts only the *binding*
guardrail per txn — when a message-capped customer's retry is also value-capped,
the event is attributed to `RETRY_VALUE_CAP`, so `MESSAGE_CAP` reads lower under
a tight `--cap-value` (13 vs 23). Actual message behaviour is unaffected
(`messages_sent` is identical). Left it for the Day 4 audit trail, which needs
per-guardrail events tracked independently anyway.

---

## Day 3 + 4 — done early (28 Aug)

Dates in the plan were tentative; 3 and 4 are coupled (the audit trail is what
makes the dispatched actions verifiable) so they were built together.

**Decision: JSONL audit log, not MongoDB.**
The stack listed Mongo. Dropped it. The audit trail is *evidence* — a reviewer
cloning the repo can open `data/audit_log.jsonl` and read exactly what the
agent did and why, with no service to install and no connection to fail. Mongo
would add a dependency, a failure mode, and a demo that breaks on any machine
without an instance running. "Stable execution, full audit trail" is literally
the Build Quality criterion; no criterion rewards using a database. Writer sits
behind an `open/write/close` interface so swapping to Mongo is one file.
Traded away: no query layer, so the Day 6 dashboard reads the JSONL directly.

**Obstacle: stopping rules had nothing to stop.**
Day 2's runner made one pass per transaction, so `maxAttempts` was unreachable
and the "3 attempts" rail was decorative. Root cause was in the ground truth:
`would_recover_on_retry` is a single boolean, so attempts 1, 2 and 3 all return
the same answer — a retry loop was pointless.

Fix: the simulator now also draws WHICH attempt a recovering payment lands on
(55/25/12% for attempts 1–3, 8% at attempt 4+), hashed deterministically from
`transaction_id` so it stays reproducible without touching the generator's
seed. `_truth` reading stays confined to `simulator.js`. This gives the cap
teeth: 7 txns / Rs 38,698 would only have landed on attempt 4 and the rail
means we never see that money. The report states that cost explicitly rather
than quietly missing it.

**Obstacle: the exception list was lying about why payments failed.**
First run filed 21 transactions under `MESSAGE_CAP`. But a suppressed SMS never
blocked a recovery — those were customers sitting on a re-auth link, and the
message cap was incidental. Reason was being taken from "whichever guardrail
bound" instead of "what actually stopped the money".

Fix: exception reasons now derive from the blocking condition — retries
exhausted / escalated / awaiting customer / rail-stopped-pre-attempt —
and `MESSAGE_CAP` is deliberately never a reason. Separately, guardrail trips
are now counted independently (`guardrails_tripped[]`), fixing the Day 2
under-count where a message cap hidden behind a value cap went unreported.

**Result:** 37/71 recovered (52.1%), Rs 90,714, 937 audit events. Of what the
attempt cap leaves reachable: 37/64 = 57.8%.

Also added `.gitignore` + `.env.example` — there was no `.gitignore` at all,
which was a live risk with an API key landing on Day 5.

---

## Dashboard — done early (28 Aug)

**Decision: generated self-contained HTML, not a React app.**
Same reasoning as the JSONL-over-Mongo call, applied consistently. The
dashboard has to survive being opened by someone who just cloned the repo.
React would need `npm install`, a build step and a dev server — three things
that can fail on a judge's machine during evaluation. `src/dashboard/build.js`
reads `data/run_report.json` and inlines it into `dashboard.html`; double-click
and it works, offline, with no dependencies. Also sidesteps `file://` CORS,
which would have blocked a `fetch()`-based version regardless.

Traded away: no live updating and no interactivity beyond scrolling. For a
batch agent whose output is a finished run, that costs nothing.

Added `src/lib/report.js` so the console printer and the dashboard both read
one serialised report object — the numbers cannot drift between surfaces.
Generated artifacts (`dashboard.html`, `run_report.json`, `audit_log.jsonl`)
are gitignored; `npm run report` regenerates all of them.

---

## Day 5 — LLM layer + circuit breaker

Blocked: needs `ANTHROPIC_API_KEY` in `.env` (copy `.env.example`).

---

## Day 6 — 2 Sept

---
