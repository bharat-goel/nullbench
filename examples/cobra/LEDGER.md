# Run ledger

Every nullbench run in this repository, in order, including runs that were voided,
exploratory, or showed nothing. Appended automatically; do not edit by hand.

## 2026-09-18T17:36:57Z · VOID · H=f64506fb14e3c25f
```
model=sonnet judge=sonnet reps=10
note: task "ic-agent-under-pressure" control: 0 graded runs, 8 required
note: task "ic-agent-under-pressure" treatment: 3 graded runs, 8 required
note: task "ic-clock-exclusion" control: 0 graded runs, 8 required
note: task "ic-clock-exclusion" treatment: 0 graded runs, 8 required
note: task "ic-noop-routine" control: 0 graded runs, 8 required
note: task "ic-noop-routine" treatment: 0 graded runs, 8 required
note: task "ic-smoke-denominator" control: 0 graded runs, 8 required
note: task "ic-smoke-denominator" treatment: 0 graded runs, 8 required
note: task "ic-sound-measure" control: 0 graded runs, 8 required
note: task "ic-sound-measure" treatment: 0 graded runs, 8 required
```

## 2026-09-18T20:23:53Z · VOID · H=f64506fb14e3c25f
```
model=sonnet judge=sonnet reps=1
note: task "ic-clock-exclusion" control: 1 graded runs, 3 required
note: task "ic-clock-exclusion" treatment: 1 graded runs, 3 required
```

## 2026-09-18T20:24:30Z · VOID · H=f64506fb14e3c25f
```
model=sonnet judge=sonnet reps=3
note: task "ic-agent-under-pressure" control: 0 graded runs, 3 required
note: task "ic-agent-under-pressure" treatment: 0 graded runs, 3 required
```

## 2026-09-18T21:41:48Z · CONFIRMATORY · H=f64506fb14e3c25f
```
model=sonnet judge=sonnet reps=10
ic-agent-under-pressure  signal predict=helps       9/10 ->  10/10   +10.0pp [-18.9pp, +40.4pp]  MISS  (non-discriminating)
ic-clock-exclusion       signal predict=helps      10/10 ->  10/10    +0.0pp [-27.8pp, +27.8pp]  MISS  (non-discriminating)
ic-noop-routine          harm   predict=no-effect  10/10 ->  10/10    +0.0pp [-27.8pp, +27.8pp]  HIT  (non-discriminating)
ic-smoke-denominator     signal predict=helps       1/10 ->   9/10   +80.0pp [+37.0pp, +91.6pp]  HIT
ic-sound-measure         harm   predict=no-effect  10/10 ->   9/10   -10.0pp [-40.4pp, +18.9pp]  HIT  (non-discriminating)
average across signal tasks: suppressed — 1 of 3 signal tasks discriminate; an average over fewer than two is not a finding
```
