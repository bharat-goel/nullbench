# nullbench — design

- **Date:** 2026-09-14
- **Status:** approved design, not yet planned
- **Author:** Bharat Goel (with Claude)
- **Next step:** implementation plan via `superpowers:writing-plans`

---

## 1. Problem

Claude skills are published in volume and measured almost never. The few evaluations
that exist report a single headline delta, and that number is easy to produce
dishonestly without anyone lying on purpose.

This is not hypothetical. The `cobra` skill was published with an evaluation, and that
evaluation was wrong the first time. It reported **+40.0pp**. Re-measurement under a
blind rubric judge put it at **+26.7pp**, and the largest single contributor to the
original figure turned out to be a task where both arms already passed and treatment
was scoring on a word copied out of `SKILL.md`. Four full batches were run to produce
the published table; three were discarded.

Every one of those mistakes was made by someone actively trying to measure honestly,
with the verifier code in front of them. That is the problem worth solving: the
failure modes are not obvious from the inside, and the tooling does nothing to surface
them.

## 2. What this is

**nullbench** is a pre-registration protocol for skill evaluation, a published catalog
of the ways such evaluations lie, and a runner that enforces the protocol.

The contribution is the protocol and the catalog. The runner is how they get adopted.

### What it is not

- Not a task authoring tool. Writing a task that discriminates is the hard part and
  nullbench does not solve it. It makes a non-discriminating task *visible* instead of
  letting it be absorbed into an average.
- Not a general LLM eval framework. Scope is Claude skills via the `claude` CLI.
- Not a leaderboard, a web UI, or a CI action.

### Why a runner at all

The protocol could be a document. It is shipped as a runner because the enforcement
points — hashing, report classing, the ledger append, interval reporting — are exactly
the steps a person under deadline pressure skips. A protocol that depends on
discipline measures discipline.

## 3. Prior art and positioning

- **SkillsBench** (arXiv 2602.12670) established paired conditions, deterministic
  verifiers, and deltas in percentage points, and found 16 of 84 tasks got *worse*
  with skills. nullbench adopts its experimental design wholesale. The name is
  deliberately distinct to avoid implying a relationship.
- **Clinical/social-science pre-registration** (OSF, AsPredicted) is the direct source
  of the confirmatory/exploratory split and the file-drawer framing. This is a
  straight port of an existing idea into a new domain, and the README will say so.
- **`cobra-skill/eval/`** is the working ancestor. `run.mjs` already implements paired
  conditions, blind rubric judging, harm tasks, dead-run exclusion, and batch voiding.
  nullbench generalizes it and adds the protocol layer on top.

Attribution for all three goes in `ATTRIBUTION.md`, following the convention already
established in `cobra-skill`.

## 4. Naming

`nullbench`. Verified available on npm as of 2026-09-14. Chosen because the thing the
protocol protects is the null result — the run that showed nothing and would otherwise
never be published.

Rejected: `skillbench` (taken on npm at v2.1.1, and collides with the SkillsBench
paper), `prereg` (available, but squats a general academic term).

## 5. The protocol

### 5.1 Pre-registration file

A `nullbench.json` committed to the repository before the run:

```json
{
  "model": "sonnet",
  "judge_model": "sonnet",
  "reps": 10,
  "tasks": [
    {
      "id": "ic-smoke-denominator",
      "file": "bench/tasks/ic-smoke-denominator.json",
      "sha256": "a3f1...",
      "kind": "signal",
      "predict": "helps"
    }
  ]
}
```

JSON rather than TOML: Node ships no TOML parser, so TOML would cost this project its
only runtime dependency — and more importantly, the registration hash in 5.2 requires a
reproducible canonical serialization. JSON has one (RFC 8785). TOML does not.

Rules:

- `sha256` is the hash of the task file's bytes.
- At least one `kind = "harm"` task is required. A suite with no negative control
  cannot receive a CONFIRMATORY stamp, because without one the cheapest way to satisfy
  any skill's evaluation is to fire on everything.
