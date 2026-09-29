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
end to end against a stub (138 offline tests, no network, no API key); the stub is not a
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
| `skill_dir` | optional, non-empty string | relative to the registration's directory; when present, the skill under test is that whole directory rather than a single `SKILL.md` (§1.4) |
| `h_version` | optional, `1` \| `2` | which registration-hash formula applies; absent means `1`. `2` also covers fixture contents and `canaries.json` (§3.1) |

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
`SKILL.md`, or a malformed `canaries.json`. The runner prints the problems and exits
**2**. Nothing is spent.

**Drift** — the registration can be executed but not *confirmed*: a task file whose bytes
no longer match its declared `sha256` (`HASH_MISMATCH`), or a suite with no `harm` task
(`NO_HARM_TASK`). The run proceeds and is classed EXPLORATORY. Drift is printed at
preflight, before any spend.

Collapsing these two would either block exploratory work, which is a legitimate and
necessary phase, or let a changed task pass as confirmed, which is the thing this project
exists to stop.

### 1.3 Canaries

A suite with any judge-graded task should ship `canaries.json` beside the registration
(covered by `H` only under `"h_version": 2` — §3.1):

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

**Which canaries failed is kept, not only how many.** Every canary the judge misgraded is
named, with the expected verdict, the judge's verdict, and the judge's stated reason, in the
report (every class, VOID included), as a `canary misgraded:` line in the ledger entry, and
whole under `canary` in `records.json`, along with any canary call that never answered. A
count alone cannot say whether the judge erred strict or lenient, or on which rubric, and
recovering that would mean paying for the canaries again. (An audit lost exactly this from
three paid runs before it was recorded.)

### 1.4 `skill_dir`

A real Claude Code skill is often more than one file: `SKILL.md` plus a `references/` or
`guidelines/` directory the skill instructs the model to read on demand. Measuring only
`SKILL.md` when the content actually being graded lives in those other files understates
or misstates what the skill does. `skill_dir` names that whole directory instead of a
single file.

When `skill_dir` is present, the path is relative to the registration's directory, and
`<skill_dir>/SKILL.md` must exist. The path itself is checked before anything else, each
condition its own structural failure:

- must not be absolute;
- must not contain a `..` segment;
- must not be `"."` (or empty) — it names a subdirectory, not the registration directory
  itself;
- must resolve to a strict subdirectory of the registration directory (catches spellings
  like `"sub/.."` that the checks above don't, and anything else that would put the
  resolved path at or outside the registration directory);
- must not contain, anywhere inside it, `nullbench.json`, `canaries.json`, `results/`
  (this suite's own run-output directory — every earlier run's raw subject and judge
  replies), `LEDGER.md` (every earlier run's summary, predictions included), or any
  registered task's file — each of those holds content (a verifier's patterns, a
  canary's known-PASS replies, a prior judge verdict, a prior run's exact pass/fail
  pattern) that PATTERN_IN_SKILL and the leakage scan exist to keep out of the
  treatment sandbox, and copying `skill_dir` wholesale would hand it over regardless of
  what those checks catch afterward;
- must not be inside, equal to, or contain any declared fixture directory, checked in
  **both** directions. A fixture is copied into every arm's sandbox, control included
  (§7) — a `skill_dir` reachable through one would put `SKILL.md` and every reference
  file into the control arm too, not only treatment's. That is control-arm
  contamination (§7, FAILURES.md entry 5) reached through the fixture path instead of
  the repository root, and a suite with no pattern-verified task gives PATTERN_IN_SKILL
  nothing to catch it with. All comparisons above are by real path (`realpathSync`),
  resolving symlinks and on-disk casing rather than the resolved-string alone, so a
  case-insensitive filesystem's own alias of a protected path or fixture — or an
  intermediate symlink standing in for one of `skill_dir`'s own path components — can't
  pass as a clean, unrelated directory.

**Only the treatment arm ever sees it.** The whole
directory is copied fresh into that run's own sandbox at `<sandbox>/skill/` — the name is
singular, and deliberately not one of `assertIsolated`'s forbidden names (§7). The system
prompt gets exactly one line prepended to `SKILL.md`'s own text, mirroring what Claude
Code itself prints when a skill loads:

