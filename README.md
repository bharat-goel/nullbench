# nullbench

**Pre-registration for skill evaluations.** Declare your tasks, reps and per-task
predictions before you run; get a report that states plainly whether it measured what you
registered — and withholds the numbers it cannot stand behind.

Here is the tool refusing to print its own author's headline figure:

```
# nullbench report — CONFIRMATORY

| Task                      | Predicted | Control      | Treatment    | Delta   | 95% CI             |                    |
|---------------------------|-----------|--------------|--------------|---------|--------------------|--------------------|
| `ic-agent-under-pressure` | helps     |  90% (9/10)  | 100% (10/10) | +10.0pp | [-18.9pp, +40.4pp] | non-discriminating |
| `ic-clock-exclusion`      | helps     | 100% (10/10) | 100% (10/10) |  +0.0pp | [-27.8pp, +27.8pp] | non-discriminating |
| `ic-smoke-denominator`    | helps     |  10% (1/10)  |  90% (9/10)  | +80.0pp | [+37.0pp, +91.6pp] |                    |

Average across signal tasks: suppressed — 1 of 3 signal tasks discriminate;
an average over fewer than two is not a finding.
```

The published figure for that suite is **+26.7pp**. It is the mean of those three deltas,
two of which come from tasks pinned at ceiling in both arms. nullbench declines to compute
it. Two of the three `helps` predictions were scored **MISS**, because they were committed
before the run and turned out to be wrong.

## Quick start

Node >= 22, zero dependencies. Not on npm yet — clone and run `node bin/nullbench.mjs`.

```bash
node bin/nullbench.mjs ./my-suite --dry-run   # preflight: costs nothing, writes nothing
node bin/nullbench.mjs ./my-suite             # preflight, confirm, run
```

A suite is a `SKILL.md`, a `tasks/` directory, and a registration naming every task with
its content hash, its kind, and a prediction:

```json
{
  "model": "sonnet", "judge_model": "sonnet", "reps": 10,
  "tasks": [
    { "id": "my-task", "file": "tasks/my-task.json", "sha256": "…",
      "kind": "signal", "predict": "helps" },
    { "id": "my-control", "file": "tasks/my-control.json", "sha256": "…",
      "kind": "harm", "predict": "no-effect" }
  ]
}
```

At least one `harm` task is required for a CONFIRMATORY stamp. Without a negative control,
the cheapest way for any skill to pass its own evaluation is to fire on everything.

If a batch dies partway through — a plan's session limit is the usual cause — resume it
instead of paying for all of it again:

```bash
node bin/nullbench.mjs ./my-suite --resume 2026-09-24T18:02:11Z
```