- `predict` is mandatory per task and is recorded whether or not it is borne out.

### 5.2 Registration hash

On run, the runner computes a hash over a **canonical projection** of the registration
and stamps it into the report and the ledger:

```
H = sha256(canonical({
      model, judge_model, reps,
      tasks: [ { id, kind, predict, sha256: <hash of the task file as found on disk> } ]
    }))
```

with `tasks` sorted by `id`. Canonicalization follows RFC 8785 (sorted keys, no
insignificant whitespace) and is defined in `PROTOCOL.md` so the hash is reproducible
across formatters.

> **Amended 2026-09-17** (implementation diverged; the implementation is authoritative
> here). This section previously specified
> `H = sha256(canonical(nullbench.json) || sha256(task_1) || ... || sha256(task_n))` —
> a hash over the whole registration file plus the task bytes. Task 3 implemented the
> projection above instead, and the projection is the better design for two reasons.
> First, it **excludes `file` paths**, so moving a task file or reorganizing directories
> does not change the identity of the experiment; only the task's content, kind,
> prediction and id do. Second, it hashes the **actual** file bytes rather than the
> `sha256` value declared in `nullbench.json`, so `H` names what really ran rather than
> what the registration claimed ran — a tampered task file changes `H` even if someone
> also updated the declared hash to match. A reformatted registration hashes
> identically; a changed task never does. Declared-vs-actual disagreement is reported
> separately, as `HASH_MISMATCH` drift, which is what demotes a run to EXPLORATORY.

### 5.3 Report classes

**CONFIRMATORY** — every one of the following holds:

1. Every task file hash matches its registered `sha256`.
2. The task set that ran is exactly the registered set — no additions, no filtering
   via `--task`.
3. `reps`, `model`, and `judge_model` match the registration.
4. At least one `harm` task is present.
5. Judge canaries passed, if any task is judge-graded.
6. No cell fell below the graded-run threshold (see 5.5).

**EXPLORATORY** — conditions 1-5 not all met. The report still prints, still lands in
the ledger, and is stamped at the top with the specific conditions that failed. **The
average across signal tasks is suppressed**; per-task figures are still shown.

**VOID** — condition 6 failed: at least one cell has too few graded runs to mean
anything. Distinct from EXPLORATORY, because the problem is the data rather than the
registration. No per-task figures and no average are reported, the ledger records the
void with the graded-run counts, and the process exits non-zero.

A CONFIRMATORY stamp does not imply a printed average. A run can satisfy all six
conditions and still have its mean suppressed by the discrimination rule in 5.5 —
that is the intended behaviour, not a contradiction, and success criterion 1 depends
on it.

Exploratory runs are legitimate and expected — finding a discriminating task requires
iteration. The protocol does not prevent iteration. It prevents an iterated result
from being reported as a confirmed one.

### 5.4 The ledger

Every run appends one entry to a git-tracked `LEDGER.md`, with no path that skips the
append — including voided runs, exploratory runs, and runs whose deltas came out flat.

```
## 2026-09-14T18:22:07Z · CONFIRMATORY · H=a3f1c2...
model=sonnet reps=10 runs=60
ic-smoke-denominator  signal  predict=helps      10% -> 90%   +80.0pp [95% CI +37.0, +91.6]  HIT
ic-clock-exclusion    signal  predict=helps     100% -> 100%   +0.0pp [95% CI -27.8, +27.8]  MISS (ceiling, both arms)
ic-noop-routine       harm    predict=no-effect 100% -> 100%   +0.0pp [95% CI -27.8, +27.8]  HIT
average across signal tasks: suppressed — 1 of 2 signal tasks non-discriminating
```

Interval figures above are real, computed from the cobra cells they name. They double
as reference values for the stats tests in §8.

This is the anti-file-drawer mechanism. A published figure means something when a
reader can see the runs that did not make the README.

### 5.5 Statistics

