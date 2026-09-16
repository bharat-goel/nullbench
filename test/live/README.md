# The live bracket

**This bracket has never been run. Nothing in this directory reflects an observed
result.** It was written under a scope reduction: the environment building it had no
API access, so the code exists but has not executed once, not even a single rep.

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

Run `npm run verify:live` when API access is available, then update this file and
`PROTOCOL.md` with the actual date, model, and both intervals -- not before.
