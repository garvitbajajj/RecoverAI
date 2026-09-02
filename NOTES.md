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

## LLM layer + circuit breaker — 28 Aug

**Decision: Gemini free tier, called over raw REST.**
No Anthropic free tier exists, and the job here is 5 records per batch — any
free tier is orders of magnitude more headroom than needed. Chose Gemini
(no credit card, generous limits). Deliberately did NOT install
`@google/generative-ai` or `dotenv`: Node 22 has native `fetch`, and a
12-line `.env` reader covers the rest. The repo's zero-install promise is
worth more than the convenience, and the provider request shape is isolated
in one function so swapping vendors is a single edit.

**Obstacle: an LLM layer is a new way for the demo to die.**
A bad key or a rate limit mid-recording would mean 180 slow timeouts, and the
whole pitch rests on the run completing.

Fix, three parts. (1) Output constrained to the existing root-cause enum —
off-list answers are discarded, so the model can propose a cause but never
invent one and never pick an action. (2) Circuit breaker opens after 3
consecutive provider failures; later calls short-circuit with no network
call. (3) The fallback is a *correct outcome*, not an error path: unmapped
codes stay UNKNOWN and escalate to a human, which is exactly what the agent
did before the LLM existed.

That third point is the design win. **The LLM is pure upside — it can add
recoveries, it can never break a run.** Verified all three degraded paths:
no key, `--no-llm`, and a deliberately invalid key. Recovery is identical at
37/71 in every case; with a bad key the breaker opens after 3 failures and
short-circuits the remaining 2 calls.

**Obstacle: live key, and three separate failures stacked on each other.**
First real run with a key: 3 provider failures, breaker opened, 0 diagnosed.

1. `gemini-2.5-flash` returns 404 — retired for new accounts. Google's error
   names the replacement, but my own 160-char error truncation cut the message
   mid-sentence and hid it. Self-inflicted: raised the limit to 400 chars.
   A diagnostic that truncates the diagnosis is worse than none.
2. Full Flash models were returning 503 (free-tier capacity). That's transient
   and was being counted as a hard failure, tripping the breaker on a spike
   and throwing away recoveries. Added bounded retry (2 attempts, 400/1200ms
   backoff) for 429/5xx only; 4xx still fails fast, since it never self-heals.
3. Defaulted to `gemini-flash-lite-latest` — a `-latest` alias so the default
   can't rot the way the pinned id did, and Lite because the job is picking
   one label off a nine-item list, while the full Flash models are the ones
   that actually run out of free capacity.

**Obstacle: with the LLM finally working, recovery got WORSE — 37 -> 30.**
Adding a working feature dropped the headline number. `RETRY_VALUE_CAP` trips
jumped 24 -> 41: the 5 newly-diagnosed records consumed retry budget and
displaced other transactions past the ceiling.

Root cause was not the LLM. `retryValueSoFar += txn.amount` ran on *every
attempt*, so a Rs 5,000 payment retried 3 times consumed Rs 15,000 of a cap
that is defined as a fraction of batch at-risk *value*. Only one attempt can
ever succeed, so that triple-counted exposure and made a "60%" ceiling behave
like ~20%. Now counted once, on first attempt; attempt volume is already
bounded separately by `MAX_ATTEMPTS_PER_TRANSACTION`.

The LLM was never the problem — it surfaced a guardrail bug that had been
silently suppressing recoveries since the cap was introduced.

**Result:** 50/71 (70.4%), Rs 1,37,932, 78.1% of what the attempt cap leaves
reachable. Rules alone: 47. The LLM's 5 calls add 3 recoveries — real,
measured upside. `--cap-value` still forces the value rail on demand
(79 trips at Rs 50,000), so it stays demonstrable.

Traded away: the value cap no longer binds on this batch at its default 60%.
That is honest — the batch's eligible retry value genuinely sits under the
ceiling — and the rail is still provably live via `npm run demo:cap`.

---

## Tests + clean-clone verification — 31 Aug / 3 Sept

**Obstacle: the safety rails were only ever verified by me reading output.**
Every claim about the rails rested on runs I had eyeballed. That does not
survive a refactor and a judge cannot reproduce it.

Fix: 22 tests on `node:test` — no dependencies, no network, no key. Rails are
asserted at two boundaries: `decide()` as a pure function, and the audit trail
after a real batch run, because a rail can be correct in the decision function
and still be bypassed by a wiring bug in the runner.

**Obstacle: a test that cannot fail is decorative.**
Broke each rail deliberately and re-ran the suite. The first sweep reported
MISSED on the attempt cap. Two causes: raising the *global* cap changes
nothing, since `decide()` takes `min(policy, global)` and no per-cause policy
exceeds 3 — the global cap is a backstop that never binds. And my test read
its expected value from the config it was testing, so it would have passed at
any setting including 99. Now asserted literally, with a separate check that
no per-cause policy exceeds it. Nine mutations, all caught.

Traded away: no coverage of the dashboard or the report formatter. They are
presentation, and a wrong number there is visible; a broken rail is not.

**Clean-clone verification (3 Sept).** Everything until now had been tested in
my working directory, which has a `.env`, a seeded batch and generated
artifacts. A judge clones into an empty folder. That exact path had never been
run — the single highest-risk unknown in the project.

Cloned fresh from GitHub with no key present and ran the full sequence:
`npm install` (0 dependencies), `npm run seed` (180 records, 71 ceiling),
`npm start` (47/71, 66.2%, correctly reporting "rules only, zero AI" and
degrading to escalation with no key), `npm test` (22/22), `npm run report`
(self-contained dashboard). All green. No `.env` in the repo.

---

## Day 6 — 2 Sept

---