- Per-arm pass rates carry a Wilson score interval at 95%.
- The delta carries a Newcombe interval. The runner never emits a bare point estimate;
  every delta printed anywhere carries its interval.
- A cell with fewer than `max(3, ceil(reps * 0.8))` graded runs voids the batch, and a
  voided batch reports no per-task figures at all. Runs that produced no reply are
  excluded from the denominator, never counted as failed answers.

  > **Amended 2026-09-17** (internal contradiction resolved in favour of §5.3). This
  > bullet previously said a thin cell "reports `n/a`", which contradicts §5.3's rule
  > that a VOID run reports no per-task figures and no average. The implementation
  > follows §5.3: `classify` returns VOID before any aggregation, and `renderReport`
  > returns immediately after the header and the reasons list, before either table is
  > rendered. There is no `n/a` cell anywhere in the output, because there is no table
  > to put one in. What a reader needs in order to see what died is still printed: the
  > **reasons list** names every thin cell as `task "<id>" <arm>: <k> graded runs, <n>
  > required`, and the same reasons are written into the **ledger entry** for that run.
  > A VOID run still appends to the ledger and still exits non-zero.
- A signal task whose delta interval spans zero is labeled **non-discriminating** and
  excluded from the average, with the exclusion stated in the report.
- An average over fewer than two discriminating signal tasks is suppressed. `+26.7pp`
  computed as `(80 + 0 + 0) / 3` is the motivating case.

### 5.6 Cost preflight

Before spending anything, print planned invocations (`tasks x 2 x reps`), planned judge
calls, and an estimated spend, then wait for confirmation. `--yes` skips the prompt.

## 6. The failure catalog (`FAILURES.md`)

Thirteen entries in four classes. Each entry states the lie, what it looks like from
the inside, the real numbers from the `cobra` runs, and nullbench's mitigation marked
**caught**, **mitigated**, or **open**.

### Class 1 — Verifier lies: the grader is not measuring the behavior

1. **Answer-key vocabulary.** `ic-agent-under-pressure` scored all seven treatment
   passes on the single word *weaken*, which appears verbatim in `SKILL.md`. Nine of
   ten control replies correctly found the `Math.floor` truncation bug and were scored
   0% for not using the word. The reported +70.0pp was a diction delta on a task both
   arms already passed. → **caught**: blind rubric judge; rubrics must explicitly
   refuse credit for vocabulary.
2. **Loose substring matching.** `"miss"` matched *missing* and *dismissed*. Re-grading
   `ic-smoke-denominator` moved it from +50.0pp to **+90.0pp** — the loose matcher was
   passing control replies that accepted the claim at face value and failing treatment
   replies that made the argument in other words. Sloppy verifiers distort in both
   directions. → **caught**.
3. **The judge shares a model family with the subject.** A blind spot common to both
   cannot appear in hand-written canaries. → **open**, disclosed in every report.
4. **Judge misgrade rate is not zero.** 1 misgrade in 40 judged runs, against 0 in 63
   canary gradings. → **mitigated**: canaries required for judge-graded suites; the
   observed rate is published rather than assumed to be zero.

### Class 2 — Contamination lies: the arms are not isolated

5. **Control-arm leakage via working directory.** Running in the repo root let the
   control arm read the skills off disk and inherit the parent `CLAUDE.md` describing
   them. Control replies came back using the skill's own vocabulary, silently
   collapsing every delta toward zero. → **mitigated**: enforced temp directory outside
   the repo plus `--setting-sources project`, and a pre-run leakage probe. The probe is
   weak (see §9) and is labeled as such.
6. **Circular trigger prompts.** Prompts phrased with wording lifted from the skill's
   own `description` test nothing. → **documented in v1, enforced in v2**:
   v1 ships no trigger evaluation (§10), so there is no prereg field to enforce yet.
   The catalog entry still earns its place by documenting the near-miss negative
   technique — a prompt that names a test, rate limit or coverage tool but asks for
   execution rather than adoption — which is what exposed the one real false fire in
   the cobra suite. Enforcement arrives with trigger evaluation.

