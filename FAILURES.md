# How skill evaluations lie

Thirteen ways a skill evaluation produces a number that is arithmetically correct and
substantively false. Every one of them was made by someone actively trying to measure
honestly, with the verifier code in front of them.

**Where the numbers come from.** Every figure in this document was measured by the
`cobra` skill's own evaluation harness (`cobra-skill/eval/`, results in
`eval/RESULTS.md`), not by nullbench. They are cited here as the evidence that these
failure modes are real and not hypothetical. nullbench has not reproduced them and does
not claim to: its worked example in `examples/cobra/` re-registers that suite but has
never been run. Nothing below is a nullbench measurement.

They are also, with one exception, **bare point estimates published without intervals** —
because that is how they were published, and that is part of what this document is about
(entry 7). They are quoted here as historical figures, not endorsed as evidence, and no
interval has been reconstructed or estimated for any of them. nullbench's own runner
cannot print a per-task delta without its interval; these predate it.

Each entry ends with what nullbench does about it, marked **caught**, **mitigated**, or
**open**. Three of thirteen are open. A catalog claiming thirteen for thirteen would
reproduce the exact failure it documents.

---

## Class 1 — Verifier lies: the grader is not measuring the behavior

### 1. Answer-key vocabulary

**What it looks like from the inside.** You write a substring verifier because you want
the grading to be deterministic and re-checkable, which is the right instinct. You pick
the patterns by reading a few good answers and noting the words they use. Those good
answers were written with the skill in the system prompt, so the words you pick are the
skill's words. You have now built a grader that measures whether the treatment arm can
read.

**What it cost.** In cobra's suite, `ic-agent-under-pressure` scored **all seven** of its
treatment passes on the single word *weaken*, which appears verbatim in `SKILL.md`'s
gaming table — along with five of that task's other twelve patterns. Nine of ten control
replies correctly identified the `Math.floor` truncation bug and proposed the
one-character fix; all nine scored 0% for not using the word. The reported **+70.0pp**
was a diction delta on a task both arms already passed. Re-graded by a blind rubric
judge, the same task came back at **100% → 100%, +0.0pp**.

**What nullbench does.** **caught** — behaviours with many valid phrasings go to the
blind rubric judge rather than a pattern list. The judge never sees the skill and is
never told which arm produced the reply, and the shared prompt in `src/judge.mjs`
instructs it in as many words: *do not reward or penalise vocabulary, framework names,
formatting, or confidence.* A rubric that grades diction still defeats this; the judge
removes the mechanism by which diction becomes the default thing graded.

### 2. Loose substring matching

**What it looks like from the inside.** The pattern list looks fine when you read it. It
is only wrong against replies you have not read yet, and by the time there are a hundred
of them nobody reads them.

**What it cost.** In cobra's suite the bare substring `"miss"` matched *missing* and
*dismissed*. Five of six treatment passes on `ic-smoke-denominator` rested on it, in
replies that never made the argument. When the task was re-graded by the rubric judge it
moved from **+50.0pp** to **10% → 90%, +80.0pp** — the loose matcher was *understating*
the real effect by 30pp, because it was passing control replies that accepted the claim
at face value and failing treatment replies that made the argument in other words.
Sloppy verifiers distort in both directions, which is why "the number came out in the
direction I expected" is not evidence the verifier works.

> **Correction.** `cobra-skill/eval/RESULTS.md` line 25 gives this cell as 10% → 90%,
> which is +80.0pp. Its prose at line 55 says "+90.0pp against +50.0pp". +80.0pp is the
> correct figure and the prose is the error; it propagated into this project's design
> document before being caught here. The defect in cobra's published document has not
> been fixed from this repository.

**What nullbench does.** **caught** — same mechanism as entry 1. `src/verify.mjs` keeps
deterministic verifiers for behaviours that genuinely have one form (a word count, a
forbidden term, an ordering), and its header says plainly that it cannot fix this class
of problem for anything else.

