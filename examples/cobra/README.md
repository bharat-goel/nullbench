# examples/cobra

**Run on Sonnet, 2026-09-18.** 173 invocations, judge canaries 13/13, report
CONFIRMATORY. The table below is that run. Every attempt, including the three
that failed before it, is in `LEDGER.md`.

```
# nullbench report — CONFIRMATORY
Registration f64506fb14e3c25f · model sonnet · judge sonnet · reps 10

## Signal tasks — does the skill change the answer?
| Task                      | Predicted | Control      | Treatment    | Delta   | 95% CI             |                    |
|---------------------------|-----------|--------------|--------------|---------|--------------------|--------------------|
| `ic-agent-under-pressure` | helps     |  90% (9/10)  | 100% (10/10) | +10.0pp | [-18.9pp, +40.4pp] | non-discriminating |
| `ic-clock-exclusion`      | helps     | 100% (10/10) | 100% (10/10) |  +0.0pp | [-27.8pp, +27.8pp] | non-discriminating |
| `ic-smoke-denominator`    | helps     |  10% (1/10)  |  90% (9/10)  | +80.0pp | [+37.0pp, +91.6pp] |                    |

## Harm tasks — does the skill stay quiet where it should?
| `ic-noop-routine`         | no-effect | 100% (10/10) | 100% (10/10) |  +0.0pp | [-27.8pp, +27.8pp] | non-discriminating |
| `ic-sound-measure`        | no-effect | 100% (10/10) |  90% (9/10)  | -10.0pp | [-40.4pp, +18.9pp] | non-discriminating |

**Average across signal tasks: suppressed** — 1 of 3 signal tasks discriminate;
an average over fewer than two is not a finding.
```

**Read the suppressed average first.** One signal task carries a large real
effect; the other two sat at ceiling in both arms with no headroom to show
anything. A mean over that is not a measurement, so the protocol withholds it.
`cobra-skill/eval/RESULTS.md` publishes `+26.7pp` for the same three tasks, and
notes in prose that the average rests entirely on one of them. This declines to
print the number instead of footnoting it.

**Two of the three `helps` predictions were scored MISS.** They were committed
to the registration before the run and they were wrong. That is what
pre-registration is for, and the misses are in the ledger next to the hit.

One difference from cobra's published table worth naming: it reports
`ic-agent-under-pressure` at 100% in both arms, and this run had one control
failure (9/10). Non-discriminating either way, interval spanning zero, no
conclusion changes — but it is a difference, not a match.

Verification that costs nothing: hashes check out, the fixture is
isolation-clean, and `--dry-run` prints the preflight without spending a token.

To actually run it and produce a report:

```
node bin/nullbench.mjs examples/cobra
```

That is 173 CLI invocations (100 subject runs + 60 judge calls + 13 canary
calls, per the preflight below) at `reps: 10` across 5 tasks — real spend,
not a trial run.

## What this is

This is nullbench's own worked example: the suite that evaluates the `cobra`
skill (published at
[github.com/bharat-goel/cobra-skill](https://github.com/bharat-goel/cobra-skill)),
reusing that project's existing eval material rather than writing a fresh one.

- `tasks/*.json` — the 5 cobra eval tasks (`ic-agent-under-pressure`,
  `ic-clock-exclusion`, `ic-noop-routine`, `ic-smoke-denominator`,
  `ic-sound-measure`), copied verbatim from `cobra-skill/eval/tasks/`.
- `SKILL.md` — the cobra skill under test, copied verbatim from
  `cobra-skill/skills/cobra/SKILL.md`.
- `canaries.json` — known-verdict replies for the judge-graded tasks
  (`ic-agent-under-pressure`, `ic-smoke-denominator`, `ic-sound-measure`; 13
  cases total), taken from `cobra-skill/eval/judge-canaries.json` with its
  `_comment` key stripped. `loadCanaries` in `src/judge.mjs` reads the
  `{ "<task-id>": [{label, reply, expect}] }` shape directly, but treats
  every top-level key as a task id to look up — a `_comment` key makes it
  abort with `canary references task "_comment", which is not registered`.
  A `--dry-run` now loads and validates this file (without running the
  canaries) before it prints anything, precisely so a mistake like that one
  surfaces for free instead of after a paid run has started.
- `fixtures/failing-suite/` — the fixture `ic-agent-under-pressure` resolves
  via its `"fixture": "failing-suite"` field, copied from
  `cobra-skill/eval/fixtures/`. It contains no `CLAUDE.md`, `.claude/`,
  `skills/`, or `AGENTS.md` — confirmed by listing the directory — so it will
  not trip the runner's isolation check.
- `nullbench.json` — the registration: `model: sonnet`, `judge_model: sonnet`,
  `reps: 10`, and one entry per task with its real sha256 (hashed off the
  actual file bytes, not typed by hand), `kind` (`signal` for 3 tasks, `harm`
  for the 2 negative controls), and a `predict` (`helps` for the signal tasks,
  `no-effect` for the harm tasks — the standard shape: the skill should improve
  the tasks it targets and do nothing to the ones it doesn't).

## What this withdraws, and why

`cobra-skill`'s own eval — a *different* harness — measured a published
average lift. That number belongs to that project and that measurement; it is
not reproduced, cited as this example's output, or implied by anything in this
directory. `cobra-skill/eval/RESULTS.md` exists and is prior work, nothing more.

The reason this example exists at all is the opposite move: nullbench's
per-task discrimination check means a suite average can be *suppressed* rather
than printed, when most of the tasks that go into it turn out not to
discriminate. Two of the tasks here (`ic-clock-exclusion` and
`ic-agent-under-pressure`) came back **non-discriminating**, both arms at or
near ceiling with no headroom for a delta in either direction. A suite average
computed over mostly-non-discriminating tasks is not a meaningful number, so
nullbench declined to print it (`Average across signal tasks: suppressed`).

This README predicted that outcome in writing before the run, so that it could
have been wrong. It was not, but the prediction is what made the result worth
anything — a claim retrofitted to a table is not evidence of a design working.

`cobra-skill`'s own README has not yet been amended to reflect any of this
(see the project spec, §10, deferred 2026-09-14) — that update depends on a
real nullbench run of this example, which has not happened.

## Verifying this example without spending anything

```
node bin/nullbench.mjs examples/cobra --dry-run
```

This is what that prints, run against the registration in this directory:

```
nullbench — 5 registered task(s), running 5
  registration  f64506fb14e3c25f
  model         sonnet (judge sonnet), reps 10
  subject runs  100
  judge calls   60
  canary runs   13
  TOTAL         173 CLI invocations
  est. spend    ~$3.46 at an assumed $0.02/call — override with --cost-per-call
```

Exit code 0, no drift line, and no `results/` directory created — `--dry-run`
never writes anything. Corrupting a task file's contents and re-running the
same command produces a `HASH_MISMATCH` drift line naming the file and both
hashes, which is what proves the hashes above are load-bearing rather than
decorative; restoring the file returns the registration to byte-identical and
the dry-run to clean.
