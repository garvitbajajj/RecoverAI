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

---

## Day 3 — 30 Aug

---

## Day 4 — 31 Aug

---

## Day 5 — 1 Sept

---

## Day 6 — 2 Sept

---