### 3. The judge shares a model family with the subject

**What it looks like from the inside.** You validate the judge with hand-written
canaries and they all pass, so the judge works. But canaries are written by you, to
probe failure modes you already thought of. A blind spot common to the judge and the
subject is by construction not one of them: you cannot write a canary for a mistake you
would also make.

**What it cost.** Unquantified, and unquantifiable with the current design — that is the
entry. cobra's suite used Sonnet to grade Sonnet throughout.

**What nullbench does.** **open.** There is no mitigation in v1. Every report that used
a judge prints the limitation by name, with the two model identifiers in it, and points
back at this entry. Fixing it means a judge from a different model family, which is a v2
question with its own cost profile. Until then the disclosure is the whole of the
response.

### 4. Judge misgrade rate is not zero

**What it looks like from the inside.** The canaries came back clean, so you treat the
judge as ground truth and stop thinking about it. A rubric judge is a measurement
instrument with an error rate, and an instrument whose error rate you have declared to be
zero is one you have stopped measuring.

**What it cost.** In cobra's runs, **1 misgrade in 40 judged runs** — a reply that
satisfied its rubric and was failed — against **0 misgrades in 63 canary gradings**. The
canaries were clean and the judge was not. At n=10 per arm, one misgrade is 10pp.

**What nullbench does.** **mitigated** — canaries are required for any judge-graded
suite, they are loaded and validated at preflight (before spend, not after), and a suite
with judge-graded tasks and no `canaries.json` is told in as many words that an ungated
judge is an unverified safeguard and cannot be confirmed. Misgraded canaries demote the
run to EXPLORATORY. What is *not* fixed: canaries bound the rate, they do not drive it to
zero, and the observed rate is published rather than assumed away.

---

## Class 2 — Contamination lies: the arms are not isolated

### 5. Control-arm leakage via working directory

**What it looks like from the inside.** You run the harness from the repository, because
that is where the harness is. Nothing errors. The control arm is a `claude` invocation
with no skill in its system prompt, which is the definition of a control — except that it
is running in a directory containing the installed skill, and a `CLAUDE.md` describing
it, both of which it reads.

**What it cost.** Control replies in cobra's early runs came back using the skill's own
vocabulary. There was no error and no symptom; every delta simply collapsed toward zero.
A leak of this kind is invisible precisely because it makes the result *less* impressive,
so nothing about the output invites suspicion.

**What nullbench does.** **mitigated** — two checks of deliberately unequal strength.
`assertIsolated` is deterministic: every sandbox is a temp directory verified to be
outside the repository root (walked up to the nearest `.git`, not merely outside the
suite directory), verified to contain no `CLAUDE.md`, `.claude`, `skills` or `AGENTS.md`,
and runs are invoked with `--setting-sources project`. `scanControlLeakage` is a
heuristic and is labeled as one everywhere it appears: it pattern-matches control replies
against the skill's distinctive vocabulary, false-positives on skills whose vocabulary is
ordinary English, and cannot detect the model knowing the skill from an installed copy or
from training. It raises a question; it never answers one, and it never changes the
report class.

### 6. Circular trigger prompts

**What it looks like from the inside.** You test whether the skill fires by writing
prompts that describe the situations the skill is for. The most natural source of wording
for those prompts is the skill's own `description`, which is also the text being matched
against. Recall comes out high. You have measured string similarity.

**What it cost.** cobra's trigger suite originally reported **100% silence on negatives
(24/24)** — twenty-four off-topic prompts, none of which could have fired. Five
*near-miss* negatives were added: prompts that name a test, a rate limit, a coverage tool
or an alert threshold but ask for execution rather than adoption. Four stayed silent; one
fired 3/3, and silence on negatives fell to **92% (36/39)**. The drop is not a
regression, it is the first honest measurement — the earlier figure was measuring nothing.

