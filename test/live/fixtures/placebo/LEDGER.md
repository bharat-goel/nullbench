# Run ledger

Every nullbench run in this repository, in order, including runs that were voided,
exploratory, or showed nothing. Appended automatically; do not edit by hand.

## 2026-09-18T17:16:09Z · VOID · H=d3331de4d78e20b4
```
model=sonnet judge=sonnet reps=10
note: task "reasoning" control: 0 graded runs, 8 required
note: task "reasoning" treatment: 0 graded runs, 8 required
note: task "vocabulary-leak" control: 0 graded runs, 8 required
note: task "vocabulary-leak" treatment: 0 graded runs, 8 required
```

## 2026-09-18T17:18:15Z · CONFIRMATORY · H=d3331de4d78e20b4
```
model=sonnet judge=sonnet reps=10
reasoning                signal predict=no-effect  10/10 ->  10/10    +0.0pp [-27.8pp, +27.8pp]  HIT  (non-discriminating)
vocabulary-leak          harm   predict=no-effect  10/10 ->  10/10    +0.0pp [-27.8pp, +27.8pp]  HIT  (non-discriminating)
average across signal tasks: suppressed — 0 of 1 signal tasks discriminate; an average over fewer than two is not a finding
```
