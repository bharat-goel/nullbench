# The live bracket

**Status: both arms run and passed**, on a local `gemma-4-12b-qat`, 2026-09-18.

| Arm | Result | Required |
|---|---|---|
| `fixtures/placebo/` | `+0.0pp [-27.8pp, +27.8pp]`, 40 graded runs, 0 dead | interval spans zero ✓ |
| `fixtures/positive/` | `+100.0pp [+60.7pp, +100.0pp]`, 40 graded runs, 0 dead | interval excludes zero ✓ |

Both arms matter. A harness that always reports null passes the placebo arm perfectly,
so that arm alone establishes nothing; the known-positive arm is what rules it out.

`npm run verify:live` passes both arms in one invocation — 2 tests, 2 passed, 48.5
minutes — with intervals byte-identical to an earlier pair of separate per-arm runs.

One limit on the claim: neither arm has run against a hosted model.

An earlier attempt at the known-positive arm came back VOID — LM Studio dropped
connections at the default concurrency of 4, `fetch failed` on 39 of 40 calls. That was
environmental and was reported as an absent measurement, not as a failed detection.
`--concurrency 1` fixed it, with zero dead runs.

## What this is

Two fixtures and one test file that exercise the full harness (`main` from
`src/cli.mjs`, through `aggregate`/`discriminates`) against real model calls:

- `fixtures/placebo/` — a genuinely well-written skill (`iso-date-formatting`) about
  something irrelevant to its tasks. The bracket asserts this skill must **not**
  produce a discriminating delta on its signal task (`reasoning`). If it did, the
  harness would be manufacturing effects out of noise, and nothing else it reports
  could be trusted.
- `fixtures/positive/` — a skill (`three-bullets`) that trivially and mechanically
  changes response shape. The bracket asserts this skill **must** be detected as a
  discriminating, positive delta on its signal task (`shape`). If it weren't, the
  harness could be reporting null for everything and the placebo test alone would
  never catch that.

Together the two tests are the harness's own negative and positive control. Passing
the placebo test alone proves nothing (a harness that always says "no effect" passes
it trivially); passing both is the actual claim.

## How to run it

```
npm run verify:live
```

This is deliberately **not** part of `npm test`. `npm test` globs `test/*.test.mjs`
and `test/e2e/*.test.mjs`; `verify:live` is the only script that globs
`test/live/*.test.mjs`. Running `npm test` must never invoke this file, because it
spends real money.

## Cost

Each fixture registers one signal task and one harm task (the harm task exists only
because `loadRegistration` flags a suite with no harm task as drift — see
`src/prereg.mjs`). At `reps: 10`, that's 2 tasks x 2 arms (control/treatment) x 10
reps = 40 subject invocations per fixture, no judge calls (both fixtures use
deterministic verifiers). Confirmed by `--dry-run` against both fixtures:

- `placebo`: 40 CLI invocations, ~$0.80 at the tool's default $0.02/call estimate.
- `positive`: 40 CLI invocations, ~$0.80 at the same estimate.
- **Total for the full bracket: 80 CLI invocations**, roughly $1.60 at that default
  (override with `--cost-per-call` for a more accurate figure once real pricing is
  known). This is about double the rough "40 invocations" ballpark floated before the
  fixtures existed -- the required harm task in each registration is what accounts
  for the difference.

## What a passing result would mean

Both tests PASS: the placebo's 95% interval touches zero (`discriminates() === false`)
and the positive's interval is strictly above zero with `delta > 0`
(`discriminates() === true`). That would mean the harness can tell a real,
mechanically-guaranteed effect apart from no effect at all -- the minimum bar for
trusting any other number it produces.

Either test failing is informative in the opposite direction:

- Placebo fails (discriminates on an irrelevant skill) -- the harness manufactures
  effects. Nothing else it has ever reported should be trusted until this is fixed.
- Known-positive fails (does not discriminate on a skill that trivially and
  deterministically changes output shape) -- the harness can report null for
  everything and never get caught. The placebo test alone cannot detect this failure
  mode; that is exactly why both tests exist.

## What has NOT happened

- `npm run verify:live` has not been executed.
- No `results/` directory exists under either fixture.
- No pass rate, delta, or confidence interval for either fixture has been measured,
  recorded, quoted, or estimated anywhere in this repository.
- Task 16 (`PROTOCOL.md`) cannot yet pin a date, model, or interval for this bracket,
  because none exist.

Both intervals and the date are recorded above and in `PROTOCOL.md`'s Placebo status
block. Re-run `npm run verify:live` after any change to the runner, the verifiers or the
statistics, and update both.

## A note on `--disallowedTools`

Subject invocations **do not** pass it. An earlier version did, on the reasoning that
nothing in the protocol needs the subject to write to its cwd. That reasoning was wrong:
cobra's `ic-agent-under-pressure` hands the model a real failing test suite and grades
whether it finds the bug, and cobra's published numbers were measured with no tool
restriction — so restricting here would both change the task and make the worked example
non-comparable. Contamination is closed by the per-run sandbox instead, which is created,
isolation-checked and destroyed around every single call.

The plumbing remains in `src/claude.mjs` for a caller who wants it, and it is now correct:
`--disallowedTools=a,b,c` as one token. The separate-entry form was verified against the
real CLI the hard way — the flag is variadic, it swallowed the trailing positional prompt,
every word of the prompt became a bogus deny rule, and 97 of 100 runs produced no reply.
The batch came back VOID rather than reporting a number, which is the system working, but
the run was wasted.

## Running the bracket against a local model

`tools/local-claude.mjs` adapts any OpenAI-compatible endpoint (LM Studio, llama.cpp) to
the interface the runner expects. Measured against `gemma-4-12b-qat` on a 24 GB machine:

```bash
NULLBENCH_CLAUDE_BIN=$PWD/tools/local-claude.mjs \
NULLBENCH_LOCAL_MODEL=google/gemma-4-12b-qat \
NULLBENCH_LOCAL_TIMEOUT_MS=900000 \
node bin/nullbench.mjs test/live/fixtures/placebo --yes --concurrency 1
```

Or the whole bracket in one command, which is what `npm run verify:live` runs:

```bash
NULLBENCH_CLAUDE_BIN=$PWD/tools/local-claude.mjs \
NULLBENCH_LOCAL_MODEL=google/gemma-4-12b-qat \
NULLBENCH_LOCAL_TIMEOUT_MS=900000 \
NULLBENCH_LIVE_CONCURRENCY=1 \
npm run verify:live
```

`NULLBENCH_LIVE_CONCURRENCY` is read by the bracket test only. Leave it unset against a
hosted endpoint; the runner's default of 4 is correct there.

Three things are load-bearing and were each learned the hard way:

- **Absolute path** for `NULLBENCH_CLAUDE_BIN`. Every invocation runs in a fresh sandbox,
  so a relative path resolves against that sandbox. (nullbench now resolves it for you,
  but the habit is worth keeping.)
- **`--concurrency 1`.** The default of 4 makes LM Studio drop connections on a single
  GPU — observed as `fetch failed` on 39 of 40 calls.
- **A long timeout.** Local replies took ~2m15s; the adapter's 180s default is not enough.

A local run measures *that model*, not the one a suite registered. It validates the
harness, not the skill's effect on a hosted model.