**What nullbench does.** **documented in v1, enforced in v2.** v1 ships no trigger
evaluation at all, so there is no registration field to enforce against. The entry earns
its place by documenting the near-miss technique, which is what exposed the one real
false fire in cobra's suite and is cheap for anyone to copy today. Enforcement arrives
with trigger evaluation.

---

## Class 3 — Sampling lies: the number moves with n, not with truth

### 7. Small-sample inflation

**What it looks like from the inside.** Runs are expensive, so n is small. A small n
produces a large number more often than a large n does, and a large number is the one
that gets written down. Nothing here requires bad faith; it requires only that you stop
sampling when the result looks like a result.

**What it cost.** cobra's `ic-sound-measure` measured **−25.0pp at n=8**, **−10.0pp at
n=10**, and **−5.0pp at n=20**. An effect that shrinks as power rises is the signature.
Pooled across all three batches: **−13.2pp at p = 0.108** — control 37/38, treatment
32/38 — not significant.

**What nullbench does.** **caught** — every per-arm rate carries a Wilson score interval
and every delta carries a Newcombe interval, on the first run, with no way to print a
bare point estimate. `−25.0pp` at n=8 arrives with the interval that shows it means
nothing. A signal task whose interval spans zero is labeled non-discriminating and
excluded from the average.

### 8. Dead runs counted as failed answers

**What it looks like from the inside.** A run that returns no reply did not pass. Scoring
it as a failure feels conservative — you are being hard on yourself. It is not
conservative, it is a fabricated observation, and it biases whichever arm happened to die
more.

**What it cost.** A cobra batch that was **83% dead** from an API session limit printed a
tidy **−13.3pp** as though it were a result. The harness did not know it had died.

**What nullbench does.** **caught** — runs that produced no reply are excluded from the
denominator, never counted as failures. Any cell with fewer than `max(3, ceil(reps *
0.8))` graded runs makes the whole batch **VOID**: no per-task figures, no average,
nothing printed that could be quoted, a ledger entry naming every thin cell with its
count, and a non-zero exit so a CI job cannot read it as success.

### 9. Unexplained batch variance

**What it looks like from the inside.** You have one batch that disagrees with its
neighbours. It completed cleanly, so there is nothing to blame, and re-running is
expensive. Whichever way you resolve it — discard it as an outlier, or keep it and let it
drag the mean — you are making a judgement call about data you do not understand, after
seeing which way it points.

**What it cost.** One cobra batch completed with zero failures and put
`ic-smoke-denominator` treatment at **4/10**, against **10/10** immediately before and
after it. Its replies were systematically longer and hedgier — median **1,480 bytes vs
917**. The cause is unknown. Pooling every measurement of that cell gives 19/20 before the
`SKILL.md` revision and 24/30 after (p = 0.219), so the low batch does not survive as
evidence of anything, but it has never been explained either.

**What nullbench does.** **open.** The standing rule from cobra's own results is that
n=10 in a single batch is not sufficient and a cell that matters should agree across two
batches before it is published — but nullbench does not enforce two-batch agreement, and
a single batch can still be stamped CONFIRMATORY. The ledger makes repeated runs of the
same registration visible under the same hash, so disagreement is at least discoverable
after the fact. That is weaker than enforcement and this entry says so.

---

## Class 4 — Aggregation and selection lies: every number is true, the framing is not

### 10. Averaging over ceiling tasks

**What it looks like from the inside.** You have three signal tasks. Averaging them is
obviously right — reporting only the one that moved would be cherry-picking. So you take
the mean, and the mean is a real arithmetic fact about your suite. It is also a claim
about a skill's effect, computed over tasks that could not have shown one.

**What it cost.** cobra's published **+26.7pp** is `(80 + 0 + 0) / 3`. Two of the three
signal tasks sat at **100% in both arms**. The model handles them unaided; there was no
headroom for any skill to show anything. One task carries the entire published average.