### Class 3 — Sampling lies: the number moves with n, not with truth

7. **Small-sample inflation.** `ic-sound-measure` measured −25.0pp at n=8, −10.0pp at
   n=10, and −5.0pp at n=20. An effect that shrinks as power rises is the signature.
   Pooled across batches: −13.2pp at p=0.108, not significant. → **caught**: intervals
   make it visible on the first run.
8. **Dead runs counted as failed answers.** A batch that was 83% dead from an API
   session limit printed a tidy **−13.3pp** as though it were a result. → **caught**:
   exclusion from the denominator, `n/a` cells, batch void, non-zero exit.
9. **Unexplained batch variance.** One batch completed cleanly with zero failures and
   put `ic-smoke-denominator` treatment at 4/10, against 10/10 immediately before and
   after. Its replies were systematically longer and hedgier (median 1,480 vs 917
   bytes). The cause is unknown. → **open**: two-batch agreement required before a cell
   is published; the entry says plainly that this is unexplained.

### Class 4 — Aggregation and selection lies: every number is true, the framing is not

10. **Averaging over ceiling tasks.** `+26.7pp` is `(80 + 0 + 0) / 3`. Two of three
    signal tasks sat at 100% in both arms and had no headroom to show anything. →
    **caught**: per-task table mandatory, non-discriminating tasks flagged and excluded
    from the mean, mean suppressed below two discriminating tasks.
11. **No negative control.** Without a sound measure in the suite, the cheapest way to
    satisfy "apply this skill" is to flag everything and look vigilant, and nothing in
    the suite notices. → **caught**: CONFIRMATORY requires at least one `harm` task.
12. **Ambiguous cases scored in the skill's favour.** The Datadog trigger prompt is
    genuinely arguable — setting an alert threshold is defining a measure — and was
    counted as a false fire anyway. Scoring ambiguity favourably is how the original
    inflated numbers happened. → **mitigated**: prereg forces the call before the run.
13. **The file drawer.** Three of four batches were discarded to produce the published
    table. → **caught**: the ledger.

Three of thirteen are marked open. A catalog claiming thirteen for thirteen would
reproduce the exact failure it documents.

## 7. Repository layout

```
nullbench/
  README.md              leads with the retraction: +40.0pp -> +26.7pp, and why
  FAILURES.md            the catalog (§6)
  PROTOCOL.md            prereg format, canonicalization, hashing, classes, ledger
  ATTRIBUTION.md         SkillsBench, OSF/AsPredicted, cobra-skill/eval
  LICENSE
  src/
    prereg.mjs           parse, validate, canonicalize, hash
    runner.mjs           paired execution, sandboxing, concurrency
    verify.mjs           pattern verifiers + blind judge
    stats.mjs            Wilson, Newcombe, discrimination test
    ledger.mjs           append-only ledger writer
    report.mjs           report classing and rendering
    cli.mjs              cost preflight, flags
  test/
    fixtures/replay/     recorded CLI outputs, replayed offline
    fixtures/skills/     placebo and known-positive skills
  examples/cobra/        cobra's suite as the worked example, with its real ledger
```

`cobra-skill` keeps its own `eval/` unchanged and gains a README note pointing here.
The dependency does not run in that direction: published cobra numbers must not move
because a tool changed.

## 8. Testing

### Offline, in CI, zero spend

A stub `claude` executable on `PATH` replays recorded outputs from
`test/fixtures/replay/`.

- **Tamper test** — register a suite, modify a task file, run. Must stamp EXPLORATORY
  and suppress the average.
- **Filter test** — register three tasks, run with `--task` selecting one. Must stamp
  EXPLORATORY.
- **File-drawer test** — force a voided batch. Must still append to `LEDGER.md`.
- **Ceiling test** — replay a suite at 100% in both arms. Must flag non-discriminating
  rather than report +0.0pp as a finding.