```
Base directory for this skill: <absolute path of <sandbox>/skill>

<SKILL.md's own text>
```

Only `SKILL.md`'s text is injected into the prompt. Every other file in `skill_dir` is
present on disk for the model to read on demand, exactly as a real skill installation
works, and exactly as never happens in the control arm, whose sandbox contains none of
it. A fixture that itself carries a top-level `skill` entry collides with this copy and
is refused as a structural failure (§1.2), the same posture as `assertIsolated`'s check
but a separate one — that check also runs against the treatment sandbox this project
itself builds, and `skill/` belongs there.

A symlink anywhere in `skill_dir` — including the root itself — is refused as a
structural failure rather than followed or ignored: it can point outside the directory
entirely, which would make both the sandbox copy and the manifest hash below name
something other than what a reader of `skill_dir` actually sees. (A symlinked root is
not a theoretical case: `cpSync` copies it AS a symlink, so `<sandbox>/skill` would point
straight back at the original location outside the sandbox.) The same posture applies to
anything in the tree that is neither a file nor a directory — a FIFO, socket, or device
node — refused by `lstat` classification alone, before anything ever tries to open and
read it. And `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude` or `skills` anywhere
inside `skill_dir`, at any depth, and compared **case-insensitively** — `claude.md` and
`Claude.MD` are refused exactly like `CLAUDE.md` itself, since a plain string match
against whatever casing a directory entry happens to have on disk is not the same
guarantee a case-insensitive filesystem's own lookups give elsewhere — are refused the
same way `assertIsolated` refuses them at a sandbox's top level (§7) — Claude Code
itself loads a nested `CLAUDE.md` or `.claude` when working in a subdirectory, so "top
level only" is not a safe boundary for a directory copied in
wholesale. Unlike `assertIsolated`'s sandbox/fixture check (§7), `skills` here has no
SKILL.md exception: this is the skill under test being copied into the treatment
sandbox as `skill/`, not a fixture that happens to have an unrelated `skills/` path in
it, so a nested `skills` entry is refused unconditionally regardless of what it holds.

Once `skill_dir`'s root has been confirmed to exist, any further problem reading it — a
walk error, or a single unreadable file among otherwise-good ones — is also a structural
failure rather than a silent `null` hash. A registration whose H doesn't move when a file
becomes unreadable would look exactly as confirmable as one where nothing changed; only
the root being entirely absent still resolves to `null`, on the same footing as a missing
single-file `SKILL.md`, because that is the CLI's own existence check to report.

Absent `skill_dir`, behaviour is byte-identical to a suite that has never heard of it: a
single `SKILL.md` beside the registration, injected exactly as before.

**Known gap, disclosed rather than fixed here:** `H` is computed once, at load, from
whatever is on disk at that moment — but the skill (single file or directory) is
re-read from the live path on every run, not snapshotted once at preflight. Nothing
stops the files changing between preflight and the last run in the batch, which would
mean different runs in the same batch saw different bytes under one `H`. This is
pre-existing behaviour for a single `SKILL.md` (skill_dir does not make it worse, only
gives it more surface area) and is not fixed by this feature; closing it would mean
copying a snapshot once at preflight and running every arm/rep against that copy
instead of the live path.

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

`skill_sha256` depends on whether the registration has `skill_dir` (§1.4):

- **Absent**: the sha256 of the single injected `SKILL.md`'s bytes, as found on disk at
  run time — unchanged from before `skill_dir` existed, so a registration that has never
  heard of it hashes exactly as it always did.