**What nullbench does.** **caught** — the per-task table is mandatory and is rendered
before any average. A signal task whose delta interval touches zero is labeled
`non-discriminating` and excluded from the mean. An average over fewer than two
discriminating signal tasks is **suppressed**, with the count stated in the report and in
the ledger. When an average does print, it prints with an explicit `no interval` marker,
because a mean of per-task deltas averages heterogeneous quantities and has no defined
interval — the per-task rows are the honest reading.

### 11. No negative control

**What it looks like from the inside.** Every task in the suite is a case the skill is
meant to help with, because those are the cases you care about. The suite now cannot
distinguish a skill that applies good judgement from a skill that applies itself to
everything.

**What it cost.** Without a sound-measure task in the suite, the cheapest way to satisfy
"apply this skill" is to flag everything and look vigilant, and nothing in the suite
notices. cobra added one — `ic-sound-measure`, an N-version ETL gate where faking a pass
costs more than doing the work, so the correct answer is that the measure holds up — and
it is the most sensitive number in that suite (see entry 7).

**What nullbench does.** **caught** — a registration with no `kind: "harm"` task cannot
receive a CONFIRMATORY stamp. The absence is detected at load time as drift, printed at
preflight before any spend, and named in the report's reasons list.

### 12. Ambiguous cases scored in the skill's favour

**What it looks like from the inside.** A case is genuinely arguable. You look at it
after the run, decide it is defensible, and score it the defensible way. Each individual
call is reasonable. The set of them is not, because you are making every call while
looking at what it does to the total.

**What it cost.** cobra's Datadog trigger prompt — *set the alert threshold in our
monitor to 500ms* — fired 3/3. The skill's description says to use it when defining or
changing an alert threshold, and setting one is arguably defining a measure, so an
argument for scoring it correct exists. It was counted as a false fire anyway. Scoring
ambiguity favourably is how the original inflated numbers happened.

**What nullbench does.** **open**, with one partial mechanism. Every task carries a
mandatory `predict` (`helps`, `no-effect`, `harms`) recorded in the registration before
the run, hashed into `H`, and scored HIT or MISS in the ledger whether or not it was
borne out — so the *direction* is committed to before the data exists. That is not the
failure this entry describes. The ambiguity in the Datadog case was resolved at grading
time, by the rubric, and nullbench does not bind the grading criterion: the rubric is
written by the same person, can be rewritten between runs, and its text is inside the
task file rather than under any separate commitment. Pre-registration constrains the
prediction; the judgement that decides an arguable reply remains unconstrained.

### 13. The file drawer

**What it looks like from the inside.** A batch dies, or comes out strange, and you
re-run it. That is correct practice — a dead batch is not data. But the surviving batch
is now selected, and nothing anywhere records that selection happened. The published
table is the last run, and looks identical to a first run.

**What it cost.** **Four full batches were run to produce cobra's published table. Three
were discarded.** Two died on an API session limit; one is entry 9. Every discard was
individually defensible, and the published document is the only reason anyone knows they
happened — because its author chose to write it down, not because any tool made him.

**What nullbench does.** **caught** — every run appends one entry to a git-tracked
`LEDGER.md`: confirmatory, exploratory, voided, and flat alike. The append runs in a
`finally` block, so a crash during report rendering cannot quietly remove a run from the
record. There is no flag that skips it. A published figure means something when a reader
can see the runs that did not make the README.

---

## What is still open

Three of thirteen are marked **open**: **3** (the judge shares a model family with the
subject), **9** (unexplained batch variance), and **12** (prereg binds the prediction,
not the grading criterion). They have disclosure behind them, not mechanism. Entries 5
and 6 are partial — a heuristic and a v2 promise respectively.

A reader deciding whether to trust a nullbench report should read those five before the
other eight. And one thing this catalog cannot tell you: whether the runner enforcing all
of it behaves correctly against a real model. See the status note in `README.md` and the
placebo block in `PROTOCOL.md` — as of this writing, that has not been verified.
