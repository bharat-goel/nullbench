# The nullbench protocol

Normative. This document defines the registration format, the canonicalization and
hashing rules, the three report classes and their exact conditions, the graded-run floor,
the ledger format, and the interval methods. The runner in `src/` implements it; where
the two disagree, that is a bug in one of them and worth reporting.

Version: nullbench 0.1.0. Node >= 22, zero dependencies.

---

## Placebo status

**VERIFIED on a local model — both arms pass. Never run against a hosted model.**

```
Last verified:            2026-09-18
Model:                    google/gemma-4-12b-qat, local, via tools/local-claude.mjs
Placebo interval:         +0.0pp [-27.8pp, +27.8pp] over 40 graded runs — spans zero,
                          as required
Known-positive interval:  +100.0pp [+60.7pp, +100.0pp] over 40 graded runs — excludes
                          zero, as required
Dead runs:                0 in either arm
```

An irrelevant skill (ISO-8601 date formatting, measured against reasoning tasks) produced
an interval spanning zero. A mechanically detectable skill ("answer in exactly three
bullets", deterministically verified) produced 0/10 control against 10/10 treatment. Both
runs were CONFIRMATORY.

Verified by `npm run verify:live` in a single invocation: **2 tests, 2 passed**, 48.5
minutes. The intervals above are byte-identical to an earlier pair of separate per-arm
runs, so they reproduce across invocations rather than being one lucky batch.

One caveat remains, and it is not a small one:

- **This is one 12B local model.** It establishes that the runner can separate signal from
  noise on that model. It says nothing about a hosted model. The cobra worked example in
  `examples/cobra/` — which detected `+80.0pp [+37.0pp, +91.6pp]` against a matched control
  on Sonnet — is separate evidence, not a second bracket.

Reproducing this requires `NULLBENCH_LIVE_CONCURRENCY=1`: at the runner's default of 4,
LM Studio drops connections and the batch comes back VOID. See `test/live/README.md`.

**What that means for every other number nullbench prints.** The bracket is the guarantee
that the runner does not manufacture effects. Its placebo arm is a well-written skill
irrelevant to the tasks it is measured against; the runner must report an interval that
spans zero. Its known-positive arm is a skill that mechanically changes output shape
("answer in exactly three bullets"), deterministically verified; the runner must report an
interval strictly above zero. One without the other proves nothing — a harness that always
reports null passes the placebo test perfectly, which is why the placebo arm alone was
never enough. Both arms have now run and passed (above), so the claim that this runner can
tell a real effect from noise rests on the bracket itself, not only on the cobra worked
example — which remains separate evidence: it did detect a large effect
(`+80.0pp [+37.0pp, +91.6pp]`) with a matched control, but is not a purpose-built positive
control with a mechanically guaranteed answer. The protocol logic is additionally tested
end to end against a stub (148 offline tests, no network, no API key); the stub is not a
model.

**What it costs.** 80 CLI invocations — 40 per fixture, being 2 tasks x 2 arms x 10 reps,
with no judge calls because both fixtures use deterministic verifiers. This figure is
confirmed by `--dry-run` against both fixtures, not estimated. At the tool's default
placeholder of $0.02/call that prints as roughly $1.60; the real cost depends on actual
pricing and reply length, and `--cost-per-call` overrides the placeholder.

This block is pinned here rather than in a changelog because a stale guarantee should
look stale. When the bracket is run, replace this block with the date, the nullbench
version, the model, and both observed intervals — and not before. If the date above is
old, treat it as unverified; if it says `never`, it *is* unverified.

---

## 1. The registration file

A `nullbench.json` committed to the repository **before** the run.

```json
{
  "model": "sonnet",
  "judge_model": "sonnet",
  "reps": 10,
  "tasks": [
    {
      "id": "ic-smoke-denominator",
      "file": "tasks/ic-smoke-denominator.json",
      "sha256": "9462c53f314475c81ffc8f58281b64fb4ce10a2b4b8b164d0d58ef972b8a0b90",
      "kind": "signal",
      "predict": "helps"
    }
  ]
}
```

| Field | Type | Rule |
|---|---|---|
| `model` | non-empty string | the subject model, passed to `claude --model` |
| `judge_model` | non-empty string | the rubric judge's model |
| `reps` | integer >= 1 | runs per arm per task |
| `tasks` | non-empty array | one entry per task; `id` must be unique |
| `tasks[].id` | non-empty string | stable identifier, used everywhere in output |
| `tasks[].file` | string | path to the task file, relative to the registration's directory |
| `tasks[].sha256` | 64 hex characters | the declared hash of that file's bytes |
| `tasks[].kind` | `signal` \| `harm` | what the task is for |
| `tasks[].predict` | `helps` \| `no-effect` \| `harms` | mandatory, recorded whether or not it is borne out |

JSON rather than TOML because Node ships no TOML parser — TOML would cost this project
its only runtime dependency — and, more importantly, because the hash in §3 requires a
reproducible canonical serialization. JSON has one. TOML does not.

### 1.1 Task files

A task file is JSON carrying at least `id`, `prompt`, and `verify`. It may carry
`rationale` (prose, not read by the runner) and `fixture` (a directory name, resolved
relative to the registration's directory, copied fresh into the sandbox for every run).

`verify` is one of four shapes:

| `type` | Fields | Passes when |
|---|---|---|
| `any` | `patterns[]` | any pattern appears (case-insensitive substring) |
| `none` | `patterns[]` | no pattern appears |
| `ordered` | `before[]`, `after[]` | an un-negated `before` appears, and no un-negated `after` precedes it |
| `judge` | `rubric` | the blind rubric judge returns `VERDICT: PASS` |

Any shape may add `maxWords`, enforced before the pattern check. `ordered` looks back at
most 45 characters and never past a sentence boundary for a negation cue, so a negation in
a preceding sentence does not suppress the following clause.

Substring verifiers are dangerous, and this protocol cannot make them safe. Use them only
for behaviours with one form — a word count, a forbidden term, an ordering. Everything
else belongs in the judge. See `FAILURES.md` entries 1 and 2 for what the alternative
costs.

### 1.2 Structural failure vs drift

Two kinds of problem, handled differently on purpose.

**Structural** — the registration cannot be executed at all: no `nullbench.json`,
malformed JSON, a missing or mistyped field, a bad enum, a duplicate id, a task file that
does not exist or is not JSON, a `--task` naming an unregistered id, a missing
`SKILL.md`, a malformed `canaries.json`, or a `--resume` that §10 refuses. The runner
prints the problems and exits **2**. Nothing is spent.

**Drift** — the registration can be executed but not *confirmed*: a task file whose bytes
no longer match its declared `sha256` (`HASH_MISMATCH`), or a suite with no `harm` task
(`NO_HARM_TASK`). The run proceeds and is classed EXPLORATORY. Drift is printed at
preflight, before any spend.

Collapsing these two would either block exploratory work, which is a legitimate and
necessary phase, or let a changed task pass as confirmed, which is the thing this project
exists to stop.

### 1.3 Canaries

A suite with any judge-graded task should ship `canaries.json` beside the registration:

```json
{ "<task-id>": [ { "label": "obvious-pass", "reply": "...", "expect": "PASS" } ] }
```

Every top-level key is a task id and must name a registered, judge-graded task — a stray
`_comment` key is a structural failure. Canaries carry only a label, a reply, and the
expected verdict; the prompt and rubric come from the registered task itself. A canary
that supplied its own copy of the rubric would keep passing after the task's rubric
changed, certifying a judge against text no task uses — which is exactly an unverified
safeguard.

Canaries are loaded and validated at preflight, before the confirmation prompt, so a
malformed file costs nothing. They are *run* only after confirmation. A judge-graded
suite with no `canaries.json` is not a structural failure: it is the explicitly un-gated
state, reported as such and unable to be confirmed.

---

## 2. Canonicalization

An RFC 8785 subset, sufficient for hashing and implemented in `src/canonical.mjs`:

1. Object keys are sorted by code unit; no insignificant whitespace anywhere.
2. Strings and finite numbers serialize as `JSON.stringify` produces them.
3. Arrays preserve order.
4. `null`, `true`, `false` serialize literally.
5. **Any value with no canonical form throws rather than serializes** — `NaN`,
   `Infinity`, `undefined`, functions, symbols. `JSON.stringify` drops or coerces these,
   which would let two different registrations hash identically.

The point of 1 and 5 together: a formatter run over `nullbench.json` must not move the
hash, and two genuinely different registrations must not share one.

---

## 3. The registration hash

```
H = sha256(canonical({
      model, judge_model, reps,
      skill_sha256,
      tasks: [ { id, kind, predict, sha256 } ]
    }))
```

with `tasks` sorted by `id`, and each `sha256` being the hash of **the task file's bytes
as found on disk at run time** — not the value declared in the registration.
`skill_sha256` is the hash of the injected skill file's bytes, likewise as found at run
time, or `null` when no skill file is present.

`H` is stamped into the report header and every ledger entry, abbreviated to its first 16
hex characters for display.

Two properties follow, and both are deliberate:

- **`file` paths are excluded.** Moving a task file or reorganizing directories does not
  change the identity of the experiment. Content, kind, prediction and id do.
- **Actual bytes, not declared hashes.** `H` names what really ran. Editing a task file
  changes `H` even if the declared `sha256` was updated to match. The
  declared-vs-actual disagreement is reported separately as `HASH_MISMATCH` drift, and
  that is what demotes the run to EXPLORATORY.
- **The skill is covered.** It is the experiment's independent variable — the only thing
  that differs between the arms — so a hash that omitted it would let the thing under
  test be edited, or swapped wholesale via `--skill`, while the stamp stayed identical.
  An earlier version of this protocol did omit it. A `--skill` override is additionally
  recorded as a named reason and demotes the run to EXPLORATORY, so a reader can tell a
  substituted skill from a merely edited one.

(The design document specified a concatenation over the whole registration file; §5.2
there was amended to this formula on 2026-09-17, with the reasoning above.)

---

## 4. Report classes

Exactly three. Every run produces exactly one.

### CONFIRMATORY

All six conditions hold:

1. Every task file's bytes match its registered `sha256`.
2. The task set that ran is exactly the registered set — no additions, and no filtering
   with `--task`.
3. `reps`, `model` and `judge_model` match the registration (`--reps`, `--model` and
   `--judge-model` override them and therefore break this condition).
4. At least one `kind: "harm"` task is present.
5. Judge canaries passed, if any task that ran is judge-graded. A judged suite with no
   `canaries.json` fails this condition.
6. No cell fell below the graded-run floor (§5).

Exit 0.

**A CONFIRMATORY stamp does not imply a printed average.** A run can satisfy all six
conditions and still have its mean suppressed by the discrimination rule in §5. That is
the intended behaviour, not a contradiction — it is the behaviour the project exists for.

### EXPLORATORY

Conditions 1-5 not all met; condition 6 met. The report still prints, still lands in the
ledger, and is stamped at the top with the **specific** conditions that failed, one line
each. Per-task figures are shown in full. **The average across signal tasks is
suppressed**, unconditionally, with the reason given as "this run is exploratory".
Exit 0.

Exploratory runs are legitimate and expected. Finding a task that discriminates requires
iteration, and the protocol does not prevent iteration. It prevents an iterated result
from being reported as a confirmed one.

### VOID

Condition 6 failed: at least one cell has too few graded runs to mean anything. This is a
data problem rather than a registration problem, and it takes precedence — a batch that is
both drifted and 83% dead is VOID, because the registration question is moot when there is
no data to classify.

**No per-task figures and no average are reported.** The report stops after the header and
the reasons list; there is no table, and there is no `n/a` cell, because there is no table
to put one in. What a reader needs is still printed: the reasons list names every thin
cell as `task "<id>" <arm>: <k> graded runs, <n> required`, and the same reasons are
written into the ledger entry. The run appends to the ledger like any other. **Exit 1.**

---

## 5. Statistics

### 5.1 The graded-run floor

A run that produced no reply is **excluded from the denominator**, never counted as a
failed answer. Counting a dead run as a failure fabricates an observation and biases
whichever arm happened to die more — `FAILURES.md` entry 8.

This applies to the judge exactly as it applies to the subject. A judge call that never
returned a grade — non-zero exit, or empty output — leaves that run ungraded; a judge
rate-limit partway through a batch must void it, not drive both arms to 0% and print a
tidy null. A judge that *answered* without a parseable `VERDICT:` line is a different
case: it answered, the answer was unusable, and that is a graded FAIL inside the
denominator.

A cell (one task, one arm) must have at least

```
floor = max(3, ceil(reps * 0.8))
```

graded runs. Any cell below it voids the whole batch. At `reps: 10` the floor is 8.

### 5.2 Intervals

**Per-arm pass rates carry a Wilson score interval at 95%** (Wilson 1927). Wilson rather
than the normal approximation because it stays inside `[0, 1]` and remains sane at `k=0`
and `k=n` — exactly the cells a ceiling task produces, and the cells that matter most
here.

**Deltas carry a Newcombe interval** (Newcombe 1998, method 10): take each arm's Wilson
interval and square-and-add the distances to the relevant bounds,

```
lo = (pT - pC) - sqrt( (pT - tLo)^2 + (cHi - pC)^2 )
hi = (pT - pC) + sqrt( (tHi - pT)^2 + (pC - cLo)^2 )
```

Chosen over a Wald interval on the difference for the same reason: it does not collapse to
zero width when an arm sits at 0% or 100%.

**The runner never emits a bare point estimate. Every delta printed anywhere carries its
interval.** The one exception is the suite average, and it is marked — see §5.4.

### 5.3 Discrimination

A signal task whose delta interval **touches zero** is labeled `non-discriminating` and
excluded from the average, with the exclusion stated in the report and in the ledger.
Zero itself counts as touching: a bound of exactly `0.0` is not evidence of an effect.

A non-discriminating result is a finding, not a failure. It usually means the task has no
headroom — both arms at ceiling — which is information about the task, not about the
skill.

### 5.4 The average

An average over **fewer than two discriminating signal tasks is suppressed**, and the
report says how many of how many discriminated. The motivating case is cobra's published
`+26.7pp`: a mean of three per-task deltas, two of which were exactly zero because those
tasks sat at 100% in both arms. See `FAILURES.md` entry 10.

When an average does print, it prints with an explicit **`no interval`** marker and a
pointer back to the per-task rows. A mean of per-task deltas averages heterogeneous
quantities and has no defined interval; printing one would be inventing a number.

### 5.5 Rendering

Percentages render with one decimal and an explicit sign: `+80.0pp`, `-5.0pp`, `+0.0pp`.
Pass rates render as whole percents with their `k/n` beside them.

---

## 6. The ledger

Every run appends one entry to a git-tracked `LEDGER.md` beside the registration —
confirmatory, exploratory, voided, and flat alike. There is no flag that skips the append,
and the append runs in a `finally` block so a crash during report rendering cannot quietly
remove a run from the record.

This is the anti-file-drawer mechanism. A published figure means something when a reader
can see the runs that did not make the README.

```
## <ISO 8601 UTC timestamp> · <CLASS> · H=<first 16 hex of H>
```
```
model=<model> judge=<judge_model> reps=<reps>
<task-id>            <kind>  predict=<predict>  <k>/<n> -> <k>/<n>   <delta>pp [<lo>pp, <hi>pp]  <HIT|MISS>[  (non-discriminating)]
...
average across signal tasks: suppressed — <reason>
note: <each reason and warning, one per line>
```

A prediction scores **HIT** when the observed interval agrees with what was declared:
`helps` needs an interval entirely above zero, `harms` entirely below, `no-effect` an
interval that spans zero. A MISS is recorded and published exactly like a HIT. That is
the point of declaring it.

A VOID entry has no task rows and no average line — only the header, the config line, and
the `note:` lines naming the thin cells.

A resumed run (§10) is its own entry, appended like any other; the entry it resumes is
never edited. Its header ends `· resumes <earlier stamp>`, and two lines follow the config
line:

```
resume: of=<stamp resumed> origin=<first stamp in the chain> reattempted=<n> canaries=re-run
contributing: <stamp> (<k> graded), <stamp> (<k> graded), ...
```

If the resumed run was killed before it could write its own entry, a `note:` line says
so, and its graded runs are recorded here instead.

---

## 7. Isolation

Every invocation — each arm, each rep, each task — gets its own temp directory outside
the repository, created with `mkdtemp` immediately before the call, invoked with
`--setting-sources project`, and removed immediately after. One sandbox per run, not one
per task and not one per batch: a directory shared across runs makes the check below
point-in-time, so anything a run creates afterwards is visible to every later run in the
other arm, with no error and no change of class.

The subject is additionally invoked with `--disallowedTools Write,Edit,Bash`. No verifier
reads anything but stdout, so the subject has no reason to touch its cwd, and an artifact
it leaves behind can only ever be a contamination vector. The judge is not restricted; it
runs in the same per-run sandbox, which is destroyed with the run.

Before each run, the sandbox is checked:

- it must not be inside the repository root (found by walking up from the registration
  directory to the nearest `.git`, so a suite living in a subdirectory of a larger repo is
  still protected from that whole repo);
- it must not contain `CLAUDE.md`, `.claude`, `skills`, or `AGENTS.md`.

A failed check aborts the whole batch, not the one task: a sandbox that fails it means
the environment is wrong, and every run in flight shares that environment.

A fixture is copied fresh for every run and is checked by the same rule; a fixture
carrying any of those four entries is refused outright rather than inspected, because it
is indistinguishable by inspection from real leakage.

Treatment differs from control in exactly one respect: `SKILL.md` is appended to the
system prompt. Nothing else.

After the run, control replies are scanned for the skill's distinctive vocabulary. This
is a **heuristic warning only** — it never changes the report class, it false-positives on
skills whose vocabulary is ordinary English, and it cannot detect the model knowing the
skill from an installed copy or from training. `FAILURES.md` entry 5.

---

## 8. Cost preflight

Before spending anything, the runner prints the registration hash, the model and reps, the
planned subject runs (`tasks x 2 x reps`), the planned judge calls, the canary runs, the
total invocations, and an estimated spend at an assumed per-call price, then waits for
confirmation.

- `--dry-run` prints the preflight and exits 0, having written nothing and created no
  `results/` directory.
- `--yes` skips the prompt.
- `--cost-per-call <usd>` overrides the assumed price, which is a placeholder and not a
  quote.

Drift is printed here too, before the prompt, so that "this run cannot be confirmatory"
is known before it is paid for.

---

## 9. Exit codes

| Code | Meaning |
|---|---|
| 0 | the run completed and was classed CONFIRMATORY or EXPLORATORY; or `--dry-run`; or the operator declined at the prompt |
| 1 | VOID, or an unhandled error during reporting |
| 2 | structural failure — the registration could not be executed, or a `--resume` was refused; nothing was spent |

---

## 10. Resuming an interrupted batch

A batch interrupted partway through — a plan's session limit, an API outage, a killed
process — is VOID or incomplete, and before this section existed the only remedy was to
re-run all of it. `--task` cannot split a batch, because a filtered run is EXPLORATORY by
§4 condition 2 and stays that way. `--resume <stamp>` finishes the batch instead.

```bash
node bin/nullbench.mjs ./my-suite --resume 2026-09-24T18:02:11Z
```

`<stamp>` is the earlier run's stamp, its `results/` directory name, or a path to its
`records.json`. The requested config (model, judge model, reps, task set, skill override)
defaults to that run's, not the registration's.

### 10.1 What is re-attempted

**Only runs that produced no answer.** A cell is re-attempted when its record is
`failed: true` — the subject or the judge never answered: a non-zero exit, empty output,
a session limit — or when it has no record at all because the process died before
reaching it. **A graded run is never re-attempted, pass or fail**, including a judge reply
with no parseable verdict, which §5.1 counts as a graded FAIL. Re-running graded cells
until the number looks good is the file drawer (`FAILURES.md` entry 13).

Graded records are carried forward byte-for-byte, each tagged with the stamp of the run
that produced it. The superseded dead records are listed under `reattempted` in the new
`records.json`, not dropped.

### 10.2 What is refused

Each of these exits 2 and spends nothing:

- **A different registration hash `H`.** Any change to a task file, `SKILL.md`, or
  `model`/`judge_model`/`reps` in `nullbench.json` moves `H` (§3), and the refusal names
  what changed. Updating a task's declared `sha256` to match does not help: `H` is over
  the bytes on disk.
- **A different requested config** — model, judge model, reps, task set, or skill
  override — even where `H` would allow it, because the carried records were produced
  under the earlier one.
- **A run that has already been resumed.** Resuming the same run twice would draw its
  dead cells twice and let the second draw replace the first. Resume the resume instead;
  the chain may be as long as needed.
- **A run with nothing to re-attempt.**

### 10.3 Canaries

**The whole canary set is re-run on every resume. Nothing is carried forward as a pass.**
The re-attempted cells are graded by a new judge session, which has to be validated on its
own; the carried cells were graded by the earlier session, whose canary result still
stands. So condition 5 of §4 holds for the combined batch only when:

- the fresh canary run is clean;
- no run in the chain misgraded a canary — `canaries.json` is not part of `H`, and without
  this rule a resume would let an author fix a failing canary file and wash the misgrade
  out of the batch;
- every run that contributed a judge-graded record also recorded a canary result.

A canary call that merely never answered in an earlier run does not count against it — a
dead call is not a misgrade, and the fresh set re-checks it. The report states which rule
applied and names any carried misgrade by stamp.

### 10.4 Classification and reporting

§4 and §5 apply to the **combined** records, unchanged. A resume that leaves any cell below
the floor is VOID, and can itself be resumed. A resume that satisfies all six conditions
is CONFIRMATORY; being resumed is not in itself a reason to demote, because every graded
observation in it was made once, under the registered experiment.

Every report of a resumed batch, VOID included, opens with a **Resumed batch** section
naming every stamp that contributed records and how many graded runs each contributed.
The ledger entry is described in §6.

### 10.5 Checkpointing

`records.json` is a checkpoint, not a summary. It is written before anything is spent and
rewritten atomically after every record, carrying `complete: false` until the run ends.
A process killed mid-batch runs no `finally` and so writes no ledger entry, but every run
graded before the kill is on disk, and `--resume` accepts the incomplete checkpoint. The
resume's own ledger entry records that the earlier run never completed.

There is no `--batch-size`: a checkpoint after every record makes one redundant.

---

## References

- Wilson, E. B. (1927). "Probable Inference, the Law of Succession, and Statistical
  Inference." *Journal of the American Statistical Association* 22(158), 209-212.
- Newcombe, R. G. (1998). "Interval estimation for the difference between independent
  proportions: comparison of eleven methods." *Statistics in Medicine* 17(8), 873-890 —
  method 10.
- RFC 8785, *JSON Canonicalization Scheme (JCS)* — a subset, per §2.
- Further attribution, including the paired design and the pre-registration framing, is in
  `ATTRIBUTION.md`.