Only the runs that produced no answer are re-attempted; every graded run, pass or fail, is
carried forward unchanged. The resume is refused if a task file, `SKILL.md` or
`nullbench.json` changed, or if the model, judge model or reps differ. The canaries are
re-run in full, the ledger gets a separate entry linked to the original, and the report
names every run that contributed records. `records.json` is checkpointed after every
record, so a killed process loses nothing it had already graded. Rules:
[`PROTOCOL.md` §10](PROTOCOL.md#10-resuming-an-interrupted-batch).

A worked example is in [`examples/cobra/`](examples/cobra/). Full field reference,
canonicalization, hash construction and the interval methods: [`PROTOCOL.md`](PROTOCOL.md).

## Why this exists

A skill I published came with an evaluation. The evaluation was wrong.

It reported **+40.0pp**. Re-measurement under a blind rubric judge put it at +26.7pp, and
the reason was not a typo: the largest contributor was a task where *both arms already
passed* and the treatment arm was scoring on the word *weaken* — a word that appears
verbatim in the skill's own `SKILL.md`. Nine of ten control replies found the bug and
proposed the right fix, and all nine were marked wrong for not using the magic word. The
verifier was measuring diction.

Four full batches were run to produce that table. Three were discarded.

Every one of those mistakes was made by someone actively trying to measure honestly, with
the verifier code in front of him. That is the problem worth solving: the failure modes are
not visible from the inside, and the tooling does nothing to surface them.

**[`FAILURES.md`](FAILURES.md) is the catalog of thirteen of them, with what each one cost.
If you read one thing here, read that** — it is useful whether or not you ever install this.
Three of the thirteen are marked **open**, because they are.

## The three report classes

| Class | When | What prints | Exit |
|---|---|---|---|
| **CONFIRMATORY** | what ran is exactly what was registered, and enough of it graded | everything | 0 |
| **EXPLORATORY** | the registration did not hold — a task changed, `--task` filtered, reps or model overridden, canaries misgraded, no harm task | per-task figures, each failed condition named; **average suppressed** | 0 |
| **VOID** | a cell fell below `max(3, ceil(reps × 0.8))` graded runs | nothing per-task, no average; thin cells named in the ledger | **1** |

Exploratory is not a failure state. Finding a task that discriminates takes iteration, and
the protocol does not prevent iteration — it prevents an iterated result from being reported
as a confirmed one.

A CONFIRMATORY stamp does not imply a printed average. Suppression is orthogonal: the
average is withheld whenever fewer than two signal tasks discriminate, however clean the
registration was.

### What the runner will not let you print

- A per-task delta without its interval. Wilson per arm, Newcombe on the difference, 95%.
- An average over fewer than two discriminating signal tasks.
- An average with an interval — a mean of per-task deltas has no defined one, so it prints
  with an explicit `no interval` marker or not at all.
- A number from a run that isn't in `LEDGER.md`. Every run appends, including the voided
  and the flat ones, from a `finally` block with no path around it.
- A verifier pattern lifted verbatim out of your own `SKILL.md`. Caught at preflight,
  before you spend anything.
- A re-drawn graded run. `--resume` re-attempts only runs that never answered, refuses a
  changed registration, and refuses to resume the same run twice.

## What has actually been run

Claims here are load-bearing, so they are itemised.

| | Status |
|---|---|
| Protocol logic | **148 offline tests**, no network, no API key, stub `claude` binary |
| Worked example (`examples/cobra/`) | **run on Sonnet**, 2026-09-18 — 173 invocations, canaries 13/13, CONFIRMATORY |
| Live bracket (`npm run verify:live`) | **2/2 passed** on a local `gemma-4-12b-qat` |

The bracket is the guarantee that the runner separates signal from noise. Its placebo arm
(an irrelevant skill) returned `+0.0pp [-27.8pp, +27.8pp]`, spanning zero. Its
known-positive arm (a mechanically detectable one) returned `+100.0pp [+60.7pp, +100.0pp]`,
excluding it. Both arms are needed: a harness that always reports null passes the placebo
arm perfectly.

**The bracket has only run against a 12B local model.** That establishes the machinery
works there. It says nothing about a hosted model.

## What nullbench does not do

**It does not help you write a task that discriminates, and that is the hard part.** A task
where both arms already score 100% tells you nothing about a skill, and nullbench cannot
write you a better one. What it does is make the non-discriminating task *visible* — labeled
in the table, excluded from the mean, and capable of suppressing the mean entirely — instead
of letting it be quietly absorbed. Naming the problem is not solving it.

It also does not:

- **evaluate triggering** — whether the skill fires at all. Deferred to v2. A skill can give
  excellent advice and never activate; the two fail separately and must be measured separately.
- **fix a bad rubric.** The judge removes vocabulary-matching as the default failure. A rubric
  that rewards the skill's own framing still defeats it.
- **detect a blind spot shared by the judge and the subject.** Same model family, so a mistake
  both would make cannot appear in a hand-written canary. Disclosed in every judged report.
  `FAILURES.md` entry 3, open.
- **prove isolation.** The directory checks are deterministic; the leakage scan over control
  replies is a heuristic that raises a question and never answers one.
- **enforce replication.** One batch can be stamped CONFIRMATORY, and cobra's own results say
  one batch at n=10 is not enough. `FAILURES.md` entry 9, open.
- **work with anything but the `claude` CLI** — though `tools/local-claude.mjs` adapts any
  OpenAI-compatible endpoint, which is how the bracket was run. Not a general eval framework,
  not a leaderboard, not a hosted service, and never a single score for a suite.

## Repository

```
FAILURES.md        the catalog — thirteen ways an evaluation lies
PROTOCOL.md        the normative spec, and the placebo status block
ATTRIBUTION.md     nothing here is an original idea; this says whose it is
src/               prereg, runner, verify, judge, stats, ledger, report, cli
test/              offline suite (stubbed `claude`, zero spend)
test/live/         the placebo / known-positive bracket — both arms passing
examples/cobra/    the worked example — run on Sonnet, results in its README
tools/             the fake `claude` for tests, and a local-model adapter
```

## Attribution

The paired design is **SkillsBench**'s (arXiv [2602.12670](https://arxiv.org/abs/2602.12670)).
The confirmatory/exploratory split and the file-drawer framing are a straight port of
**clinical and social-science pre-registration** (OSF, AsPredicted) into a new domain. The
judge prompt, the negation-aware verifier and every historical number in `FAILURES.md` come
from **[`cobra-skill/eval`](https://github.com/bharat-goel/cobra-skill)**. The intervals are
**Wilson (1927)** and **Newcombe (1998)**. What each adaptation changed is in
[`ATTRIBUTION.md`](ATTRIBUTION.md).

## License

MIT. See [`LICENSE`](LICENSE).
