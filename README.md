# nullbench

**A skill I published came with an evaluation. The evaluation was wrong.**

It reported **+40.0pp**. Re-measurement under a blind rubric judge put it at **+26.7pp**,
and the reason was not a typo. The largest single contributor to the original figure was a
task where *both arms already passed* and the treatment arm was scoring on the word
*weaken* — a word that appears verbatim in the skill's own `SKILL.md`. Nine of ten control
replies found the bug and proposed the right fix, and all nine were marked wrong for not
using the magic word. The verifier was measuring diction.

The corrected `+26.7pp` is also not a good number. It is a mean over three signal tasks:
one with a large real effect, and two pinned at 100% in both arms with no headroom to show
anything. Four full batches were run to produce that table. Three were discarded.

Every one of those mistakes was made by someone actively trying to measure honestly, with
the verifier code in front of him. That is the problem worth solving. The failure modes are
not visible from the inside, and the tooling does nothing to surface them.

`FAILURES.md` is the catalog of thirteen of them, with what each one cost. **If you read
one thing here, read that.** It is useful whether or not you ever install this.

---

## Status: unvalidated against a real model

Read this before you read anything else as a claim.

- The protocol logic is tested end to end: **118 offline tests**, no network, no API key,
  driven by a stub `claude` binary that replays recorded output.
- **The runner has never been executed against a real model.** Not once, not one rep. The
  person who built it has no API access.
- The live bracket — a placebo skill that must produce nothing and a known-positive skill
  that must be detected — exists under `test/live/` and **has never been run**. Until it
  has, the guarantee that this runner does not manufacture effects is **unproven**. See
  the Placebo status block at the top of `PROTOCOL.md`.
- The worked example in `examples/cobra/` **has never been run** either. It is a real
  registration over cobra's real tasks, verified offline: hashes check out, the fixture is
  isolation-clean, `--dry-run` prints a real preflight of 173 invocations. It has produced
  no results, and none are quoted anywhere in this repository.

What the worked example is *set up to do*, when somebody with API access runs it: register
five cobra tasks — three signal, two harm — with a prediction committed for each, run them
paired, and apply the discrimination rule. Two of the signal tasks are expected to come
back non-discriminating, which would leave one discriminating signal task, which is below
the threshold of two, which means the suite average would be **suppressed** rather than
printed. That is the outcome the example was built to demonstrate: the protocol's first
act being to withhold its own author's headline figure. **It is a prediction, stated in
advance so it can be wrong.** It is not a result, and this README will not report it as one
until the run happens.

A project whose thesis is that published evaluations overclaim does not get to overclaim.

---

## What it is

nullbench is three things, in order of how much they matter:

1. **A catalog** (`FAILURES.md`) of how skill evaluations lie, with real numbers from a
   real evaluation that got them wrong.
2. **A protocol** (`PROTOCOL.md`): declare the tasks, the reps, the models and a
   per-task *prediction* before running; hash the registration; stamp that hash on every
   report and every ledger entry.
3. **A runner** that enforces the protocol, because the enforcement points — hashing,
   classing, the ledger append, printing intervals — are exactly the steps a person under
   deadline pressure skips. A protocol that depends on discipline measures discipline.

### The three report classes

| Class | When | What prints | Exit |
|---|---|---|---|
| **CONFIRMATORY** | what ran is exactly what was registered, and enough of it graded | everything | 0 |
| **EXPLORATORY** | the registration did not hold — a task changed, `--task` filtered, reps or model overridden, canaries misgraded, no harm task | per-task figures, each failed condition named; **average suppressed** | 0 |
| **VOID** | a cell fell below `max(3, ceil(reps * 0.8))` graded runs | nothing per-task, no average; the thin cells are named in the ledger | **1** |

Exploratory is not a failure state. Finding a task that discriminates takes iteration, and
the protocol does not prevent iteration — it prevents an iterated result from being
reported as a confirmed one.

A CONFIRMATORY stamp does not imply a printed average. Suppression is orthogonal: the
average is withheld whenever fewer than two signal tasks discriminate, however clean the
registration was.

### What the runner will not let you print

- A per-task delta without its interval. Wilson per arm, Newcombe on the difference, 95%.
- An average over fewer than two discriminating signal tasks.
- An average with an interval — a mean of per-task deltas has no defined one, so it prints
  with an explicit `no interval` marker or not at all.