- **Present**: the sha256 of `canonical(manifest)`, where `manifest` is a JSON array of
  `{ path, sha256 }` — one entry per file anywhere in `skill_dir`, `path` a POSIX-relative
  path from `skill_dir`'s root — over **every file in the directory**, not only
  `SKILL.md`. Editing any reference file moves `H`; rewriting one with the exact same
  bytes (a no-op reformat) does not, since the manifest hashes bytes, not mtimes or a
  formatter's opinion.

  **The array is sorted by the full `path` string, as plain code-unit comparison, after
  the whole directory has been walked** — not by whatever order a depth-first walk with
  a per-directory sort happens to visit files in. Those two are NOT the same ordering:
  walking `a/` before its sibling file `a-b` (because the directory NAME `"a"` sorts
  before the file name `"a-b"` at the level where they're actually siblings) visits
  `a/x` before `a-b`, but sorting the full paths puts `"a-b"` first — `-` is code point
  45, `/` is code point 47, so `"a-"` sorts before `"a/"`. An implementation that sorts
  only within each directory during the walk, instead of sorting the complete path list
  once afterward, produces a different `H` for the same directory contents. This is the
  same code-unit ordering §2 uses for object keys.

  **Not covered by the manifest, and therefore not by `H`:** empty directories, and file
  modes/permissions. A directory that contains nothing is invisible to a manifest built
  over files; a file's executable bit or other mode changing without its bytes changing
  moves nothing. Both are copied into the sandbox exactly as found — this is a disclosed
  gap in what `H` names, not a claim that either is impossible to change unnoticed.

Either way, `null` when no skill is present at all — a structural failure the CLI
rejects before spending anything, and hashing it as a distinct value keeps "no skill"
from colliding with any real one. Once `skill_dir`'s root is confirmed to exist, any
*other* problem reading it (see §1.4) is a structural failure, never a silent `null`.

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

### 3.1 `h_version` 2: fixtures and canaries

The formula above is **version 1**, and it does not cover two things a run depends on:

- **Fixture contents.** A fixture is copied into *both* arms' sandboxes. Only its declared
  *name* is in `H` (through the task file's bytes); its files are not. A fixture could be
  edited after freezing — including one that changes what the control arm can see — with
  `H` unchanged.
- **`canaries.json`.** The canary set is what certifies the judge. It could be edited after
  freezing — say, relabelled to match how the judge actually behaved — with `H` unchanged.

A registration opts into the stronger hash with `"h_version": 2` in `nullbench.json`:

```
H = sha256(canonical({
      model, judge_model, reps, skill_sha256,
      tasks: [ { id, kind, predict, sha256 } ],
      h_version: 2,
      fixtures: [ { name, sha256 } ],     // each distinct declared fixture, sorted by name
      canaries_sha256                     // sha256 of canaries.json's bytes, or null if absent
    }))
```

Each fixture's `sha256` is taken over a manifest built the same way as a `skill_dir`'s
(§3 above): one `{ path, sha256 }` per regular file, sorted by full path after the walk.
A symlink inside a fixture is recorded as `{ path, symlink: <target> }` rather than
refused, because the sandbox receives the link itself. As with `skill_dir`, empty
directories and file modes are not covered.

**Why opt-in, not a change to version 1.** Folding these into the default formula would
move `H` for every existing registration that has a fixture or a canary file, including
ones whose runs are already published and ledgered under that `H`. A frozen `H` that
changes when the tool is upgraded stops proving anything. So version 1 stays
byte-identical, absent `h_version` means 1, and a v1 registration that has a fixture or
`canaries.json` gets a preflight note saying what its `H` does not cover. **New
registrations should declare `"h_version": 2`.** Any other value is a structural failure.

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

**No per-task figures and no average are reported.** The report stops after the header,
the reasons list, and — when any canary was misgraded or never answered — the list of which
ones (§1.3); there is no table, and there is no `n/a` cell, because there is no table
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
model=<model> judge=<judge_model> reps=<reps>[ backend=<path>]
<task-id>            <kind>  predict=<predict>  <k>/<n> -> <k>/<n>   <delta>pp [<lo>pp, <hi>pp]  <HIT|MISS>[  (non-discriminating)]
...
average across signal tasks: suppressed — <reason>
note: <each reason and warning, one per line>
canary misgraded: <task-id>:<label> (expected <PASS|FAIL>, judge said <PASS|FAIL>)
```

`backend=` appears only when `NULLBENCH_CLAUDE_BIN` replaced the hosted `claude` CLI. The
model names on that line are the *registered* ones; with an override, nothing verifies that
the model that answered is the one named. The report header carries the same note, and
`records.json` records it as `requested.backend`. Without it, the 2026-09-18 bracket runs —
answered by a local 12B model through an adapter — were ledgered as `model=sonnet`.

A prediction scores **HIT** when the observed interval agrees with what was declared:
`helps` needs an interval entirely above zero, `harms` entirely below, `no-effect` an
interval that spans zero. A MISS is recorded and published exactly like a HIT. That is
the point of declaring it.

A VOID entry has no task rows and no average line — only the header, the config line, and
the `note:` lines naming the thin cells.

---

## 7. Isolation

Every invocation — each arm, each rep, each task — gets its own temp directory outside
the repository, created with `mkdtemp` immediately before the call, invoked with
`--setting-sources project`, and removed immediately after. One sandbox per run, not one
per task and not one per batch: a directory shared across runs makes the check below
point-in-time, so anything a run creates afterwards is visible to every later run in the
other arm, with no error and no change of class.

The subject is invoked with no tool-restriction flags at all -- `src/claude.mjs` carries
`SUBJECT_DISALLOWED_TOOLS` unused, deliberately. Its comment explains why an earlier
review recommended denying Write/Edit/Bash and this project didn't: cobra's
`ic-agent-under-pressure` task hands the model a real failing test suite and grades
whether it finds the bug, which *wants* those tools, and cobra's own published numbers
were measured with no tool restriction, so an explicit deny list here would make the
worked example non-comparable to the figures it exists to reproduce.

It turns out not to matter either way, and this is worth stating plainly: headless mode
itself already refuses any tool that would need interactive approval, before it runs,
regardless of what the subject is invoked with. `-p` with `--setting-sources project` and
no project settings present gives the CLI's own permission system nothing to approve
against, so Write/Edit/Bash are refused by that system, not by a flag. The consequence is
the same as if they'd been explicitly denied: **a skill whose method depends on running a
script is measured here without that script ever running.** If a skill's SKILL.md tells
the model to invoke a helper program, the treatment arm reads that instruction and cannot
act on it; the measured effect is whatever the instruction achieves through the model's
own reasoning alone, not through the tool it names. A skill this project cannot measure
fairly is exactly a skill whose value depends on that gap.

The judge is not tool-restricted, but it never shares the subject's sandbox: it gets its
own freshly `mkdtemp`'d, isolation-checked directory per call, destroyed immediately
after. A shared sandbox would let an unrestricted judge invocation read whatever the
subject's treatment run left behind -- in particular a directory skill's `skill/` copy --
straight off disk, which is the exact channel the "never sees the skill" guarantee below
exists to close.

Before each run, the sandbox is checked:

- it must not be inside the repository root (found by walking up from the registration
  directory to the nearest `.git`, so a suite living in a subdirectory of a larger repo is
  still protected from that whole repo);
- it must not contain `CLAUDE.md`, `CLAUDE.local.md`, `.claude`, or `AGENTS.md`;
- it must not contain a top-level `skills` entry that has a file named `SKILL.md`
  (checked case-insensitively, at any depth beneath it) — Claude Code loads project
  skills from `.claude/skills`, never from a top-level `skills/`, so a `skills/` tree
  with no `SKILL.md` anywhere beneath it holds no skill and is allowed. A `skills` entry
  that is not a directory, or that cannot be read, is refused unconditionally rather than
  assumed clean.

A failed check aborts the whole batch, not the one task: a sandbox that fails it means
the environment is wrong, and every run in flight shares that environment.

A fixture is copied fresh for every run and is checked by the same rule; a fixture
carrying `CLAUDE.md`, `CLAUDE.local.md`, `.claude`, `AGENTS.md`, or a `skills/` entry
that holds a `SKILL.md`, is refused outright rather than inspected, because it is
indistinguishable by inspection from real leakage. Unlike the sandbox check above, which
only runs once the batch is already under way, a declared fixture is also checked at
**preflight** (including `--dry-run`): the CLI copies the fixture's own contents to a
throwaway directory and runs this same check on it before any canary or subject call, so
a fixture that would be refused fails structurally (exit 2) before anything is spent,
rather than aborting mid-batch after the judge canaries for that run have already been
paid for.

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
| 2 | structural failure — the registration could not be executed, nothing was spent |

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