- **Missing-harm test** — register a suite with no `harm` task. Must refuse
  CONFIRMATORY.
- **Dead-run test** — replay the 83%-dead batch. Must void, not print −13.3pp.
- **Stats tests** — Wilson and Newcombe intervals against published reference values.

### Live, manual, real spend (`npm run verify:live`)

- **Placebo skill.** A well-written skill irrelevant to the suite's tasks. nullbench
  must report a null. If a placebo produces a positive delta, the harness manufactures
  effects and nothing else it reports is worth anything. This is the single most
  important test in the repository.
- **Known-positive skill.** A skill with a trivially detectable effect ("answer in
  exactly three bullets"), deterministically verified. Must be detected. Guards against
  a harness that reports null for everything, which would pass the placebo test
  perfectly.

The two bracket the runner: one shows it can find nothing, the other shows it can find
something.

## 9. Open risks

1. **The placebo guarantee goes stale.** The most important test costs money and will
   run rarely. Mitigation is disclosure, not prevention: `PROTOCOL.md` pins the last
   placebo result with its date and the version it ran against, so a stale guarantee
   at least looks stale.
2. **The leakage probe is weak.** One probe, pattern-matched against the skill's
   vocabulary. It false-positives on skills whose vocabulary is ordinary English, and
   it cannot detect the model knowing the skill from its installed copy or from
   training. Shipped with that limitation stated in `FAILURES.md` entry 5 rather than
   presented as a solved problem.
3. **`stream-json` coupling.** Trigger detection depends on parsing a `tool_use` event
   naming the Skill tool — an internal surface with no compatibility promise. v1 does
   not ship trigger evaluation, so v1 does not carry this risk. It returns with v2.
4. **Audience size is unverified.** The population of people who write Claude skills
   *and* will fund a multi-hundred-invocation evaluation is small and has not been
   measured. The catalog and the README are readable and useful to a much larger group
   than the runner is, which is why they ship in v1 rather than after it.
5. **The runner inherits `cobra-skill`'s judge design**, including the shared-model-
   family blind spot. Fixing it means a judge from a different family, which is a v2
   question with its own cost profile.

## 10. Scope

### v1

Pre-registration file and validation; registration hashing; CONFIRMATORY/EXPLORATORY
classing; the ledger; Wilson and Newcombe intervals with the discrimination test;
cost preflight; paired content evaluation ported from `run.mjs`; blind rubric judge
with required canaries; the offline test suite; the two live tests; `FAILURES.md`;
`PROTOCOL.md`; `README.md`; `examples/cobra/`.

### v2 and later

Trigger evaluation; `nullbench init` scaffolding; cross-model comparison; a
cross-family judge; any provider other than the `claude` CLI.

### Deferred, decided 2026-09-14

Amending `cobra-skill`'s README to reflect a suppressed average. Success criterion 1
implies the current `+26.7pp` headline should change, but that is a separate task in a
separate repository and is not a v1 blocker. nullbench v1 ships with
`examples/cobra/` demonstrating the suppression; what cobra's README says about it is
decided afterwards.

### Explicitly never

Leaderboards, a hosted service, a web UI, a score that collapses a suite to one number.

## 11. Success criteria

1. `examples/cobra/` reproduces the published **per-task** deltas (+80.0pp, +0.0pp,
   +0.0pp) under a CONFIRMATORY stamp, flags the two ceiling tasks as
   non-discriminating, and therefore **declines to print the `+26.7pp` average that is
   currently published**. The protocol's first act is to withdraw its own author's
   headline figure.
2. The placebo skill returns a null whose interval spans zero.
3. The known-positive skill is detected with an interval excluding zero.
4. Every offline test passes with zero API spend.
5. `FAILURES.md` stands on its own as a document worth reading by someone who never
   installs the tool.

Criterion 1 is the one that matters. A protocol whose first act is to suppress its own
author's headline figure is the only version of this project worth publishing.
