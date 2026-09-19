# Attribution

**No idea in this repository is original to it.** nullbench is a port of
pre-registration into a new domain, built on an experimental design taken from a paper and
an implementation taken from a previous project of the author's. This file records who
each part belongs to.

## Primary sources

| Idea | Credit | Source |
|---|---|---|
| Paired conditions, deterministic verifiers, deltas in percentage points, skills that make things *worse* | **SkillsBench** | arXiv [2602.12670](https://arxiv.org/abs/2602.12670), 2026 |
| Pre-registration: declare the design before the data, and the confirmatory/exploratory split | **OSF Registries**, **AsPredicted** (Wharton Credibility Lab) | [osf.io/registries](https://osf.io/registries), [aspredicted.org](https://aspredicted.org) |
| The file drawer: null results that are run and never published | **Robert Rosenthal** (1979), "The 'file drawer problem' and tolerance for null results" | *Psychological Bulletin* 86(3), 638-641 |
| Judge prompt, negation-aware ordering verifier, dead-run exclusion, batch voiding, and **every number in `FAILURES.md`** | **`cobra-skill/eval`** | [github.com/bharat-goel/cobra-skill](https://github.com/bharat-goel/cobra-skill) |
| Wilson score interval for a proportion | **E. B. Wilson** (1927) | *JASA* 22(158), 209-212 |
| Interval for a difference of proportions, method 10 | **R. G. Newcombe** (1998) | *Statistics in Medicine* 17(8), 873-890 |
| Canonical JSON serialization (a subset) | **RFC 8785**, JSON Canonicalization Scheme | [rfc-editor.org/rfc/rfc8785](https://www.rfc-editor.org/rfc/rfc8785) |

## SkillsBench

The experimental design is adopted wholesale: two arms identical except for the skill in
the system prompt, verifiers that are deterministic functions of the reply rather than
impressions, and results reported per task in percentage points. The finding that 16 of 84
tasks got *worse* with skills is what makes a `harm` task a requirement here rather than a
nicety.

**The name is deliberately distinct**, and nullbench claims no relationship to that work.

## Pre-registration

The confirmatory/exploratory distinction, the requirement to commit a prediction before
seeing data, and the framing of the file drawer as the thing a registry exists to prevent
are all straight from clinical trial registration and its social-science descendants (OSF,
AsPredicted). This project contributes none of that. It contributes only the observation
that skill evaluation has the same structure and none of the machinery.

**What this adaptation changed.** Registration here is a file in the repository under a
content hash rather than a timestamped entry in a third-party registry — there is no
trusted third party, so the hash and the git-tracked ledger do the work an external
registrar would otherwise do. This is strictly weaker: an author can rewrite history in
his own repository. It is chosen because a registry nobody runs is worse than a hash
everybody can check.

## `cobra-skill/eval`

The working ancestor, and the source of everything concrete in this repository.

- **The judge prompt** in `src/judge.mjs` is adapted from
  `cobra-skill/eval/judge-prompt.mjs`, including the instruction to refuse credit for
  vocabulary, framework names, formatting and confidence, and the two-line
  `VERDICT:`/`REASON:` output contract.
- **The negation-aware ordering verifier** in `src/verify.mjs` is adapted from
  `firstUnnegated` in `cobra-skill/eval/run.mjs`, including the negation cue list.
- **Paired execution, sandboxing outside the repository, `--setting-sources project`,
  dead-run exclusion from the denominator, and batch voiding** were all implemented there
  first.
- **Every number in `FAILURES.md`** was measured by that harness and is published in
  `cobra-skill/eval/RESULTS.md`. None of them was produced or reproduced by nullbench.

**What this adaptation changed.** The ordering verifier here stops its negation lookback at
a sentence boundary; the original does not, so a negation cue in the preceding sentence
suppresses the following clause. Canaries here take their prompt and rubric from the
registered task rather than carrying their own copy, so a canary cannot certify a judge
against text no task uses. Everything above the verifier layer — registration, hashing,
report classing, intervals, the ledger — is new.

**The dependency does not run in the other direction.** `cobra-skill` keeps its own
`eval/` unchanged. Published cobra numbers must not move because a tool changed.

## Corrections owed upstream

`cobra-skill/eval/RESULTS.md` line 25 gives the re-graded `ic-smoke-denominator` cell as
10% → 90%, which is +80.0pp; its prose at line 55 says "+90.0pp". +80.0pp is correct.
`FAILURES.md` entry 2 uses the correct figure and notes the discrepancy. The upstream
document has **not** been edited from here; correcting it is that project's call.

## This repository's own contribution

Only the following:

- The protocol layer: a registration file under a content hash, the three report classes
  and their conditions, the graded-run floor, and a ledger with no path around the append.
- The rule that a mean is suppressed below two discriminating signal tasks, and that a
  delta is never printed without its interval.
- `FAILURES.md` as a document — the organisation of thirteen known failures into four
  classes, and the discipline of marking three of them open. The failures themselves were
  found by the cobra harness; this catalogs them.