- A number from a run that isn't in `LEDGER.md`. Every run appends, including the voided
  ones and the flat ones, from a `finally` block with no path around it.

---

## Install and use

Node >= 22. No dependencies, ESM only. Not published to npm yet — clone the repository and
run `node bin/nullbench.mjs <suite-dir>`; the examples below use `nullbench` for brevity.

Write a `nullbench.json` and a `tasks/` directory beside your `SKILL.md`:

```json
{
  "model": "sonnet",
  "judge_model": "sonnet",
  "reps": 10,
  "tasks": [
    { "id": "my-task", "file": "tasks/my-task.json",
      "sha256": "<sha256 of that file's bytes>",
      "kind": "signal", "predict": "helps" },
    { "id": "my-negative-control", "file": "tasks/my-negative-control.json",
      "sha256": "<...>", "kind": "harm", "predict": "no-effect" }
  ]
}
```

At least one `harm` task is required for a CONFIRMATORY stamp. Without a negative control,
the cheapest way for any skill to satisfy its own evaluation is to fire on everything.

```bash
nullbench .                          # preflight, confirm, run
nullbench . --dry-run                # preflight only: costs nothing, writes nothing
nullbench . --yes                    # skip the confirmation prompt
nullbench . --cost-per-call 0.015    # the built-in price is a placeholder, not a quote
nullbench . --task my-task           # runs one task — and stamps EXPLORATORY, by design
```

Full field reference, canonicalization rules, hash construction, exact class conditions,
ledger format and the interval methods: `PROTOCOL.md`.

Verify without spending anything:

```bash
npm test                             # 118 tests, no network, no API key
node bin/nullbench.mjs examples/cobra --dry-run
```

`npm run verify:live` is the live bracket and is deliberately *not* part of `npm test`. It
costs 80 real invocations.

---

## What nullbench does not do

**It does not help you write a task that discriminates, and that is the hard part.** A
task where both arms already score 100% tells you nothing about a skill, and nullbench
cannot write you a better one. What it does is make the non-discriminating task *visible* —
labeled in the table, excluded from the mean, and capable of suppressing the mean
entirely — instead of letting it be quietly absorbed into an average. Naming the problem is
not solving it.

It also does not:

- **evaluate triggering** — whether the skill fires at all. That is v1 scope, deferred to
  v2. A skill can give excellent advice and never activate; the two fail separately and
  must be measured separately.
- **fix a bad rubric.** The judge removes vocabulary-matching as the default failure. A
  rubric that rewards the skill's own framing still defeats it.
- **detect a blind spot shared by the judge and the subject.** Same model family, so a
  mistake both would make cannot appear in a hand-written canary. Disclosed in every
  report that used a judge. `FAILURES.md` entry 3, marked open.
- **prove isolation.** The directory checks are deterministic; the leakage scan over
  control replies is a heuristic that raises a question and never answers one.
- **enforce replication.** One batch can be stamped CONFIRMATORY, and cobra's own results
  say one batch at n=10 is not enough. `FAILURES.md` entry 9, marked open.
- **work with anything but the `claude` CLI.** Not a general eval framework, not a
  leaderboard, not a hosted service, and never a single score for a suite.

---

## Repository

```
FAILURES.md        the catalog — thirteen ways an evaluation lies
PROTOCOL.md        the normative spec, and the placebo status block
ATTRIBUTION.md     nothing here is an original idea; this says whose it is
src/               prereg, runner, verify, judge, stats, ledger, report, cli
test/              offline suite (stubbed `claude`, zero spend)
test/live/         the placebo / known-positive bracket — never run
examples/cobra/    the worked example — registered and verified offline, never run
```

## Attribution

The paired design is **SkillsBench**'s (arXiv 2602.12670). The confirmatory/exploratory
split and the file-drawer framing are a straight port of **clinical and social-science
pre-registration** (OSF, AsPredicted) into a new domain. The judge prompt, the
negation-aware verifier and every number in `FAILURES.md` come from **`cobra-skill/eval`**.
The intervals are **Wilson (1927)** and **Newcombe (1998)**. Details, including what each
adaptation changed, are in `ATTRIBUTION.md`.

## License

MIT. See `LICENSE`.
