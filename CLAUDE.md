# RecoverAI — Payment Failure Triage & Recovery Agent

Submission for the **Razorpay AI Buildathon 2026**, Track 03 (AI Revenue Recovery).

---

## Hard constraints

- **Submission deadline: 5 September 2026.** Target submitting **4 September**;
  the 5th is untouched buffer.
- **The submission locks.** One shot, no edits after submitting.
- Deliverables: public GitHub repo + 5-minute pitch video + architecture doc.
- Solo build, ~8 days total.

## What we're building

An agent that ingests a batch of failed Razorpay-style transactions, diagnoses
each failure's root cause, selects and executes a **bounded** recovery action,
and reports **measured money recovered** plus an honest exception list.

Panel one-liner:

> Failed payments are earned revenue that quietly disappears. This agent
> diagnoses why each payment failed, picks a bounded recovery action for that
> specific cause, executes it, and reports what it actually recovered —
> including what it couldn't and why.

## How this is judged

Four criteria. Every design decision should map to at least one:

| Criterion | How we satisfy it |
|---|---|
| **Problem Taste** | Real merchant revenue loss, measured in rupees |
| **Build Quality** | Clean repo, stable execution, full audit trail |
| **AI Judgment** | Rules-first; LLM only where rules genuinely cannot decide |
| **Failure Recovery** | Stopping rules, circuit breaker, graceful LLM fallback |

Track 03's stated bar: *don't just identify the problem — show measured money
recovered across a batch, with compliant escalation, stopping rules, and an
audit trail.*

---

## Non-negotiable design decisions

**1. Rules first. LLM only where it earns its place.**
Decline codes in `src/config/taxonomy.js` map deterministically to root causes.
An LLM call there would add latency and a failure mode for zero benefit.
The LLM handles ONLY unmapped/ambiguous codes and customer-message generation.
This is the single most important decision in the project — do not dilute it by
routing mapped codes through the LLM.

**2. Hidden ground truth makes metrics honest.**
Every synthetic transaction carries a `_truth` block with
`would_recover_on_retry`. **The agent must NEVER read `_truth`.** Only the
scorer reads it. Without this, "money recovered" is self-fulfilling. Current
batch: 180 records, ~71 theoretically recoverable — that's the ceiling.

**3. Unmapped codes exist on purpose.**
~3% of records carry codes absent from the taxonomy
(`ERR_BAL_LOW_RETRY_LATER`, `DEBIT_FAILED_ACCT_BAL`). They model real gateway
variance and give the LLM a genuine, narrow job. Do not "fix" this by adding
them to the taxonomy.

**4. Safety rails are absolute.**
- `RISK_BLOCKED` and `UNKNOWN` → `autoRetry: false`, `maxAttempts: 0`.
  Never auto-retry. Escalate to human, land in exception list.
- `CARD_EXPIRED` / `INVALID_INSTRUMENT` → never retry; the instrument is dead.
- Global caps: 3 attempts per transaction, 2 messages per customer per day.

---

## Architecture

Four-stage loop:

1. **Ingest** — load batch of failed transactions
2. **Diagnose** — decline code → root cause (rules; LLM fallback for unmapped)
3. **Decide & Act** — root cause → bounded recovery action, guardrails enforced
4. **Report** — money recovered, recovery rate by cause, honest exception list

### Root causes
`INSUFFICIENT_FUNDS`, `BANK_DOWNTIME`, `UPI_TIMEOUT`, `MANDATE_INVALID`,
`AUTH_ABANDONED`, `CARD_EXPIRED`, `INVALID_INSTRUMENT`, `RISK_BLOCKED`,
`UNKNOWN`

### Actions
`IMMEDIATE_RETRY`, `RETRY_AFTER_WINDOW`, `SCHEDULED_RETRY`, `REAUTH_LINK`,
`RECOVERY_LINK_ALT_METHOD`, `UPDATE_INSTRUMENT_REQUEST`, `ESCALATE_HUMAN`,
`NO_ACTION`

Nothing outside this action list may ever execute.

## Stack

Node + Express, MongoDB (transactions + audit log), React dashboard,
LLM API for diagnosis fallback and message generation, Razorpay **test-mode**
APIs for retry calls.

Never commit API keys — including test-mode ones.

---

## Current state

**Day 1 complete (28 Aug):**
- `src/config/taxonomy.js` — decline code map, recovery policies, guardrails
- `src/data/generator.js` — synthetic generator with hidden ground truth
- `src/data/seed.js` — writes batch + prints realism report
- Seeded RNG (seed = 42), so batches are reproducible for the demo

```bash
npm run seed        # regenerate batch (180 records)
npm run seed 250    # custom size
```

## Timeline

| Day | Date | Deliverable |
|---|---|---|
| 1 | Aug 28 | ✅ Repo + synthetic data generator |
| 2 | Aug 29 | Rules classifier + one action, end to end, **zero AI** |
| 3 | Aug 30 | All recovery actions + stopping rules |
| 4 | Aug 31 | Audit trail + metrics engine |
| 5 | Sept 1 | LLM layer + circuit breaker |
| 6 | Sept 2 | Dashboard; Hinglish **only if on schedule** |
| 7 | Sept 3 | README, architecture doc, repo public |
| 8 | Sept 4 | Record video, submit |

**Day 2 is the checkpoint that matters.** If the loop isn't running end to end
without AI by end of 29 Aug, cut scope immediately — drop to three root causes.
A narrow system that works completely beats a broad one that half-works.

**Freeze features after Day 6.** Days 7–8 are documentation and video, which
are part of the evaluation, not overhead.

### Stretch (build last, cut first)
Hinglish recovery messages — "Aapka payment fail ho gaya, ye link se dobara try
karein." Isolated module in the message layer so it can be deleted cleanly.

---

## Working agreements

- **Keep `NOTES.md` updated every session.** It becomes the submission form's
  "Build Challenges & Technical Obstacles" answer, which maps to the Failure
  Recovery criterion. Format: what broke → what I tried → what I chose → what I
  traded away.
- Prefer working and narrow over broad and half-finished.
- Every recovery policy carries a `rationale` string — it feeds both the audit
  trail and the video narration.
- When adding a feature, state which of the four judging criteria it serves. If
  none, don't build it.

## Out of scope

Real SMS/WhatsApp delivery (log messages instead), multi-tenant auth, real
payment collection, voice interface, model training. Mention these in the
video's "what I'd build next" close — cut scope framed as judgment scores well.
