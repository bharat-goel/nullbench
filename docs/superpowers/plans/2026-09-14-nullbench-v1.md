# nullbench v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a pre-registration protocol for Claude skill evaluation — a runner that refuses to report a confirmed result unless the tasks, reps and model were declared and hashed before the run — together with a published catalog of the ways such evaluations lie.

**Architecture:** A pure-function core (statistics, canonicalization, classification, verification) with all process spawning isolated behind one adapter module. The adapter reads its executable path from an environment variable, so the entire protocol layer is tested offline against a stub that replays recorded CLI output, with zero API spend. Two live tests bracket the runner: a placebo skill that must produce a null, and a known-positive skill that must be detected.

**Tech Stack:** Node.js >= 22 (developed on v25.8.2), ESM `.mjs`, `node:test` + `node:assert/strict`. **Zero runtime dependencies and zero devDependencies.** No TypeScript, no bundler, no test framework beyond the Node builtin.

**Spec:** `docs/superpowers/specs/2026-09-14-nullbench-design.md` — read it before Task 1. The plan implements it; where the plan and spec disagree, the spec is wrong and should be amended by a commit that says so.

## Execution Order

Dependency order, not numeric order. **Task 12 (`src/leakage.mjs`) executes after Task 9
and before Task 10**, because Tasks 10 and 11 both import it:

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 12 → 10 → 11 → 13 → 14 → 15 → 16`

Task numbers are stable; only the dispatch sequence differs. Every other task depends
only on tasks numbered below it.

## Global Constraints

- **Zero dependencies.** `package.json` must have no `dependencies` and no `devDependencies`. A task that needs a library is a task that needs redesigning.
- **ESM only.** `"type": "module"`, all sources `.mjs`, `import`/`export`, never `require`.
- **Node >= 22**, declared in `engines`.
- **No network in CI tests.** Every test under `test/` except `test/live/` must pass with no network and no API key. Tests invoke the stub via `NULLBENCH_CLAUDE_BIN`.
- **Every per-task delta printed anywhere carries its interval.** No bare point estimates in any output path — report, ledger, CLI, or README. The one exception is the average across signal tasks, which is a mean over heterogeneous quantities and has no defined interval: it must be printed with an explicit `no interval` marker, never bare. This is the project's core promise; a code review that finds a naked delta rejects the task.
- **Proportions internally, percentage points at the edge.** All statistics functions take and return proportions in `[0, 1]`. Only `report.mjs` and `ledger.mjs` multiply by 100 and append `pp`.
- **Runs never execute inside the repository.** Every subject invocation uses a fresh `mkdtemp` directory outside the project and `--setting-sources project`. This is spec §6 entry 5; violating it silently destroys every measurement.
- **Naming:** the tool is `nullbench`, lowercase, one word, everywhere.
- Percentages render with one decimal and an explicit sign (`+80.0pp`, `-5.0pp`, `+0.0pp`).

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | name, bin, scripts, engines. No deps. |
| `src/stats.mjs` | Wilson and Newcombe intervals, discrimination test. Pure. |
| `src/canonical.mjs` | RFC 8785-subset canonical JSON serialization. Pure. |
| `src/prereg.mjs` | Load, validate and hash a registration. Reads files; no spawning. |
| `src/verify.mjs` | Pattern verifiers (`any`/`none`/`ordered`) with negation handling. Pure. |
| `src/judge.mjs` | Blind rubric judge prompt, verdict parsing, canary gate. |
| `src/claude.mjs` | The only module that spawns a process. Everything else is testable offline. |
| `src/runner.mjs` | Paired execution, sandboxing, concurrency, dead-run exclusion. |
| `src/leakage.mjs` | Sandbox isolation assertion and the (weak, labelled) vocabulary scan. |
| `src/classify.mjs` | CONFIRMATORY / EXPLORATORY / VOID decision. Pure. |
| `src/report.mjs` | Aggregation and markdown rendering. Pure. |
| `src/ledger.mjs` | Append-only ledger writer. |
| `src/cli.mjs` | Flag parsing, cost preflight, orchestration, exit codes. |
| `bin/nullbench.mjs` | Shebang entry point; imports `src/cli.mjs`. |
| `tools/stub-claude.mjs` | Fake `claude` binary; replays fixtures. Outside `test/` so bare `node --test` never loads or executes it. |
| `examples/cobra/` | cobra's suite as the worked example. |
| `FAILURES.md`, `PROTOCOL.md`, `README.md`, `ATTRIBUTION.md`, `LICENSE` | The published contribution. |

Dependency direction is strictly downward: `cli → runner → {claude, verify, judge}`, `cli → {classify, report, ledger} → stats`, `prereg → canonical`. No module imports `cli.mjs`.

---

### Task 1: Project scaffold and the statistics core

Statistics come first because every later module formats their output, and because they are pure functions with externally verifiable reference values — the ideal place to establish the TDD rhythm.

**Files:**
- Create: `package.json`
- Create: `src/stats.mjs`
- Test: `test/stats.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `wilson(k: number, n: number, z = 1.96) -> { lo: number, hi: number }` — proportions, clamped to `[0,1]`. Throws `RangeError` when `n < 1`, `k < 0`, or `k > n`.
  - `newcombe(kC, nC, kT, nT) -> { lo: number, hi: number }` — interval for the difference `pT - pC` as a proportion in `[-1, 1]`.
  - `discriminates({ lo, hi }) -> boolean` — true when the interval excludes zero.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "nullbench",
  "version": "0.1.0",
  "description": "A pre-registration protocol for Claude skill evaluation",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "bin": { "nullbench": "./bin/nullbench.mjs" },
  "files": ["bin", "src", "PROTOCOL.md", "FAILURES.md"],
  "scripts": {
    "test": "node --test 'test/*.test.mjs' 'test/e2e/*.test.mjs'",
    "verify:live": "node --test 'test/live/*.test.mjs'"
  }
}
```

- [ ] **Step 2: Write the failing test**

Reference values are computed from the Wilson score interval at z=1.96 and Newcombe's
method 10 (square-and-add). The three difference cases are the real cobra cells named in
spec §5.4, so this test doubles as proof that the protocol reaches the intended verdicts.

Create `test/stats.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { wilson, newcombe, discriminates } from "../src/stats.mjs";

const near = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);

test("wilson matches reference values at 95%", () => {
  const cases = [
    [0, 10, 0.0, 0.277540],
    [10, 10, 0.722460, 1.0],
    [1, 10, 0.017876, 0.404156],
    [9, 10, 0.595844, 0.982124],
    [19, 20, 0.763864, 0.991119],
    [18, 20, 0.698962, 0.972134],
  ];
  for (const [k, n, lo, hi] of cases) {
    const w = wilson(k, n);
    near(w.lo, lo);
    near(w.hi, hi);
  }
});

test("wilson clamps to [0,1] rather than emitting impossible proportions", () => {
  const a = wilson(0, 10);
  const b = wilson(10, 10);
  assert.equal(a.lo, 0);
  assert.equal(b.hi, 1);
});

test("wilson rejects impossible inputs instead of returning NaN", () => {
  assert.throws(() => wilson(0, 0), RangeError);
  assert.throws(() => wilson(-1, 10), RangeError);
  assert.throws(() => wilson(11, 10), RangeError);
});

test("newcombe reproduces the three cobra cells from spec 5.4", () => {
  // ic-smoke-denominator: the one task that carries the published average.
  const smoke = newcombe(1, 10, 9, 10);
  near(smoke.lo, 0.369858);
  near(smoke.hi, 0.916141);
  assert.equal(discriminates(smoke), true);

  // A ceiling task: both arms perfect, delta zero, interval wide.
  const ceiling = newcombe(10, 10, 10, 10);
  near(ceiling.lo, -0.277540);
  near(ceiling.hi, 0.277540);
  assert.equal(discriminates(ceiling), false);

  // ic-sound-measure, the negative control: -5pp, published as not significant.
  const sound = newcombe(19, 20, 18, 20);
  near(sound.lo, -0.255200);
  near(sound.hi, 0.149624);
  assert.equal(discriminates(sound), false);
});

test("discriminates is false for any interval touching zero", () => {
  assert.equal(discriminates({ lo: -0.1, hi: 0.3 }), false);
  assert.equal(discriminates({ lo: 0, hi: 0.3 }), false);
  assert.equal(discriminates({ lo: 0.1, hi: 0.3 }), true);
  assert.equal(discriminates({ lo: -0.3, hi: -0.1 }), true);
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `node --test test/stats.test.mjs`
Expected: FAIL — `Cannot find module '../src/stats.mjs'`.

- [ ] **Step 4: Implement `src/stats.mjs`**

```js
// Interval estimation for paired pass-rate comparisons.
//
// Point estimates are the reason this project exists. A delta of +80pp from ten runs
// per arm and a delta of +80pp from a hundred are the same number and different
// evidence, and reporting them identically is how a small-sample artefact becomes a
// published finding -- see FAILURES.md entry 7, where an effect measured -25.0pp at
// n=8 settled at -5.0pp by n=20. Every consumer of this module reports the interval.

const Z95 = 1.96;

// Wilson score interval. Preferred over the normal approximation because it stays
// inside [0,1] and remains sane at k=0 and k=n, which are exactly the cells a ceiling
// task produces and the cells that matter most here.
export function wilson(k, n, z = Z95) {
  if (!Number.isFinite(k) || !Number.isFinite(n)) throw new RangeError("k and n must be finite");
  if (n < 1) throw new RangeError(`n must be at least 1, got ${n}`);
  if (k < 0 || k > n) throw new RangeError(`k must be within [0, ${n}], got ${k}`);
  const z2 = z * z;
  const d = n + z2;
  const centre = (k + z2 / 2) / d;
  const half = (z / d) * Math.sqrt((k * (n - k)) / n + z2 / 4);
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// Newcombe's method 10 for the difference of two independent proportions: take each
// arm's Wilson interval and square-and-add the distances to the relevant bounds. Chosen
// over a Wald interval on the difference for the same reason as above -- it does not
// collapse to zero width when an arm sits at 0% or 100%.
export function newcombe(kC, nC, kT, nT, z = Z95) {
  const pC = kC / nC;
  const pT = kT / nT;
  const c = wilson(kC, nC, z);
  const t = wilson(kT, nT, z);
  const delta = pT - pC;
  return {
    lo: delta - Math.sqrt((pT - t.lo) ** 2 + (c.hi - pC) ** 2),
    hi: delta + Math.sqrt((t.hi - pT) ** 2 + (pC - c.lo) ** 2),
  };
}

// An interval that touches zero does not discriminate. Zero itself counts as touching:
// a bound of exactly 0.0 is not evidence of an effect.
export function discriminates({ lo, hi }) {
  return lo > 0 || hi < 0;
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `node --test test/stats.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json src/stats.mjs test/stats.test.mjs
git commit -m "feat(stats): Wilson and Newcombe intervals with cobra reference values"
```

---

### Task 2: Canonical JSON

The registration hash is worthless if reformatting `nullbench.json` changes it. This is the smallest possible task and it gates Task 3.

**Files:**
- Create: `src/canonical.mjs`
- Test: `test/canonical.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `canonicalJSON(value) -> string` — RFC 8785 subset: object keys sorted by UTF-16 code unit, no insignificant whitespace, arrays order-preserving. Throws `TypeError` on non-finite numbers and on `undefined`/function values, which have no canonical form.

- [ ] **Step 1: Write the failing test**

Create `test/canonical.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJSON } from "../src/canonical.mjs";

test("key order does not change the serialization", () => {
  const a = { model: "sonnet", reps: 10, judge_model: "sonnet" };
  const b = { reps: 10, judge_model: "sonnet", model: "sonnet" };
  assert.equal(canonicalJSON(a), canonicalJSON(b));
  assert.equal(canonicalJSON(a), '{"judge_model":"sonnet","model":"sonnet","reps":10}');
});

test("whitespace and indentation do not survive a round trip", () => {
  const pretty = JSON.parse('{\n  "b": 1,\n  "a": [ 2, 3 ]\n}');
  assert.equal(canonicalJSON(pretty), '{"a":[2,3],"b":1}');
});

test("array order is preserved because it is meaningful", () => {
  assert.equal(canonicalJSON({ t: ["b", "a"] }), '{"t":["b","a"]}');
});

test("nested objects are sorted at every level", () => {
  const v = { z: { d: 1, c: 2 }, a: 3 };
  assert.equal(canonicalJSON(v), '{"a":3,"z":{"c":2,"d":1}}');
});

test("values with no canonical form are rejected, not silently dropped", () => {
  assert.throws(() => canonicalJSON({ a: NaN }), TypeError);
  assert.throws(() => canonicalJSON({ a: Infinity }), TypeError);
  assert.throws(() => canonicalJSON({ a: undefined }), TypeError);
  assert.throws(() => canonicalJSON({ a: () => {} }), TypeError);
});

test("null is a legitimate value and survives", () => {
  assert.equal(canonicalJSON({ a: null }), '{"a":null}');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/canonical.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/canonical.mjs`**

```js
// Canonical JSON, an RFC 8785 subset sufficient for registration hashing.
//
// The registration hash must not move when someone runs a formatter over
// nullbench.json. JSON.stringify preserves insertion order, so it is not stable across
// hand edits; this sorts keys at every level and emits no insignificant whitespace.
//
// Values with no canonical form throw rather than serialize. JSON.stringify drops
// undefined and functions from objects and turns NaN into null, any of which would
// produce two different registrations that hash identically.

export function canonicalJSON(value) {
  return ser(value);
}

function ser(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`no canonical form for ${v}`);
    return JSON.stringify(v);
  }
  if (t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(ser).join(",")}]`;
  if (t === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${ser(v[k])}`).join(",")}}`;
  }
  throw new TypeError(`no canonical form for value of type ${t}`);
}
```

Note: `Object.keys().sort()` sorts by UTF-16 code unit, which is what RFC 8785 specifies.

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test test/canonical.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/canonical.mjs test/canonical.test.mjs
git commit -m "feat(canonical): RFC 8785-subset canonical JSON for stable hashing"
```

---

### Task 3: Registration loading, validation and hashing

The distinction this task establishes matters more than the code: **structural errors abort the run, registration drift downgrades it.** A malformed registration means nothing can be measured. A task file that no longer matches its declared hash means something *can* be measured, just not confirmed. Conflating the two either blocks legitimate exploratory work or lets drift pass silently.

**Files:**
- Create: `src/prereg.mjs`
- Test: `test/prereg.test.mjs`
- Test fixtures: `test/fixtures/reg-ok/`, created inside the test with `mkdtemp`

**Interfaces:**
- Consumes: `canonicalJSON` from Task 2.
- Produces:
  - `loadRegistration(dir) -> { config, tasks, hash, drift }`
    - `config`: `{ model, judge_model, reps }`
    - `tasks`: array of `{ id, file, declaredSha, actualSha, kind, predict, spec }` sorted by `id`; `spec` is the parsed task JSON.
    - `hash`: 64-char lowercase hex, computed over **actual** file contents so it identifies what ran.
    - `drift`: array of `{ code, detail }`; `code` is one of `HASH_MISMATCH`, `NO_HARM_TASK`.
    - Throws `RegistrationError` (exported) on structural problems.
  - `RegistrationError` — `class RegistrationError extends Error`, with `.problems: string[]`.

- [ ] **Step 1: Write the failing test**

Create `test/prereg.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistration, RegistrationError } from "../src/prereg.mjs";
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(s).digest("hex");

function makeSuite({ omitHarm = false, corruptSha = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nb-reg-"));
  mkdirSync(join(dir, "tasks"));

  const signal = JSON.stringify({
    id: "sig", skill: "demo", kind: "signal", prompt: "Is 3 caught enough?",
    verify: { type: "any", patterns: ["denominator"] },
  });
  writeFileSync(join(dir, "tasks", "sig.json"), signal);

  const harm = JSON.stringify({
    id: "harm", skill: "demo", kind: "harm", prompt: "B-tree vs GIN?",
    verify: { type: "none", patterns: ["goodhart"], maxWords: 500 },
  });
  writeFileSync(join(dir, "tasks", "harm.json"), harm);

  const tasks = [
    { id: "sig", file: "tasks/sig.json", sha256: corruptSha ? "0".repeat(64) : sha(signal), kind: "signal", predict: "helps" },
  ];
  if (!omitHarm) {
    tasks.push({ id: "harm", file: "tasks/harm.json", sha256: sha(harm), kind: "harm", predict: "no-effect" });
  }
  writeFileSync(join(dir, "nullbench.json"),
    JSON.stringify({ model: "sonnet", judge_model: "sonnet", reps: 10, tasks }, null, 2));
  return dir;
}

test("a well-formed registration loads with no drift", () => {
  const dir = makeSuite();
  const r = loadRegistration(dir);
  assert.equal(r.drift.length, 0);
  assert.equal(r.config.reps, 10);
  assert.deepEqual(r.tasks.map((t) => t.id), ["harm", "sig"]); // sorted by id
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  rmSync(dir, { recursive: true, force: true });
});

test("the hash is stable across reformatting of nullbench.json", () => {
  const dir = makeSuite();
  const before = loadRegistration(dir).hash;
  const raw = JSON.parse(readFileSync(join(dir, "nullbench.json"), "utf8"));
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify(raw)); // minified
  assert.equal(loadRegistration(dir).hash, before);
  rmSync(dir, { recursive: true, force: true });
});

test("the hash changes when a task file changes", () => {
  const dir = makeSuite();
  const before = loadRegistration(dir).hash;
  writeFileSync(join(dir, "tasks", "sig.json"),
    JSON.stringify({ id: "sig", skill: "demo", kind: "signal", prompt: "different",
      verify: { type: "any", patterns: ["x"] } }));
  assert.notEqual(loadRegistration(dir).hash, before);
  rmSync(dir, { recursive: true, force: true });
});

test("a task file that no longer matches its declared hash is drift, not a crash", () => {
  const dir = makeSuite({ corruptSha: true });
  const r = loadRegistration(dir);
  assert.equal(r.drift.length, 1);
  assert.equal(r.drift[0].code, "HASH_MISMATCH");
  assert.match(r.drift[0].detail, /sig/);
  rmSync(dir, { recursive: true, force: true });
});

test("a suite with no harm task is drift, because it cannot be confirmatory", () => {
  const dir = makeSuite({ omitHarm: true });
  const r = loadRegistration(dir);
  assert.deepEqual(r.drift.map((d) => d.code), ["NO_HARM_TASK"]);
  rmSync(dir, { recursive: true, force: true });
});

test("structural problems abort rather than downgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-reg-"));
  assert.throws(() => loadRegistration(dir), RegistrationError); // no nullbench.json

  writeFileSync(join(dir, "nullbench.json"), "{ not json");
  assert.throws(() => loadRegistration(dir), RegistrationError);

  writeFileSync(join(dir, "nullbench.json"), JSON.stringify({ model: "sonnet" }));
  assert.throws(() => loadRegistration(dir), RegistrationError); // no reps, no tasks

  writeFileSync(join(dir, "nullbench.json"), JSON.stringify({
    model: "sonnet", judge_model: "sonnet", reps: 3,
    tasks: [{ id: "a", file: "nope.json", sha256: "0".repeat(64), kind: "signal", predict: "maybe" }],
  }));
  const e = (() => { try { loadRegistration(dir); } catch (x) { return x; } })();
  assert.ok(e instanceof RegistrationError);
  assert.ok(e.problems.some((p) => /predict/.test(p)), "bad enum reported");
  assert.ok(e.problems.some((p) => /nope\.json/.test(p)), "missing file reported");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/prereg.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/prereg.mjs`**

```js
// Loading, validating and hashing a registration.
//
// Two kinds of problem, deliberately handled differently:
//
//   Structural  -- the registration cannot be executed at all (no file, malformed
//                  JSON, missing field, bad enum, task file absent). Throws.
//   Drift       -- the registration can be executed but not confirmed (a task file no
//                  longer matches its declared hash; no harm task present). Returned.
//
// Collapsing these would either block exploratory work, which is a legitimate and
// necessary phase, or let a changed task pass as confirmed, which is the whole thing
// this project exists to stop.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJSON } from "./canonical.mjs";

export class RegistrationError extends Error {
  constructor(problems) {
    super(`registration is not executable:\n  - ${problems.join("\n  - ")}`);
    this.name = "RegistrationError";
    this.problems = problems;
  }
}

const KINDS = new Set(["signal", "harm"]);
const PREDICTIONS = new Set(["helps", "no-effect", "harms"]);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function loadRegistration(dir) {
  const regPath = join(dir, "nullbench.json");
  const problems = [];

  if (!existsSync(regPath)) throw new RegistrationError([`no nullbench.json in ${dir}`]);

  let raw;
  try {
    raw = JSON.parse(readFileSync(regPath, "utf8"));
  } catch (e) {
    throw new RegistrationError([`nullbench.json is not valid JSON: ${e.message}`]);
  }

  for (const f of ["model", "judge_model"]) {
    if (typeof raw[f] !== "string" || !raw[f]) problems.push(`"${f}" must be a non-empty string`);
  }
  if (!Number.isInteger(raw.reps) || raw.reps < 1) problems.push(`"reps" must be a positive integer`);
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) problems.push(`"tasks" must be a non-empty array`);

  if (problems.length) throw new RegistrationError(problems);

  const tasks = [];
  const seen = new Set();
  for (const [i, t] of raw.tasks.entries()) {
    const at = `tasks[${i}]`;
    if (typeof t.id !== "string" || !t.id) { problems.push(`${at}.id must be a non-empty string`); continue; }
    if (seen.has(t.id)) problems.push(`${at}.id "${t.id}" is duplicated`);
    seen.add(t.id);
    if (typeof t.file !== "string") problems.push(`${at}.file must be a string`);
    if (!/^[0-9a-f]{64}$/.test(t.sha256 ?? "")) problems.push(`${at}.sha256 must be 64 hex characters`);
    if (!KINDS.has(t.kind)) problems.push(`${at}.kind must be one of ${[...KINDS].join(", ")}`);
    if (!PREDICTIONS.has(t.predict)) problems.push(`${at}.predict must be one of ${[...PREDICTIONS].join(", ")}`);

    const abs = join(dir, t.file ?? "");
    if (typeof t.file !== "string" || !existsSync(abs)) { problems.push(`${at}.file "${t.file}" does not exist`); continue; }

    const bytes = readFileSync(abs);
    let spec;
    try {
      spec = JSON.parse(bytes.toString("utf8"));
    } catch (e) {
      problems.push(`${at}.file "${t.file}" is not valid JSON: ${e.message}`);
      continue;
    }
    tasks.push({ id: t.id, file: t.file, declaredSha: t.sha256, actualSha: sha256(bytes), kind: t.kind, predict: t.predict, spec });
  }

  if (problems.length) throw new RegistrationError(problems);

  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const drift = [];
  for (const t of tasks) {
    if (t.actualSha !== t.declaredSha) {
      drift.push({ code: "HASH_MISMATCH", detail: `task "${t.id}" (${t.file}) declared ${t.declaredSha.slice(0, 12)}..., found ${t.actualSha.slice(0, 12)}...` });
    }
  }
  if (!tasks.some((t) => t.kind === "harm")) {
    drift.push({ code: "NO_HARM_TASK", detail: "no harm task; a suite with no negative control cannot be confirmatory" });
  }

  // Hashed over actual contents, not declared ones, so the hash names what really ran.
  const body = canonicalJSON({
    model: raw.model, judge_model: raw.judge_model, reps: raw.reps,
    tasks: tasks.map((t) => ({ id: t.id, kind: t.kind, predict: t.predict, sha256: t.actualSha })),
  });
  const hash = sha256(Buffer.from(body, "utf8"));

  return { config: { model: raw.model, judge_model: raw.judge_model, reps: raw.reps }, tasks, hash, drift };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test test/prereg.test.mjs`
Expected: PASS, 6 tests. Fix the `require` noted in Step 1 before running.

- [ ] **Step 5: Commit**

```bash
git add src/prereg.mjs test/prereg.test.mjs
git commit -m "feat(prereg): load, validate and hash registrations; separate drift from structural errors"
```

---

### Task 4: Pattern verifiers

Ported from `cobra-skill/eval/run.mjs`. The negation handling is not decoration — without it a reply saying "don't investigate yet, stabilise first" is scored as diagnosing before stabilising, which was observed at −100pp.

**Files:**
- Create: `src/verify.mjs`
- Test: `test/verify.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `verify(spec, output) -> { pass: boolean, why: string }` for `spec.type` of `"any"`, `"none"`, `"ordered"`. Throws on `"judge"` (graded elsewhere) and on unknown types.

- [ ] **Step 1: Write the failing test**

Create `test/verify.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "../src/verify.mjs";

test("any: passes on a required pattern, fails without one", () => {
  const spec = { type: "any", patterns: ["denominator", "how many slipped"] };
  assert.equal(verify(spec, "What is the denominator here?").pass, true);
  assert.equal(verify(spec, "Sounds good, ship it.").pass, false);
});

test("none: a leaked pattern fails", () => {
  const spec = { type: "none", patterns: ["goodhart", "cobra"] };
  assert.equal(verify(spec, "A B-tree index orders keys.").pass, true);
  const bad = verify(spec, "This is a classic Goodhart situation.");
  assert.equal(bad.pass, false);
  assert.match(bad.why, /leaked/);
});

test("maxWords is enforced before the pattern check", () => {
  const spec = { type: "none", patterns: ["nope"], maxWords: 5 };
  const r = verify(spec, "one two three four five six");
  assert.equal(r.pass, false);
  assert.match(r.why, /over length/);
});

test("ordered: stabilise must precede diagnose", () => {
  const spec = { type: "ordered", before: ["roll back", "revert"], after: ["investigate", "root cause"] };
  assert.equal(verify(spec, "Roll back first, then investigate.").pass, true);
  assert.equal(verify(spec, "Investigate the root cause, then roll back.").pass, false);
});

test("ordered: a negated mention is not the real one", () => {
  // The bug this guards: "don't investigate yet" counts as diagnosing first unless
  // negation context is checked, which scored the better answer at -100pp.
  const spec = { type: "ordered", before: ["roll back"], after: ["investigate"] };
  const reply = "Don't investigate yet. Roll back to the last good build, then investigate.";
  assert.equal(verify(spec, reply).pass, true);
});

test("ordered: no stabilising action at all is a failure", () => {
  const spec = { type: "ordered", before: ["roll back"], after: ["investigate"] };
  assert.equal(verify(spec, "Just investigate it.").pass, false);
});

test("judge specs and unknown types throw rather than silently pass", () => {
  assert.throws(() => verify({ type: "judge", rubric: "x" }, "reply"), /judge/);
  assert.throws(() => verify({ type: "banana" }, "reply"), /unknown verifier/);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/verify.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/verify.mjs`**

```js
// Deterministic verifiers. Every decision is a substring test over the raw reply, and
// the raw reply is written to disk by the runner, so any verdict can be re-checked by
// hand later.
//
// Substring verifiers are dangerous and this module cannot fix that -- see FAILURES.md
// entries 1 and 2, where "weaken" and "miss" produced a +70.0pp artefact and a 40pp
// understatement respectively. Behaviours with many valid phrasings belong in the
// rubric judge, not here.

// A reply that says "don't investigate yet, stabilise first" mentions diagnosis before
// rollback while advocating the opposite. Naive ordering marks the better answer wrong.
const NEGATIONS = [
  // "not " is word-anchored with a leading space: without it, "you cannot roll back"
  // reads as a negated rollback because "cannot " contains "not ".
  "don't", "do not", " not ", "never", "avoid", "rather than", "instead of",
  "without", "no need to", "before you", "premature", "resist", "skip",
  "hold off", "defer", "later", "only once", "only after", "after you",
];

// Index of the earliest occurrence of any pattern that is not preceded by a negation
// cue within `window` characters. -1 when every occurrence is negated or absent.
function firstUnnegated(hay, pats, window = 45) {
  let best = -1;
  for (const p of pats) {
    const needle = p.toLowerCase();
    let from = 0;
    for (;;) {
      const i = hay.indexOf(needle, from);
      if (i === -1) break;
      // Look back only as far as the current sentence. Without this, "Don't
      // investigate yet. Roll back, then investigate." has its rollback treated as
      // negated by the "don't" in the previous sentence, and the reply scores as
      // proposing no stabilising action at all.
      let ctx = hay.slice(Math.max(0, i - window), i);
      const bound = Math.max(ctx.lastIndexOf("."), ctx.lastIndexOf("!"), ctx.lastIndexOf("?"), ctx.lastIndexOf("\n"));
      if (bound !== -1) ctx = ctx.slice(bound + 1);
      if (!NEGATIONS.some((n) => ctx.includes(n))) {
        if (best === -1 || i < best) best = i;
        break;
      }
      from = i + needle.length;
    }
  }
  return best;
}

export function verify(spec, output) {
  const hay = output.toLowerCase();
  const words = output.trim().split(/\s+/).filter(Boolean).length;

  if (spec.maxWords && words > spec.maxWords) {
    return { pass: false, why: `over length: ${words} > ${spec.maxWords} words` };
  }

  switch (spec.type) {
    case "any": {
      const hit = spec.patterns.find((p) => hay.includes(p.toLowerCase()));
      return hit ? { pass: true, why: `matched "${hit}"` }
                 : { pass: false, why: "no required pattern present" };
    }
    case "none": {
      const hit = spec.patterns.find((p) => hay.includes(p.toLowerCase()));
      return hit ? { pass: false, why: `leaked "${hit}"` }
                 : { pass: true, why: `clean (${words} words)` };
    }
    case "ordered": {
      const b = firstUnnegated(hay, spec.before);
      const a = firstUnnegated(hay, spec.after);
      if (b === -1) return { pass: false, why: "no stabilising action proposed" };
      if (a !== -1 && a < b) return { pass: false, why: "diagnosis proposed before stabilising" };
      return { pass: true, why: "stabilise precedes diagnose" };
    }
    case "judge":
      throw new Error("judge specs are graded asynchronously, not through verify()");
    default:
      throw new Error(`unknown verifier type: ${spec.type}`);
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test test/verify.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/verify.mjs test/verify.test.mjs
git commit -m "feat(verify): pattern verifiers with negation-aware ordering"
```

---

### Task 5: The process adapter and the test stub

Every later task depends on being able to run the suite without spending money. This task creates the only module that spawns a process, and the stub that replaces it offline.

**Files:**
- Create: `src/claude.mjs`
- Create: `tools/stub-claude.mjs`
- Test: `test/claude.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `invoke({ prompt, systemPromptFile = null, cwd, model, streamJson = false }) -> Promise<{ out, err, code }>` — `out` and `err` trimmed. Never throws; a spawn failure returns `{ code: -1 }`.
  - `binaryPath() -> string` — `process.env.NULLBENCH_CLAUDE_BIN || "claude"`.

**Stub contract** (used by every later test, so it is specified exactly here):
`tools/stub-claude.mjs` is an executable Node script. It reads:
- `NULLBENCH_STUB_PLAN` — path to a JSON file `{ "rules": [ { "promptIncludes": string, "arm": "control"|"treatment"|"any", "outs": string[], "code": number? } ], "default": { "outs": string[], "code": number? } }`
- `NULLBENCH_STUB_STATE` — path to a scratch JSON file the stub uses to advance through `outs` per rule, so repeated calls cycle deterministically.

Arm is inferred from the presence of `--append-system-prompt-file` in argv. The first rule whose `promptIncludes` is a substring of the prompt and whose `arm` matches wins.

- [ ] **Step 1: Write the failing test**

Create `test/claude.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { invoke } from "../src/claude.mjs";

const STUB = fileURLToPath(new URL("../tools/stub-claude.mjs", import.meta.url));

function withStub(plan, fn) {
  const dir = mkdtempSync(join(tmpdir(), "nb-stub-"));
  const planPath = join(dir, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan));
  process.env.NULLBENCH_CLAUDE_BIN = STUB;
  process.env.NULLBENCH_STUB_PLAN = planPath;
  process.env.NULLBENCH_STUB_STATE = join(dir, "state.json");
  return Promise.resolve(fn(dir)).finally(() => {
    delete process.env.NULLBENCH_CLAUDE_BIN;
    delete process.env.NULLBENCH_STUB_PLAN;
    delete process.env.NULLBENCH_STUB_STATE;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("invoke returns the stub's reply", async () => {
  await withStub({ default: { outs: ["hello"] } }, async (dir) => {
    const r = await invoke({ prompt: "anything", cwd: dir, model: "sonnet" });
    assert.equal(r.code, 0);
    assert.equal(r.out, "hello");
  });
});

test("the stub distinguishes arms by --append-system-prompt-file", async () => {
  const plan = {
    rules: [
      { promptIncludes: "smoke", arm: "treatment", outs: ["with skill"] },
      { promptIncludes: "smoke", arm: "control", outs: ["without skill"] },
    ],
    default: { outs: ["unmatched"] },
  };
  await withStub(plan, async (dir) => {
    const skill = join(dir, "SKILL.md");
    writeFileSync(skill, "# skill");
    const c = await invoke({ prompt: "the smoke test", cwd: dir, model: "sonnet" });
    const t = await invoke({ prompt: "the smoke test", cwd: dir, model: "sonnet", systemPromptFile: skill });
    assert.equal(c.out, "without skill");
    assert.equal(t.out, "with skill");
  });
});

test("outs cycle deterministically so a rule can encode a pass rate", async () => {
  const plan = { rules: [{ promptIncludes: "x", arm: "any", outs: ["a", "b", "a"] }], default: { outs: ["z"] } };
  await withStub(plan, async (dir) => {
    const got = [];
    for (let i = 0; i < 4; i++) got.push((await invoke({ prompt: "x", cwd: dir, model: "sonnet" })).out);
    assert.deepEqual(got, ["a", "b", "a", "a"]); // cycles
  });
});

test("a non-zero exit is reported, not thrown", async () => {
  await withStub({ default: { outs: [""], code: 1 } }, async (dir) => {
    const r = await invoke({ prompt: "x", cwd: dir, model: "sonnet" });
    assert.equal(r.code, 1);
  });
});

test("a missing binary returns code -1 rather than crashing the run", async () => {
  process.env.NULLBENCH_CLAUDE_BIN = "/nonexistent/nullbench-no-such-binary";
  const r = await invoke({ prompt: "x", cwd: tmpdir(), model: "sonnet" });
  assert.equal(r.code, -1);
  delete process.env.NULLBENCH_CLAUDE_BIN;
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/claude.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/claude.mjs`**

```js
// The only module in this project that spawns a process.
//
// Isolating it is what makes the protocol layer testable for free: tests point
// NULLBENCH_CLAUDE_BIN at a stub that replays recorded output, and every test outside
// test/live/ runs with no network and no API key.

import { spawn } from "node:child_process";

export function binaryPath() {
  return process.env.NULLBENCH_CLAUDE_BIN || "claude";
}

export function invoke({ prompt, systemPromptFile = null, cwd, model, streamJson = false }) {
  const args = ["-p", "--setting-sources", "project", "--model", model];
  if (streamJson) args.push("--output-format", "stream-json", "--verbose");
  if (systemPromptFile) args.push("--append-system-prompt-file", systemPromptFile);
  args.push(prompt);

  return new Promise((resolve) => {
    // cwd is always a fresh temp directory outside the repository. Running in the repo
    // lets the control arm read the skills off disk and inherit the parent CLAUDE.md,
    // which collapses every measured delta toward zero -- FAILURES.md entry 5.
    const p = spawn(binaryPath(), args, { cwd });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ out: out.trim(), err: err.trim(), code }));
    p.on("error", (e) => resolve({ out: "", err: String(e), code: -1 }));
  });
}
```

- [ ] **Step 4: Implement `tools/stub-claude.mjs`**

```js
#!/usr/bin/env node
// A fake `claude` binary. Replays scripted replies so the protocol layer can be tested
// with no network and no spend. Contract is documented in the v1 plan, Task 5.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const plan = JSON.parse(readFileSync(process.env.NULLBENCH_STUB_PLAN, "utf8"));
const statePath = process.env.NULLBENCH_STUB_STATE;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

const argv = process.argv.slice(2);
const arm = argv.includes("--append-system-prompt-file") ? "treatment" : "control";
const prompt = argv[argv.length - 1] ?? "";

const rule =
  (plan.rules ?? []).find(
    (r) => prompt.includes(r.promptIncludes) && (r.arm === "any" || r.arm === arm)
  ) ?? plan.default;

const key = rule === plan.default ? "__default__" : `${rule.promptIncludes}:${rule.arm}`;
const i = state[key] ?? 0;
state[key] = i + 1;
// Write-then-rename. Workers run concurrently against one state file; a partial write
// is read back as truncated JSON, the stub exits non-zero, and the runner records a
// dead run. Measured at roughly 30% of runs before this was made atomic.
const tmp = `${statePath}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify(state));
renameSync(tmp, statePath);

const outs = rule.outs ?? [""];
process.stdout.write(outs[i % outs.length]);
process.exit(rule.code ?? 0);
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `chmod +x tools/stub-claude.mjs && node --test test/claude.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/claude.mjs tools/stub-claude.mjs test/claude.test.mjs
git commit -m "feat(claude): process adapter behind NULLBENCH_CLAUDE_BIN, plus replay stub"
```

---

### Task 6: The blind rubric judge and its canary gate

The judge exists because substring matching cannot see behaviours with many valid phrasings. The canary exists because an ungated judge is just another unverified safeguard — exactly the class of thing cobra is about.

**Files:**
- Create: `src/judge.mjs`
- Test: `test/judge.test.mjs`

**Interfaces:**
- Consumes: `invoke` from Task 5.
- Produces:
  - `judgePrompt(task, reply) -> string`
  - `parseVerdict(text) -> { pass, why } | null`
  - `runJudge({ task, reply, model, cwd }) -> Promise<{ pass, why }>` — a judge that fails to run or returns no verdict yields `{ pass: false, why: "judge failed to run" | "judge returned no verdict" }`.
  - `loadCanaries(path, registration) -> Canary[]` — reads the on-disk file, which is keyed by task id (`{ "<task-id>": [{ label, expect, reply }] }`, the shape cobra already uses), and resolves each entry against the registration into `{ id, task, prompt, rubric, reply, expect }`. Throws `RegistrationError` on a canary naming a task that is not registered, or a task whose verifier is not `judge`.
  - `runCanaries({ canaries, model, cwd }) -> Promise<{ ok, misgrades, total }>` — takes the resolved canaries. **The rubric is never supplied by the canary file**; it is read from the task, so the gate cannot certify a judge against a rubric no task uses.

- [ ] **Step 1: Write the failing test**

Create `test/judge.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgePrompt, parseVerdict, runJudge, runCanaries, loadCanaries } from "../src/judge.mjs";

const STUB = fileURLToPath(new URL("../tools/stub-claude.mjs", import.meta.url));

function stubbed(plan) {
  const dir = mkdtempSync(join(tmpdir(), "nb-judge-"));
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  process.env.NULLBENCH_CLAUDE_BIN = STUB;
  process.env.NULLBENCH_STUB_PLAN = join(dir, "plan.json");
  process.env.NULLBENCH_STUB_STATE = join(dir, "state.json");
  return dir;
}
const unstub = (dir) => {
  delete process.env.NULLBENCH_CLAUDE_BIN;
  delete process.env.NULLBENCH_STUB_PLAN;
  delete process.env.NULLBENCH_STUB_STATE;
  rmSync(dir, { recursive: true, force: true });
};

test("the judge prompt never reveals which arm produced the reply", () => {
  const p = judgePrompt({ prompt: "Q", verify: { rubric: "R" } }, "the reply");
  assert.ok(!/control|treatment|with skill|without skill/i.test(p));
  assert.match(p, /You do not know how it was produced/);
  assert.match(p, /Do not reward or penalise vocabulary/);
});

test("the judge prompt contains the rubric and the reply but not the skill", () => {
  const p = judgePrompt({ prompt: "Q", verify: { rubric: "RUBRIC-TEXT" } }, "REPLY-TEXT");
  assert.match(p, /RUBRIC-TEXT/);
  assert.match(p, /REPLY-TEXT/);
});

test("parseVerdict reads both verdict and reason", () => {
  assert.deepEqual(parseVerdict("VERDICT: PASS\nREASON: it made the argument"),
    { pass: true, why: "it made the argument" });
  assert.equal(parseVerdict("VERDICT: FAIL\nREASON: nope").pass, false);
  assert.equal(parseVerdict("I think it was fine"), null);
});

test("a judge that returns nothing usable fails closed", async () => {
  const dir = stubbed({ default: { outs: ["waffle with no verdict"] } });
  const r = await runJudge({ task: { prompt: "Q", verify: { rubric: "R" } }, reply: "x", model: "sonnet", cwd: dir });
  assert.equal(r.pass, false);
  assert.match(r.why, /no verdict/);
  unstub(dir);
});

test("canaries pass when the judge grades known cases correctly", async () => {
  const dir = stubbed({
    rules: [
      { promptIncludes: "GOOD-REPLY", arm: "any", outs: ["VERDICT: PASS\nREASON: ok"] },
      { promptIncludes: "BAD-REPLY", arm: "any", outs: ["VERDICT: FAIL\nREASON: no"] },
    ],
    default: { outs: ["VERDICT: FAIL\nREASON: unmatched"] },
  });
  const canaries = [
    { id: "t:known-pass", task: "t", prompt: "Q", rubric: "R", reply: "GOOD-REPLY", expect: "PASS" },
    { id: "t:known-fail", task: "t", prompt: "Q", rubric: "R", reply: "BAD-REPLY", expect: "FAIL" },
  ];
  const r = await runCanaries({ canaries, model: "sonnet", cwd: dir });
  assert.equal(r.ok, true);
  assert.equal(r.misgrades.length, 0);
  assert.equal(r.total, 2);
  unstub(dir);
});

test("a misgraded canary fails the gate and names the case", async () => {
  const dir = stubbed({ default: { outs: ["VERDICT: PASS\nREASON: always passes"] } });
  const canaries = [{ id: "t:known-fail", task: "t", prompt: "Q", rubric: "R", reply: "BAD", expect: "FAIL" }];
  const r = await runCanaries({ canaries, model: "sonnet", cwd: dir });
  assert.equal(r.ok, false);
  assert.deepEqual(r.misgrades.map((m) => m.id), ["t:known-fail"]);
  unstub(dir);
});

test("a canary takes its rubric from the task, never from its own file", () => {
  const registration = { tasks: [{ id: "jg", spec: { prompt: "the question", verify: { type: "judge", rubric: "THE REAL RUBRIC" } } }] };
  const dir = mkdtempSync(join(tmpdir(), "nb-can-"));
  const f = join(dir, "canaries.json");
  writeFileSync(f, JSON.stringify({ jg: [{ label: "known-pass", expect: "PASS", reply: "r" }] }));
  const [c] = loadCanaries(f, registration);
  assert.equal(c.id, "jg:known-pass");
  assert.equal(c.rubric, "THE REAL RUBRIC");
  assert.equal(c.prompt, "the question");
  rmSync(dir, { recursive: true, force: true });
});

test("a canary naming an unregistered or non-judged task aborts the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-can-"));
  const f = join(dir, "canaries.json");
  const registration = { tasks: [{ id: "pat", spec: { prompt: "q", verify: { type: "any", patterns: ["x"] } } }] };
  writeFileSync(f, JSON.stringify({ ghost: [{ label: "a", expect: "PASS", reply: "r" }] }));
  assert.throws(() => loadCanaries(f, registration), /not registered/);
  writeFileSync(f, JSON.stringify({ pat: [{ label: "a", expect: "PASS", reply: "r" }] }));
  assert.throws(() => loadCanaries(f, registration), /not judge-graded/);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/judge.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/judge.mjs`**

```js
// The blind rubric judge, and the canary that validates it.
//
// Prompt text is adapted from cobra-skill/eval/judge-prompt.mjs (see ATTRIBUTION.md).
// It lives in one place because the grading path and the canary path must use an
// identical prompt -- otherwise the canary certifies a judge that never ran.
//
// The judge is never told which arm produced the reply and never sees the skill.
// Without that it rewards replies that sound like the skill rather than replies that do
// the right thing, which inflates every number in the report. FAILURES.md entry 1 is
// what that looks like when it happens: +70.0pp of pure diction.

import { readFileSync } from "node:fs";
import { invoke } from "./claude.mjs";
import { RegistrationError } from "./prereg.mjs";

export function judgePrompt(task, reply) {
  return [
    "You are grading one reply against a rubric. You do not know how it was produced.",
    "",
    "=== QUESTION THE REPLY WAS ANSWERING ===",
    task.prompt,
    "",
    "=== RUBRIC ===",
    task.verify.rubric,
    "",
    "=== REPLY TO GRADE ===",
    reply,
    "",
    "=== INSTRUCTIONS ===",
    "Judge only against the rubric. Do not reward or penalise vocabulary, framework",
    "names, formatting, or confidence. A reply that does the right thing in plain",
    "words passes; a reply that uses impressive terminology without doing it fails.",
    "Output exactly two lines:",
    "VERDICT: PASS or FAIL",
    "REASON: one sentence",
  ].join("\n");
}

export function parseVerdict(text) {
  const verdict = /VERDICT:\s*(PASS|FAIL)/i.exec(text);
  const reason = /REASON:\s*(.+)/i.exec(text);
  if (!verdict) return null;
  return { pass: verdict[1].toUpperCase() === "PASS", why: (reason?.[1] ?? "").trim().slice(0, 110) };
}

export async function runJudge({ task, reply, model, cwd }) {
  const { out, code } = await invoke({ prompt: judgePrompt(task, reply), cwd, model });
  if (code !== 0 || !out) return { pass: false, why: "judge failed to run" };
  const v = parseVerdict(out);
  if (!v) return { pass: false, why: "judge returned no verdict" };
  return { pass: v.pass, why: `judge: ${v.why}` };
}

// Known-pass and known-fail replies graded before any real run. A judge that misgrades
// a canary is not a judge, and the suite's judged tasks are suppressed rather than
// reported. The observed misgrade rate is published rather than assumed to be zero --
// in the cobra suite it was 1 in 40 judged runs against 0 in 63 canary gradings.
// Canaries live in a file keyed by task id and carry only a label, a reply, and the
// expected verdict. The prompt and rubric come from the registered task itself: a
// canary that supplied its own copy of the rubric would keep passing after the task's
// rubric changed, certifying a judge against text no task uses. That is precisely an
// unverified safeguard, and FAILURES.md exists because of them.
export function loadCanaries(path, registration) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const byId = new Map(registration.tasks.map((t) => [t.id, t]));
  const out = [];
  const problems = [];
  for (const [taskId, entries] of Object.entries(raw)) {
    const task = byId.get(taskId);
    if (!task) { problems.push(`canary references task "${taskId}", which is not registered`); continue; }
    if (task.spec.verify.type !== "judge") { problems.push(`canary references task "${taskId}", which is not judge-graded`); continue; }
    for (const e of entries) {
      out.push({ id: `${taskId}:${e.label}`, task: taskId, prompt: task.spec.prompt, rubric: task.spec.verify.rubric, reply: e.reply, expect: e.expect });
    }
  }
  if (problems.length) throw new RegistrationError(problems);
  return out;
}

export async function runCanaries({ canaries, model, cwd }) {
  const misgrades = [];
  for (const c of canaries) {
    const task = { prompt: c.prompt, verify: { rubric: c.rubric } };
    const got = await runJudge({ task, reply: c.reply, model, cwd });
    const expected = c.expect.toUpperCase() === "PASS";
    if (got.pass !== expected) misgrades.push({ id: c.id, expected: c.expect, got: got.pass ? "PASS" : "FAIL", why: got.why });
  }
  return { ok: misgrades.length === 0, misgrades, total: canaries.length };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test test/judge.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/judge.mjs test/judge.test.mjs
git commit -m "feat(judge): blind rubric judge with a required canary gate"
```

---

### Task 7: Report classification

The protocol's decision procedure, as one pure function. It is deliberately separate from the runner so it can be tested exhaustively without a single process spawn.

**Files:**
- Create: `src/classify.mjs`
- Test: `test/classify.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `minGraded(reps) -> number` — `Math.max(3, Math.ceil(reps * 0.8))`.
  - `classify({ registration, requested, gradedCounts, canaryOk }) -> { klass, reasons }`
    - `registration`: the Task 3 return value.
    - `requested`: `{ reps, model, judgeModel, taskIds }` — what the CLI actually ran.
    - `gradedCounts`: `{ [taskId]: { control: number, treatment: number } }`.
    - `canaryOk`: `true`, `false`, or `null` when the suite has no judged task.
    - `klass`: `"CONFIRMATORY" | "EXPLORATORY" | "VOID"`. `reasons` is a string array, empty only for CONFIRMATORY.

- [ ] **Step 1: Write the failing test**

Create `test/classify.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, minGraded } from "../src/classify.mjs";

const registration = {
  config: { model: "sonnet", judge_model: "sonnet", reps: 10 },
  tasks: [
    { id: "harm", kind: "harm", predict: "no-effect" },
    { id: "sig", kind: "signal", predict: "helps" },
  ],
  hash: "a".repeat(64),
  drift: [],
};
const requested = { reps: 10, model: "sonnet", judgeModel: "sonnet", taskIds: ["harm", "sig"] };
const full = { harm: { control: 10, treatment: 10 }, sig: { control: 10, treatment: 10 } };

test("minGraded floors at 3 and otherwise takes 80% of reps", () => {
  assert.equal(minGraded(1), 3);
  assert.equal(minGraded(3), 3);
  assert.equal(minGraded(10), 8);
  assert.equal(minGraded(20), 16);
});

test("a clean run is confirmatory", () => {
  const r = classify({ registration, requested, gradedCounts: full, canaryOk: null });
  assert.equal(r.klass, "CONFIRMATORY");
  assert.deepEqual(r.reasons, []);
});

test("a thin cell voids the batch, and void beats exploratory", () => {
  const thin = { harm: { control: 10, treatment: 10 }, sig: { control: 2, treatment: 10 } };
  const r = classify({
    registration: { ...registration, drift: [{ code: "HASH_MISMATCH", detail: "sig" }] },
    requested, gradedCounts: thin, canaryOk: null,
  });
  assert.equal(r.klass, "VOID");
  assert.ok(r.reasons.some((x) => /sig/.test(x) && /graded/.test(x)));
});

test("registration drift downgrades to exploratory", () => {
  const r = classify({
    registration: { ...registration, drift: [{ code: "HASH_MISMATCH", detail: "task \"sig\" changed" }] },
    requested, gradedCounts: full, canaryOk: null,
  });
  assert.equal(r.klass, "EXPLORATORY");
  assert.ok(r.reasons.some((x) => /changed/.test(x)));
});

test("running a subset of the registered tasks is exploratory", () => {
  const r = classify({
    registration, requested: { ...requested, taskIds: ["sig"] },
    gradedCounts: { sig: { control: 10, treatment: 10 } }, canaryOk: null,
  });
  assert.equal(r.klass, "EXPLORATORY");
  assert.ok(r.reasons.some((x) => /task set/.test(x)));
});

test("changing reps, model or judge model is exploratory", () => {
  for (const override of [{ reps: 3 }, { model: "opus" }, { judgeModel: "opus" }]) {
    const counts = { harm: { control: 3, treatment: 3 }, sig: { control: 3, treatment: 3 } };
    const r = classify({
      registration, requested: { ...requested, ...override },
      gradedCounts: override.reps ? counts : full, canaryOk: null,
    });
    assert.equal(r.klass, "EXPLORATORY", JSON.stringify(override));
  }
});

test("a failed canary is exploratory, not confirmatory", () => {
  const r = classify({ registration, requested, gradedCounts: full, canaryOk: false });
  assert.equal(r.klass, "EXPLORATORY");
  assert.ok(r.reasons.some((x) => /canar/i.test(x)));
});

test("a missing harm task blocks confirmation", () => {
  const noHarm = {
    ...registration,
    tasks: [{ id: "sig", kind: "signal", predict: "helps" }],
    drift: [{ code: "NO_HARM_TASK", detail: "no harm task; a suite with no negative control cannot be confirmatory" }],
  };
  const r = classify({
    registration: noHarm, requested: { ...requested, taskIds: ["sig"] },
    gradedCounts: { sig: { control: 10, treatment: 10 } }, canaryOk: null,
  });
  assert.equal(r.klass, "EXPLORATORY");
  assert.ok(r.reasons.some((x) => /negative control/.test(x)));
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/classify.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/classify.mjs`**

```js
// The protocol's decision procedure.
//
// Three outcomes, and the difference between the last two is the point of the project:
//
//   CONFIRMATORY -- what ran is exactly what was registered, and enough of it graded.
//   EXPLORATORY  -- the registration did not hold. Legitimate and expected; finding a
//                   discriminating task requires iteration. The numbers still print;
//                   the average does not.
//   VOID         -- too few graded runs for the numbers to mean anything. A data
//                   problem, not a registration problem, so it is not merely
//                   "exploratory" -- nothing is reported at all.
//
// VOID takes precedence. A batch that is both drifted and 83% dead is void: the
// registration question is moot when there is no data to classify.

export function minGraded(reps) {
  return Math.max(3, Math.ceil(reps * 0.8));
}

export function classify({ registration, requested, gradedCounts, canaryOk }) {
  const floor = minGraded(requested.reps);

  const thin = [];
  for (const id of requested.taskIds) {
    const c = gradedCounts[id] ?? { control: 0, treatment: 0 };
    for (const arm of ["control", "treatment"]) {
      if (c[arm] < floor) thin.push(`task "${id}" ${arm}: ${c[arm]} graded runs, ${floor} required`);
    }
  }
  if (thin.length) return { klass: "VOID", reasons: thin };

  const reasons = [];
  for (const d of registration.drift) reasons.push(d.detail);

  const registered = registration.tasks.map((t) => t.id).join(",");
  const ran = [...requested.taskIds].sort().join(",");
  if (registered !== ran) {
    reasons.push(`task set differs from the registration: registered [${registered}], ran [${ran}]`);
  }
  if (requested.reps !== registration.config.reps) {
    reasons.push(`reps differ: registered ${registration.config.reps}, ran ${requested.reps}`);
  }
  if (requested.model !== registration.config.model) {
    reasons.push(`model differs: registered ${registration.config.model}, ran ${requested.model}`);
  }
  if (requested.judgeModel !== registration.config.judge_model) {
    reasons.push(`judge model differs: registered ${registration.config.judge_model}, ran ${requested.judgeModel}`);
  }
  if (canaryOk === false) reasons.push("judge canaries misgraded; judged tasks cannot be confirmed");

  return { klass: reasons.length ? "EXPLORATORY" : "CONFIRMATORY", reasons };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test test/classify.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/classify.mjs test/classify.test.mjs
git commit -m "feat(classify): CONFIRMATORY / EXPLORATORY / VOID decision procedure"
```

---

### Task 8: Aggregation and report rendering

Where the project's central promise is mechanically enforced: no delta without its interval, and no average that hides a null.

**Files:**
- Create: `src/report.mjs`
- Test: `test/report.test.mjs`

**Interfaces:**
- Consumes: `wilson`, `newcombe`, `discriminates` from Task 1.
- Produces:
  - `pp(proportion) -> string` — signed, one decimal, `pp` suffix. `pp(0.8) === "+80.0pp"`.
  - `aggregate(records, tasks) -> Row[]` where `Row` is `{ id, kind, predict, control: {k,n,rate,ci}, treatment: {k,n,rate,ci}, delta, ci, discriminating }`. `records` are `{ task, cond, pass, failed }`; records with `failed: true` are excluded from both numerator and denominator.
  - `averageDelta(rows) -> { value: number, suppressed: boolean, why: string }`
  - `renderReport({ rows, klass, reasons, registration, requested, hash, canary }) -> string` (markdown)

- [ ] **Step 1: Write the failing test**

Create `test/report.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pp, aggregate, averageDelta, renderReport } from "../src/report.mjs";

const tasks = [
  { id: "sig", kind: "signal", predict: "helps" },
  { id: "ceil", kind: "signal", predict: "helps" },
  { id: "harm", kind: "harm", predict: "no-effect" },
];

// Reproduces the real cobra cells: 1/10 -> 9/10, 10/10 -> 10/10, 10/10 -> 10/10.
function records() {
  const out = [];
  const push = (task, cond, passes, n) => {
    for (let i = 0; i < n; i++) out.push({ task, cond, pass: i < passes, failed: false });
  };
  push("sig", "control", 1, 10);   push("sig", "treatment", 9, 10);
  push("ceil", "control", 10, 10); push("ceil", "treatment", 10, 10);
  push("harm", "control", 10, 10); push("harm", "treatment", 10, 10);
  return out;
}

test("pp formats with an explicit sign and one decimal", () => {
  assert.equal(pp(0.8), "+80.0pp");
  assert.equal(pp(-0.05), "-5.0pp");
  assert.equal(pp(0), "+0.0pp");
});

test("aggregate reproduces the cobra deltas and intervals", () => {
  const rows = aggregate(records(), tasks);
  const sig = rows.find((r) => r.id === "sig");
  assert.equal(sig.control.k, 1);
  assert.equal(sig.treatment.k, 9);
  assert.ok(Math.abs(sig.delta - 0.8) < 1e-9);
  assert.ok(Math.abs(sig.ci.lo - 0.369858) < 1e-6);
  assert.equal(sig.discriminating, true);

  const ceil = rows.find((r) => r.id === "ceil");
  assert.equal(ceil.delta, 0);
  assert.equal(ceil.discriminating, false);
});

test("runs that produced no reply leave the denominator, never counting as failures", () => {
  const recs = records().concat([
    { task: "sig", cond: "control", pass: false, failed: true },
    { task: "sig", cond: "control", pass: false, failed: true },
  ]);
  const sig = aggregate(recs, tasks).find((r) => r.id === "sig");
  assert.equal(sig.control.n, 10, "dead runs must not inflate n");
  assert.equal(sig.control.k, 1);
});

test("the average is suppressed when fewer than two signal tasks discriminate", () => {
  const rows = aggregate(records(), tasks);
  const avg = averageDelta(rows);
  assert.equal(avg.suppressed, true);
  assert.match(avg.why, /1 of 2 signal tasks/);
});

test("the average prints once two signal tasks discriminate", () => {
  const four = [...tasks, { id: "sig2", kind: "signal", predict: "helps" }];
  const recs = records();
  for (let i = 0; i < 10; i++) recs.push({ task: "sig2", cond: "control", pass: i < 2, failed: false });
  for (let i = 0; i < 10; i++) recs.push({ task: "sig2", cond: "treatment", pass: i < 9, failed: false });
  const avg = averageDelta(aggregate(recs, four));
  assert.equal(avg.suppressed, false);
  assert.ok(avg.value > 0);
});

// The guard that matters. It must run on a report where the AVERAGE prints, because
// that is the line most likely to carry a naked delta -- and an earlier version of this
// test required a leading "|", so it inspected only table cells and never saw it.
function twoDiscriminating() {
  const four = [...tasks, { id: "sig2", kind: "signal", predict: "helps" }];
  const recs = records();
  for (let i = 0; i < 10; i++) recs.push({ task: "sig2", cond: "control", pass: i < 2, failed: false });
  for (let i = 0; i < 10; i++) recs.push({ task: "sig2", cond: "treatment", pass: i < 9, failed: false });
  return aggregate(recs, four);
}

test("no line anywhere in a report carries a delta without an interval or a marker", () => {
  const render = (rows) => renderReport({
    rows, klass: "CONFIRMATORY", reasons: [],
    registration: { config: { model: "sonnet", judge_model: "sonnet", reps: 10 } },
    requested: { reps: 10, model: "sonnet", judgeModel: "sonnet" },
    hash: "a".repeat(64), canary: null,
  });
  for (const md of [render(aggregate(records(), tasks)), render(twoDiscriminating())]) {
    for (const line of md.split("\n")) {
      if (!/[+-]\d+\.\d+pp/.test(line)) continue;
      assert.ok(/\[[+-]/.test(line) || /no interval/.test(line),
        `delta with neither an interval nor a marker: ${line}`);
    }
  }
});

test("a printed average is marked as having no interval", () => {
  const md = renderReport({
    rows: twoDiscriminating(), klass: "CONFIRMATORY", reasons: [],
    registration: { config: { model: "sonnet", judge_model: "sonnet", reps: 10 } },
    requested: { reps: 10, model: "sonnet", judgeModel: "sonnet" },
    hash: "a".repeat(64), canary: null,
  });
  assert.match(md, /Average across discriminating signal tasks/);
  assert.match(md, /no interval/);
});

test("a ceiling task is flagged on its own row, not merely absent from the average", () => {
  const rows = aggregate(records(), tasks);
  const md = renderReport({
    rows, klass: "CONFIRMATORY", reasons: [],
    registration: { config: { model: "sonnet", judge_model: "sonnet", reps: 10 } },
    requested: { reps: 10, model: "sonnet", judgeModel: "sonnet" },
    hash: "a".repeat(64), canary: null,
  });
  const ceilRow = md.split("\n").find((l) => l.includes("`ceil`"));
  const sigRow = md.split("\n").find((l) => l.includes("`sig`"));
  assert.match(ceilRow, /non-discriminating/);
  assert.ok(!/non-discriminating/.test(sigRow), "a discriminating task must not be flagged");
});

test("an exploratory report says why and prints no average", () => {
  const rows = aggregate(records(), tasks);
  const md = renderReport({
    rows, klass: "EXPLORATORY", reasons: ['task "sig" changed since registration'],
    registration: { config: { model: "sonnet", judge_model: "sonnet", reps: 10 } },
    requested: { reps: 10, model: "sonnet", judgeModel: "sonnet" },
    hash: "b".repeat(64), canary: null,
  });
  assert.match(md, /EXPLORATORY/);
  assert.match(md, /changed since registration/);
  assert.match(md, /average across signal tasks: suppressed/i);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/report.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/report.mjs`**

```js
// Aggregation and rendering.
//
// Two rules are enforced here rather than left to the author's judgement, because both
// have already failed in practice:
//
//   1. No delta is ever rendered without its interval.
//   2. No average is rendered over a suite where fewer than two signal tasks
//      discriminate. The published cobra figure of +26.7pp is (80 + 0 + 0) / 3, an
//      average across two tasks that were pinned at 100% in both arms and had no
//      headroom to show anything. See FAILURES.md entry 10.

import { wilson, newcombe, discriminates } from "./stats.mjs";

export function pp(proportion) {
  const v = proportion * 100;
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(1)}pp`;
}

const pct = (p) => `${(p * 100).toFixed(0)}%`;
const ci = (i) => `[${pp(i.lo)}, ${pp(i.hi)}]`;

export function aggregate(records, tasks) {
  return tasks.map((t) => {
    const arm = (cond) => {
      const rs = records.filter((r) => r.task === t.id && r.cond === cond && !r.failed);
      const k = rs.filter((r) => r.pass).length;
      const n = rs.length;
      return { k, n, rate: n ? k / n : NaN, ci: n ? wilson(k, n) : { lo: NaN, hi: NaN } };
    };
    const control = arm("control");
    const treatment = arm("treatment");
    // Guarded like the per-arm intervals above: newcombe calls wilson, which throws at
    // n < 1. Reachable whenever a task id is passed that produced no records.
    const interval = control.n && treatment.n
      ? newcombe(control.k, control.n, treatment.k, treatment.n)
      : { lo: NaN, hi: NaN };
    return {
      id: t.id, kind: t.kind, predict: t.predict, control, treatment,
      delta: treatment.rate - control.rate, ci: interval,
      discriminating: discriminates(interval),
    };
  });
}

export function averageDelta(rows) {
  const signal = rows.filter((r) => r.kind === "signal");
  const good = signal.filter((r) => r.discriminating);
  if (good.length < 2) {
    return {
      value: NaN, suppressed: true,
      why: `${good.length} of ${signal.length} signal tasks discriminate; an average over fewer than two is not a finding`,
    };
  }
  return { value: good.reduce((s, r) => s + r.delta, 0) / good.length, suppressed: false, why: "" };
}

const HEADERS = {
  CONFIRMATORY: "This run matches its registration exactly.",
  EXPLORATORY: "This run does not match its registration. Per-task figures are shown; the average is suppressed.",
  VOID: "Too few graded runs to report anything.",
};

export function renderReport({ rows, klass, reasons, warnings = [], registration, requested, hash, canary }) {
  const L = [];
  L.push(`# nullbench report — ${klass}`, "");
  L.push(HEADERS[klass], "");
  L.push(`Registration \`${hash.slice(0, 16)}\` · model \`${requested.model}\` · judge \`${requested.judgeModel}\` · reps ${requested.reps}`, "");

  if (reasons.length) {
    L.push(`## Why this run is ${klass.toLowerCase()}`, "");
    for (const r of reasons) L.push(`- ${r}`);
    L.push("");
  }
  // Warnings are not reasons. A leakage suspicion under a heading reading "Why this run
  // is confirmatory" is nonsense, and the heuristic is too weak to change the class.
  if (warnings.length) {
    L.push("## Warnings", "");
    for (const w of warnings) L.push(`- ${w}`);
    L.push("");
  }
  if (klass === "VOID") return L.join("\n");

  const table = (kind, title) => {
    const rs = rows.filter((r) => r.kind === kind);
    if (!rs.length) return;
    L.push(`## ${title}`, "", "| Task | Predicted | Control | Treatment | Delta | 95% CI | |", "|---|---|---|---|---|---|---|");
    for (const r of rs) {
      const note = r.discriminating ? "" : "non-discriminating";
      L.push(`| \`${r.id}\` | ${r.predict} | ${pct(r.control.rate)} (${r.control.k}/${r.control.n}) | ${pct(r.treatment.rate)} (${r.treatment.k}/${r.treatment.n}) | ${pp(r.delta)} | ${ci(r.ci)} | ${note} |`);
    }
    L.push("");
  };
  table("signal", "Signal tasks — does the skill change the answer?");
  table("harm", "Harm tasks — does the skill stay quiet where it should?");

  const avg = averageDelta(rows);
  if (klass !== "CONFIRMATORY") {
    L.push(`**Average across signal tasks: suppressed** — this run is exploratory.`, "");
  } else if (avg.suppressed) {
    L.push(`**Average across signal tasks: suppressed** — ${avg.why}.`, "");
  } else {
    L.push(
      `**Average across discriminating signal tasks: ${pp(avg.value)}** ` +
      `(no interval — a mean of per-task deltas averages heterogeneous quantities and ` +
      `has no defined interval; read the per-task rows above)`, "");
  }

  if (canary) {
    L.push(canary.total === 0
      ? `Judge canaries: none found. An ungated judge is an unverified safeguard; judged tasks cannot be confirmed.`
      : `Judge canaries: ${canary.total - canary.misgrades.length}/${canary.total} graded correctly.`, "");
    // Spec 6 entry 3 is an OPEN failure mode and requires disclosure in every report
    // that used a judge. A blind spot shared by judge and subject cannot show up in a
    // canary, because canaries are hand-written to probe known failure modes.
    L.push(`**Known limitation:** the judge (\`${requested.judgeModel}\`) shares a model family with the ` +
      `subject (\`${requested.model}\`). A blind spot common to both would not be visible here, ` +
      `and the canaries cannot detect it. See FAILURES.md entry 3.`, "");
  }
  L.push("Predictions are recorded in `LEDGER.md` whether or not they were borne out.", "");
  return L.join("\n");
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test test/report.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/report.mjs test/report.test.mjs
git commit -m "feat(report): aggregation, mandatory intervals, average suppression"
```

---

### Task 9: The append-only ledger

The anti-file-drawer mechanism. Three of four cobra batches were discarded; nothing recorded that they existed.

**Files:**
- Create: `src/ledger.mjs`
- Test: `test/ledger.test.mjs`

**Interfaces:**
- Consumes: `pp` and `averageDelta` from Task 8.
- Produces: `appendEntry(path, { stamp, klass, hash, requested, rows, reasons }) -> string` — returns the appended text and writes it to `path`, creating the file with a heading if absent. Predictions are scored `HIT`/`MISS` against the observed interval.

- [ ] **Step 1: Write the failing test**

Create `test/ledger.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntry } from "../src/ledger.mjs";
import { aggregate } from "../src/report.mjs";

const tasks = [
  { id: "sig", kind: "signal", predict: "helps" },
  { id: "ceil", kind: "signal", predict: "helps" },
];
function rows() {
  const recs = [];
  const push = (task, cond, passes, n) => {
    for (let i = 0; i < n; i++) recs.push({ task, cond, pass: i < passes, failed: false });
  };
  push("sig", "control", 1, 10);   push("sig", "treatment", 9, 10);
  push("ceil", "control", 10, 10); push("ceil", "treatment", 10, 10);
  return aggregate(recs, tasks);
}
const base = {
  stamp: "2026-09-14T18:22:07Z", klass: "CONFIRMATORY", hash: "a".repeat(64),
  requested: { reps: 10, model: "sonnet", judgeModel: "sonnet" }, reasons: [],
};

test("an entry records class, hash, per-task deltas and intervals", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-led-"));
  const p = join(dir, "LEDGER.md");
  appendEntry(p, { ...base, rows: rows() });
  const text = readFileSync(p, "utf8");
  assert.match(text, /CONFIRMATORY/);
  assert.match(text, /aaaaaaaaaaaaaaaa/);
  assert.match(text, /\+80\.0pp/);
  assert.match(text, /\[\+37\.0pp, \+91\.6pp\]/);
  rmSync(dir, { recursive: true, force: true });
});

test("predictions are scored, including the ones that missed", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-led-"));
  const p = join(dir, "LEDGER.md");
  appendEntry(p, { ...base, rows: rows() });
  const text = readFileSync(p, "utf8");
  assert.match(text, /sig\b.*HIT/);
  assert.match(text, /ceil\b.*MISS/);
  rmSync(dir, { recursive: true, force: true });
});

test("entries append; nothing is ever overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-led-"));
  const p = join(dir, "LEDGER.md");
  appendEntry(p, { ...base, rows: rows() });
  appendEntry(p, { ...base, stamp: "2026-09-15T09:00:00Z", klass: "EXPLORATORY", rows: rows(), reasons: ["task changed"] });
  const text = readFileSync(p, "utf8");
  assert.match(text, /2026-09-14/);
  assert.match(text, /2026-09-15/);
  assert.match(text, /task changed/);
  rmSync(dir, { recursive: true, force: true });
});

test("a void run still lands in the ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-led-"));
  const p = join(dir, "LEDGER.md");
  appendEntry(p, { ...base, klass: "VOID", rows: [], reasons: ['task "sig" control: 2 graded runs, 8 required'] });
  const text = readFileSync(p, "utf8");
  assert.match(text, /VOID/);
  assert.match(text, /2 graded runs/);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/ledger.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/ledger.mjs`**

```js
// The append-only run ledger.
//
// Every run lands here: confirmatory, exploratory, void, and flat. There is no code
// path that runs an evaluation and does not append, which is the point -- three of the
// four batches behind cobra's published table were discarded, and nothing recorded
// that they had happened. A published delta means something when a reader can see the
// runs that did not make the README.

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { pp, averageDelta } from "./report.mjs";

const HEADING = `# Run ledger

Every nullbench run in this repository, in order, including runs that were voided,
exploratory, or showed nothing. Appended automatically; do not edit by hand.
`;

// A prediction is a HIT when the observed interval agrees with what was declared:
// "helps" needs an interval entirely above zero, "harms" entirely below, "no-effect"
// needs an interval that spans zero.
function score(row) {
  const above = row.ci.lo > 0;
  const below = row.ci.hi < 0;
  if (row.predict === "helps") return above ? "HIT" : "MISS";
  if (row.predict === "harms") return below ? "HIT" : "MISS";
  return !above && !below ? "HIT" : "MISS";
}

export function appendEntry(path, { stamp, klass, hash, requested, rows, reasons }) {
  if (!existsSync(path)) writeFileSync(path, HEADING);

  const L = [];
  L.push("");
  L.push(`## ${stamp} · ${klass} · H=${hash.slice(0, 16)}`);
  L.push("```");
  L.push(`model=${requested.model} judge=${requested.judgeModel} reps=${requested.reps}`);
  for (const r of rows) {
    const note = r.discriminating ? "" : "  (non-discriminating)";
    L.push(
      `${r.id.padEnd(24)} ${r.kind.padEnd(6)} predict=${r.predict.padEnd(9)} ` +
      `${String(r.control.k).padStart(3)}/${r.control.n} -> ${String(r.treatment.k).padStart(3)}/${r.treatment.n}  ` +
      `${pp(r.delta).padStart(8)} [${pp(r.ci.lo)}, ${pp(r.ci.hi)}]  ${score(r)}${note}`
    );
  }
  if (rows.length) {
    const avg = averageDelta(rows);
    L.push(avg.suppressed || klass !== "CONFIRMATORY"
      ? `average across signal tasks: suppressed — ${klass !== "CONFIRMATORY" ? `run is ${klass.toLowerCase()}` : avg.why}`
      : `average across discriminating signal tasks: ${pp(avg.value)} (no interval — see per-task rows)`);
  }
  for (const r of reasons) L.push(`note: ${r}`);
  L.push("```");
  L.push("");

  const text = L.join("\n");
  appendFileSync(path, text);
  return text;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test test/ledger.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ledger.mjs test/ledger.test.mjs
git commit -m "feat(ledger): append-only run ledger with scored predictions"
```

---

### Task 10: The paired runner

**Files:**
- Create: `src/runner.mjs`
- Test: `test/runner.test.mjs`

**Interfaces:**
- Consumes: `invoke` (Task 5), `verify` (Task 4), `runJudge` (Task 6).
- Produces:
  - `runSuite({ registration, requested, skillFile, rawDir = null, concurrency = 4, onProgress = () => {} }) -> Promise<{ records }>`
    - `records`: `{ task, cond, rep, pass, failed, why }[]`. `failed: true` marks a run that produced no reply; it is never a failed answer.
    - `skillFile`: absolute path to the `SKILL.md` injected in the treatment arm.
  - `gradedCounts(records) -> { [taskId]: { control, treatment } }`

- [ ] **Step 1: Write the failing test**

Create `test/runner.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite, gradedCounts } from "../src/runner.mjs";

const STUB = fileURLToPath(new URL("../tools/stub-claude.mjs", import.meta.url));

function env(plan) {
  const dir = mkdtempSync(join(tmpdir(), "nb-run-"));
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(dir, "SKILL.md"), "# demo skill");
  process.env.NULLBENCH_CLAUDE_BIN = STUB;
  process.env.NULLBENCH_STUB_PLAN = join(dir, "plan.json");
  process.env.NULLBENCH_STUB_STATE = join(dir, "state.json");
  return dir;
}
const clean = (dir) => {
  for (const k of ["NULLBENCH_CLAUDE_BIN", "NULLBENCH_STUB_PLAN", "NULLBENCH_STUB_STATE"]) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
};

const registration = {
  config: { model: "sonnet", judge_model: "sonnet", reps: 4 },
  tasks: [{
    id: "sig", kind: "signal", predict: "helps",
    spec: { id: "sig", prompt: "the smoke test question", verify: { type: "any", patterns: ["denominator"] } },
  }],
  hash: "a".repeat(64), drift: [],
};
const requested = { reps: 4, model: "sonnet", judgeModel: "sonnet", taskIds: ["sig"] };

test("treatment and control are graded independently", async () => {
  const dir = env({
    rules: [
      { promptIncludes: "smoke test question", arm: "treatment", outs: ["what is the denominator"] },
      { promptIncludes: "smoke test question", arm: "control", outs: ["looks fine, ship it"] },
    ],
    default: { outs: ["unmatched"] },
  });
  const { records } = await runSuite({ registration, requested, skillFile: join(dir, "SKILL.md"), concurrency: 2 });
  assert.equal(records.length, 8);
  const t = records.filter((r) => r.cond === "treatment");
  const c = records.filter((r) => r.cond === "control");
  assert.ok(t.every((r) => r.pass));
  assert.ok(c.every((r) => !r.pass));
  clean(dir);
});

test("a run that produced no reply is failed, not a wrong answer", async () => {
  const dir = env({ default: { outs: [""], code: 1 } });
  const { records } = await runSuite({ registration, requested, skillFile: join(dir, "SKILL.md") });
  assert.ok(records.every((r) => r.failed));
  const counts = gradedCounts(records);
  assert.equal(counts.sig.control, 0, "dead runs must not count as graded");
  clean(dir);
});

test("raw replies are written to disk so any verdict can be re-checked", async () => {
  const dir = env({ default: { outs: ["the denominator matters"] } });
  const raw = join(dir, "raw");
  await runSuite({ registration, requested, skillFile: join(dir, "SKILL.md"), rawDir: raw });
  const files = readdirSync(raw);
  assert.equal(files.length, 8);
  assert.ok(files.includes("sig__control__1.txt"));
  clean(dir);
});

test("judged tasks route to the judge instead of the pattern verifier", async () => {
  const judged = {
    ...registration,
    tasks: [{
      id: "jg", kind: "signal", predict: "helps",
      spec: { id: "jg", prompt: "judge me", verify: { type: "judge", rubric: "RUBRIC" } },
    }],
  };
  const dir = env({
    rules: [{ promptIncludes: "RUBRIC", arm: "any", outs: ["VERDICT: PASS\nREASON: fine"] }],
    default: { outs: ["a reply"] },
  });
  const { records } = await runSuite({
    registration: judged, requested: { ...requested, taskIds: ["jg"] }, skillFile: join(dir, "SKILL.md"),
  });
  assert.ok(records.every((r) => r.pass), "all graded PASS by the stubbed judge");
  assert.ok(records.every((r) => /judge:/.test(r.why)));
  clean(dir);
});

test("gradedCounts reports per-arm graded totals", () => {
  const recs = [
    { task: "a", cond: "control", pass: true, failed: false },
    { task: "a", cond: "control", pass: false, failed: true },
    { task: "a", cond: "treatment", pass: true, failed: false },
  ];
  assert.deepEqual(gradedCounts(recs), { a: { control: 1, treatment: 1 } });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/runner.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/runner.mjs`**

```js
// Paired execution.
//
// Control and treatment are identical in every respect except that treatment has the
// skill's SKILL.md appended to the system prompt. Both run in a fresh temp directory
// outside the repository with --setting-sources project, so neither arm can see the
// installed skills, the repository, or its CLAUDE.md.

import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "./claude.mjs";
import { assertIsolated } from "./leakage.mjs";
import { verify } from "./verify.mjs";
import { runJudge } from "./judge.mjs";

// A task may declare a fixture: a small project copied fresh for every run, so a run
// that edits files cannot contaminate the next one.
function makeCwd(task, fixtureRoot, shared) {
  if (!task.spec.fixture) return { cwd: shared, temporary: false };
  const src = join(fixtureRoot, task.spec.fixture);
  if (!existsSync(src)) {
    throw new Error(`task "${task.id}" declares fixture "${task.spec.fixture}", but ${src} does not exist`);
  }
  const dir = mkdtempSync(join(tmpdir(), "nullbench-fx-"));
  cpSync(src, dir, { recursive: true });
  // A fixture is a real project copied in, and it may carry its own CLAUDE.md or
  // .claude directory. Every cwd is checked, not just the shared one.
  const iso = assertIsolated(dir, fixtureRoot);
  if (!iso.ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`fixture sandbox for "${task.id}" is not isolated:\n  - ${iso.problems.join("\n  - ")}`);
  }
  return { cwd: dir, temporary: true };
}

export function gradedCounts(records) {
  const out = {};
  for (const r of records) {
    out[r.task] ??= { control: 0, treatment: 0 };
    if (!r.failed) out[r.task][r.cond] += 1;
  }
  return out;
}

export async function runSuite({
  registration, requested, skillFile, fixtureRoot = ".", rawDir = null,
  concurrency = 4, onProgress = () => {},
}) {
  const shared = mkdtempSync(join(tmpdir(), "nullbench-"));
  if (rawDir) mkdirSync(rawDir, { recursive: true });

  const byId = new Map(registration.tasks.map((t) => [t.id, t]));
  const jobs = [];
  for (const id of requested.taskIds) {
    const task = byId.get(id);
    for (const cond of ["control", "treatment"]) {
      for (let rep = 1; rep <= requested.reps; rep++) jobs.push({ task, cond, rep });
    }
  }

  const records = [];
  let done = 0;

  async function worker(queue) {
    while (queue.length) {
      const { task, cond, rep } = queue.shift();
      const { cwd, temporary } = makeCwd(task, fixtureRoot, shared);
      const { out, err, code } = await invoke({
        prompt: task.spec.prompt,
        systemPromptFile: cond === "treatment" ? skillFile : null,
        cwd, model: requested.model,
      });
      if (temporary) rmSync(cwd, { recursive: true, force: true });

      const name = `${task.id}__${cond}__${rep}`;
      if (rawDir) writeFileSync(join(rawDir, `${name}.txt`), out || `<<no output>>\n${err}`);

      let v;
      if (code !== 0 || !out) {
        // Not a wrong answer -- no answer. Counting these as failures let an 83%-dead
        // batch print a tidy -13.3pp. FAILURES.md entry 8.
        v = { pass: false, failed: true, why: `run failed (exit ${code}): ${(out || err).slice(0, 80)}` };
      } else if (task.spec.verify.type === "judge") {
        v = await runJudge({ task: task.spec, reply: out, model: requested.judgeModel, cwd: shared });
      } else {
        v = verify(task.spec.verify, out);
      }

      records.push({ task: task.id, cond, rep, pass: v.pass, failed: !!v.failed, why: v.why });
      onProgress(++done, jobs.length, name, v.pass);
    }
  }

  const queue = [...jobs];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker(queue)));
  rmSync(shared, { recursive: true, force: true });
  return { records };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test test/runner.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runner.mjs test/runner.test.mjs
git commit -m "feat(runner): paired execution with sandboxing and dead-run exclusion"
```

---

### Task 11: CLI, cost preflight and exit codes

**Files:**
- Create: `src/cli.mjs`
- Create: `bin/nullbench.mjs`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `parseArgs(argv) -> { dir, reps, model, judgeModel, taskIds, yes, dryRun, skill }`
  - `plan(registration, requested) -> { subjectRuns, judgeRuns, total }`
  - `main(argv, { stdout, stdin }) -> Promise<number>` — the process exit code. `0` for CONFIRMATORY and EXPLORATORY, `1` for VOID, `2` for a `RegistrationError`.

**CLI contract:**

```
nullbench [dir] [--reps N] [--model M] [--judge-model M] [--task ID]... [--yes] [--dry-run]
```

`--skill PATH` overrides the `SKILL.md` location, which otherwise defaults to `<dir>/SKILL.md`.
Defaults for `reps`, `model` and `judge-model` come from the registration, so the common
invocation `nullbench .` runs exactly what was registered.

- [ ] **Step 1: Write the failing test**

Create `test/cli.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, plan } from "../src/cli.mjs";

const registration = {
  config: { model: "sonnet", judge_model: "sonnet", reps: 10 },
  tasks: [
    { id: "sig", kind: "signal", predict: "helps", spec: { verify: { type: "judge", rubric: "r" } } },
    { id: "harm", kind: "harm", predict: "no-effect", spec: { verify: { type: "none", patterns: [] } } },
  ],
  hash: "a".repeat(64), drift: [],
};

test("defaults come from the registration, so `nullbench .` runs what was registered", () => {
  const a = parseArgs(["."]);
  assert.equal(a.dir, ".");
  assert.equal(a.reps, null);
  assert.equal(a.model, null);
  assert.deepEqual(a.taskIds, []);
  assert.equal(a.yes, false);
});

test("flags override and --task accumulates", () => {
  const a = parseArgs(["bench", "--reps", "3", "--model", "opus", "--task", "x", "--task", "y", "--yes", "--dry-run"]);
  assert.equal(a.dir, "bench");
  assert.equal(a.reps, 3);
  assert.equal(a.model, "opus");
  assert.deepEqual(a.taskIds, ["x", "y"]);
  assert.equal(a.yes, true);
  assert.equal(a.dryRun, true);
});

test("the preflight counts subject runs and judge calls separately", () => {
  const requested = { reps: 10, model: "sonnet", judgeModel: "sonnet", taskIds: ["sig", "harm"] };
  const p = plan(registration, requested);
  assert.equal(p.subjectRuns, 40);  // 2 tasks x 2 arms x 10 reps
  assert.equal(p.judgeRuns, 20);    // only the judged task, both arms
  assert.equal(p.total, 60);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/cli.mjs`**

```js
// Flag parsing, cost preflight, orchestration, exit codes.

import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRegistration, RegistrationError } from "./prereg.mjs";
import { runSuite, gradedCounts } from "./runner.mjs";
import { runCanaries, loadCanaries } from "./judge.mjs";
import { classify } from "./classify.mjs";
import { aggregate, renderReport } from "./report.mjs";
import { appendEntry } from "./ledger.mjs";
import { assertIsolated, distinctiveTerms, scanControlLeakage } from "./leakage.mjs";

function intArg(raw, flag) {
  const v = Number(raw);
  // Number("abc") is NaN, and `args.reps ?? registration.reps` does not catch NaN --
  // it flowed through to a "TOTAL NaN invocations" preflight and a RangeError later.
  if (!Number.isInteger(v) || v < 1) throw new RegistrationError([`${flag} must be a positive integer, got "${raw}"`]);
  return v;
}

export function parseArgs(argv) {
  const out = { dir: ".", reps: null, model: null, judgeModel: null, taskIds: [], yes: false, dryRun: false, skill: null, costPerCall: 0.02 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reps") out.reps = intArg(argv[++i], "--reps");
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--judge-model") out.judgeModel = argv[++i];
    else if (a === "--task") out.taskIds.push(argv[++i]);
    else if (a === "--skill") out.skill = argv[++i];
    else if (a === "--cost-per-call") out.costPerCall = Number(argv[++i]);
    else if (a === "--yes") out.yes = true;
    else if (a === "--dry-run") out.dryRun = true;
    else rest.push(a);
  }
  if (rest.length) out.dir = rest[0];
  return out;
}

export function plan(registration, requested) {
  const byId = new Map(registration.tasks.map((t) => [t.id, t]));
  const chosen = requested.taskIds.map((id) => byId.get(id));
  const subjectRuns = chosen.length * 2 * requested.reps;
  const judgeRuns = chosen.filter((t) => t.spec.verify.type === "judge").length * 2 * requested.reps;
  return { subjectRuns, judgeRuns, total: subjectRuns + judgeRuns };
}

function confirm(stdin, stdout, question) {
  return new Promise((res) => {
    stdout.write(question);
    stdin.setEncoding("utf8");
    stdin.once("data", (d) => res(/^\s*y(es)?\s*$/i.test(String(d))));
  });
}

export async function main(argv, { stdout = process.stdout, stdin = process.stdin } = {}) {
  const args = parseArgs(argv);
  const dir = resolve(args.dir);

  let registration;
  try {
    registration = loadRegistration(dir);
  } catch (e) {
    if (e instanceof RegistrationError) { stdout.write(`${e.message}\n`); return 2; }
    throw e;
  }

  const requested = {
    reps: args.reps ?? registration.config.reps,
    model: args.model ?? registration.config.model,
    judgeModel: args.judgeModel ?? registration.config.judge_model,
    taskIds: args.taskIds.length ? args.taskIds : registration.tasks.map((t) => t.id),
  };

  // Structural, not drift: an unknown id and a missing SKILL.md both mean the run
  // cannot happen. Without these, --task nope threw a TypeError deep in plan(), and a
  // missing SKILL.md crashed AFTER the whole batch was paid for.
  const known = new Set(registration.tasks.map((t) => t.id));
  const unknown = requested.taskIds.filter((id) => !known.has(id));
  const skillFile = args.skill ? resolve(args.skill) : join(dir, "SKILL.md");
  const structural = [
    ...unknown.map((id) => `--task "${id}" is not in the registration`),
    ...(existsSync(skillFile) ? [] : [`no SKILL.md at ${skillFile}`]),
  ];
  if (structural.length) { stdout.write(new RegistrationError(structural).message + "\n"); return 2; }

  const p = plan(registration, requested);
  stdout.write(
    `nullbench — ${registration.tasks.length} registered task(s), running ${requested.taskIds.length}\n` +
    `  registration  ${registration.hash.slice(0, 16)}\n` +
    `  model         ${requested.model} (judge ${requested.judgeModel}), reps ${requested.reps}\n` +
    `  subject runs  ${p.subjectRuns}\n` +
    `  judge calls   ${p.judgeRuns}\n` +
    `  TOTAL         ${p.total} CLI invocations\n` +
    `  est. spend    ~$${(p.total * args.costPerCall).toFixed(2)} at an assumed ` +
    `$${args.costPerCall.toFixed(2)}/call — override with --cost-per-call\n`
  );
  if (registration.drift.length) {
    stdout.write(`  drift detected — this run cannot be confirmatory:\n`);
    for (const d of registration.drift) stdout.write(`    - ${d.detail}\n`);
  }
  if (args.dryRun) return 0;
  if (!args.yes && !(await confirm(stdin, stdout, "Proceed? [y/N] "))) {
    stdout.write("aborted\n");
    return 0;
  }

  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const outDir = join(dir, "results", stamp.replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });

  const hasJudged = requested.taskIds.some(
    (id) => registration.tasks.find((t) => t.id === id).spec.verify.type === "judge");
  let canary = null;
  if (hasJudged) {
    const cPath = join(dir, "canaries.json");
    if (!existsSync(cPath)) {
      stdout.write(`\nThis suite has judge-graded tasks but no canaries.json.\n` +
        `An ungated judge is an unverified safeguard; judged results cannot be confirmed.\n`);
      canary = { ok: false, misgrades: [{ id: "missing", why: "no canaries.json" }], total: 0 };
    } else {
      const canarySandbox = mkdtempSync(join(tmpdir(), "nullbench-canary-"));
      const iso = assertIsolated(canarySandbox, dir);
      if (!iso.ok) throw new Error(`canary sandbox is not isolated:\n  - ${iso.problems.join("\n  - ")}`);
      canary = await runCanaries({
        canaries: loadCanaries(cPath, registration), model: requested.judgeModel, cwd: canarySandbox });
      rmSync(canarySandbox, { recursive: true, force: true });
      stdout.write(`judge canaries: ${canary.total - canary.misgrades.length}/${canary.total} correct\n`);
    }
  }

  const { records } = await runSuite({
    registration, requested, skillFile, fixtureRoot: dir, rawDir: join(outDir, "raw"),
    onProgress: (done, total, name, pass) =>
      stdout.write(`\r  ${done}/${total}  ${pass ? "PASS" : "FAIL"}  ${name.padEnd(42)}`),
  });
  stdout.write("\n\n");

  const counts = gradedCounts(records);
  const { klass, reasons } = classify({
    registration, requested, gradedCounts: counts, canaryOk: canary ? canary.ok : null });
  const rows = klass === "VOID" ? [] : aggregate(records, registration.tasks.filter((t) => requested.taskIds.includes(t.id)));

  // Everything from here can throw, and by now the batch has been paid for. The ledger
  // append runs in `finally` so a crash cannot quietly delete a run from the record --
  // the file drawer is the failure this project is named after.
  let md = `# nullbench report — ${klass}\n\n(report rendering failed; see records.json)\n`;
  const warnings = [];
  try {
    const terms = distinctiveTerms(readFileSync(skillFile, "utf8"));
    const leak = scanControlLeakage({ rawDir: join(outDir, "raw"), terms });
    if (leak.suspicious) {
      warnings.push(
        `possible control-arm leakage: ${leak.hits}/${leak.checked} control replies contain ` +
        `the skill's distinctive vocabulary. A weak heuristic, not proof — see FAILURES.md entry 5.`);
    }
    md = renderReport({ rows, klass, reasons, warnings, registration, requested, hash: registration.hash, canary });
    writeFileSync(join(outDir, "report.md"), md);
    writeFileSync(join(outDir, "records.json"), JSON.stringify({ stamp, hash: registration.hash, klass, requested, records }, null, 2));
  } finally {
    appendEntry(join(dir, "LEDGER.md"), { stamp, klass, hash: registration.hash, requested, rows, reasons: [...reasons, ...warnings] });
  }

  stdout.write(`${md}\n`);
  stdout.write(`Report: ${join(outDir, "report.md")}\nLedger: ${join(dir, "LEDGER.md")}\n`);
  return klass === "VOID" ? 1 : 0;
}
```

- [ ] **Step 4: Implement `bin/nullbench.mjs`**

```js
#!/usr/bin/env node
import { main } from "../src/cli.mjs";
process.exitCode = await main(process.argv.slice(2));
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `chmod +x bin/nullbench.mjs && node --test test/cli.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/cli.mjs bin/nullbench.mjs test/cli.test.mjs
git commit -m "feat(cli): orchestration, cost preflight and protocol exit codes"
```

---

### Task 12: Sandbox isolation and the leakage probe

Spec §6 entry 5. Control-arm leakage is the failure that produces no error and no
symptom — every delta simply shrinks toward zero and the skill looks useless. Two
mechanisms, deliberately of unequal strength, and the plan says which is which:

- **Isolation assertion** — deterministic, free, reliable. The sandbox is checked for
  the files that caused the original leak before any run starts.
- **Vocabulary scan** — a heuristic, run after the fact over the control replies
  already on disk. It costs nothing extra and it is *weak*: it false-positives on
  skills whose vocabulary is ordinary English, and it cannot see the model knowing the
  skill from its installed copy or from training. It warns; it never confirms.

Shipping the weak one labelled weak is the point. Shipping it labelled "leakage
detection" would be the exact move `FAILURES.md` documents.

**Files:**
- Create: `src/leakage.mjs`
- Modify: `src/cli.mjs` (wire both mechanisms into the run)
- Test: `test/leakage.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `assertIsolated(cwd, repoRoot) -> { ok, problems }` — `problems` names each reason
    the directory is not a clean sandbox.
  - `distinctiveTerms(skillText, limit = 12) -> string[]` — lowercase multi-word
    phrases and uncommon single words drawn from the skill body, for the scan.
  - `scanControlLeakage({ rawDir, terms, threshold = 0.5 }) -> { checked, hits, rate, suspicious }`
    — reads `*__control__*.txt`, returns the fraction of control replies containing any
    term. `suspicious` is `rate >= threshold`.

- [ ] **Step 1: Write the failing test**

Create `test/leakage.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertIsolated, distinctiveTerms, scanControlLeakage } from "../src/leakage.mjs";

test("a clean temp directory outside the repo is isolated", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-iso-"));
  const r = assertIsolated(dir, "/Users/someone/code/nullbench");
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  rmSync(dir, { recursive: true, force: true });
});

test("a directory inside the repo is not isolated", () => {
  const repo = mkdtempSync(join(tmpdir(), "nb-repo-"));
  const inside = join(repo, "sub");
  mkdirSync(inside);
  const r = assertIsolated(inside, repo);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /inside the repository/.test(p)));
  rmSync(repo, { recursive: true, force: true });
});

test("the exact files that caused the original leak are detected", () => {
  for (const name of ["CLAUDE.md", ".claude", "skills"]) {
    const dir = mkdtempSync(join(tmpdir(), "nb-iso-"));
    if (name === "CLAUDE.md") writeFileSync(join(dir, name), "# project");
    else mkdirSync(join(dir, name));
    const r = assertIsolated(dir, "/elsewhere");
    assert.equal(r.ok, false, `${name} should break isolation`);
    assert.ok(r.problems.some((p) => p.includes(name)));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("distinctiveTerms prefers phrases and skips common words", () => {
  const skill = `# cobra
Ask what the measure actually rewards. The cheapest way to satisfy a coverage gate
is a test that asserts nothing. Watch for the perverse incentive.`;
  const terms = distinctiveTerms(skill);
  assert.ok(terms.some((t) => t.includes("perverse incentive")));
  assert.ok(!terms.includes("the"), "stopwords must not become terms");
  assert.ok(!terms.includes("is"));
});

test("the scan reports the control-arm hit rate and flags a high one", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-scan-"));
  writeFileSync(join(dir, "t__control__1.txt"), "this is a perverse incentive");
  writeFileSync(join(dir, "t__control__2.txt"), "this is a perverse incentive too");
  writeFileSync(join(dir, "t__control__3.txt"), "an unrelated answer");
  writeFileSync(join(dir, "t__treatment__1.txt"), "perverse incentive everywhere");
  const r = scanControlLeakage({ rawDir: dir, terms: ["perverse incentive"] });
  assert.equal(r.checked, 3, "treatment replies are not scanned");
  assert.equal(r.hits, 2);
  assert.ok(Math.abs(r.rate - 2 / 3) < 1e-9);
  assert.equal(r.suspicious, true);
  rmSync(dir, { recursive: true, force: true });
});

test("a clean control arm is not flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-scan-"));
  writeFileSync(join(dir, "t__control__1.txt"), "an ordinary answer");
  writeFileSync(join(dir, "t__control__2.txt"), "another ordinary answer");
  const r = scanControlLeakage({ rawDir: dir, terms: ["perverse incentive"] });
  assert.equal(r.hits, 0);
  assert.equal(r.suspicious, false);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/leakage.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/leakage.mjs`**

```js
// Two checks on control-arm contamination, of deliberately unequal strength.
//
// The failure being guarded: running the subject in the repository let the control arm
// read the skills off disk and inherit the parent CLAUDE.md describing them. Control
// replies came back in the skill's own vocabulary and every delta collapsed toward
// zero. There was no error and no symptom. FAILURES.md entry 5.
//
// assertIsolated is deterministic and reliable. scanControlLeakage is a heuristic and
// is documented as one: it false-positives on skills whose vocabulary is ordinary
// English, and it cannot detect the model knowing the skill from its installed copy or
// from training. It raises a question; it never answers one.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

const FORBIDDEN = ["CLAUDE.md", ".claude", "skills", "AGENTS.md"];

export function assertIsolated(cwd, repoRoot) {
  const problems = [];
  const abs = resolve(cwd);
  const root = resolve(repoRoot);
  const rel = relative(root, abs);
  // rel === "" means cwd IS the repository root -- the worst case, and an earlier
  // version skipped it because of a truthiness check on rel.
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    problems.push(`sandbox ${abs} is inside the repository at ${root}; the control arm can read the skill`);
  }
  for (const name of FORBIDDEN) {
    if (existsSync(join(abs, name))) problems.push(`sandbox contains ${name}, which the control arm must not see`);
  }
  return { ok: problems.length === 0, problems };
}

const STOP = new Set(("the a an and or but if is are was were be been being to of in on at by for with from as that this these those it its " +
  "you your we our they their he she them do does did not no yes can will would should could may might must have has had " +
  "what which who when where why how all any some each more most other into than then so such only own same too very").split(" "));

export function distinctiveTerms(skillText, limit = 12) {
  const body = skillText.replace(/^---[\s\S]*?---/, " ").toLowerCase();
  const words = body.split(/[^a-z']+/).filter(Boolean);

  // Bigrams whose halves are both content words carry far more signal than any single
  // word, and are much less likely to appear in an unrelated reply by chance.
  const bigrams = new Map();
  for (let i = 0; i < words.length - 1; i++) {
    const [a, b] = [words[i], words[i + 1]];
    if (STOP.has(a) || STOP.has(b) || a.length < 4 || b.length < 4) continue;
    const key = `${a} ${b}`;
    bigrams.set(key, (bigrams.get(key) ?? 0) + 1);
  }
  const phrases = [...bigrams.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);

  const singles = [...new Set(words.filter((w) => w.length >= 8 && !STOP.has(w)))];
  return [...phrases, ...singles].slice(0, limit);
}

export function scanControlLeakage({ rawDir, terms, threshold = 0.5 }) {
  if (!existsSync(rawDir) || terms.length === 0) return { checked: 0, hits: 0, rate: 0, suspicious: false };
  const files = readdirSync(rawDir).filter((f) => f.includes("__control__"));
  let hits = 0;
  for (const f of files) {
    const text = readFileSync(join(rawDir, f), "utf8").toLowerCase();
    if (terms.some((t) => text.includes(t))) hits += 1;
  }
  const rate = files.length ? hits / files.length : 0;
  return { checked: files.length, hits, rate, suspicious: rate >= threshold };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test test/leakage.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Confirm the consumers already wire it in**

**This task runs BEFORE Tasks 10 and 11** (see Execution Order at the top of this plan).
Both of those tasks' source blocks are already written against this module, so there is
nothing to modify here — only to confirm the contract they expect:

- `src/runner.mjs` (Task 10) imports `assertIsolated` and calls it inside `makeCwd` for
  every fixture sandbox, and in `runSuite` for the shared sandbox.
- `src/cli.mjs` (Task 11) imports all three functions: `assertIsolated` for the canary
  sandbox, and `distinctiveTerms` + `scanControlLeakage` inside the `try` block whose
  `finally` appends the ledger entry.

A leakage suspicion is passed to `renderReport` as a **warning**, not a reason, and does
**not** change the run's class — the heuristic is not strong enough to overturn a
registration. It is surfaced permanently in the ledger.

Nothing to do in this step but read those two contracts so the exported signatures
match. If they do not, this module is wrong, not the consumers.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. The e2e suites still classify as before — the stub's replies do not
contain the demo skill's vocabulary.

- [ ] **Step 7: Commit**

```bash
git add src/leakage.mjs test/leakage.test.mjs src/cli.mjs src/runner.mjs
git commit -m "feat(leakage): sandbox isolation assertion plus a labelled-weak vocabulary scan"
```

---

### Task 13: End-to-end protocol tests

Every earlier task tested a module. This one tests the promises, through `main()`, with no network and no spend. If any of these six regress, the tool is lying.

**Files:**
- Create: `test/e2e/helpers.mjs`
- Create: `test/e2e/protocol.test.mjs`

**Interfaces:**
- Consumes: `main` from Task 11, the stub from Task 5.
- Produces: `makeSuite({ tasks, reps, omitHarm }) -> { dir, registerAll }` and `capture()` — test-only.

- [ ] **Step 1: Write `test/e2e/helpers.mjs`**

```js
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const STUB = fileURLToPath(new URL("../../tools/stub-claude.mjs", import.meta.url));
const sha = (s) => createHash("sha256").update(s).digest("hex");

// Builds a suite on disk and returns its directory. `tasks` are task specs; the
// registration is written with correct hashes unless `corrupt` names a task to break.
export function makeSuite({ tasks, reps = 4, omitHarm = false, corrupt = null }) {
  const dir = mkdtempSync(join(tmpdir(), "nb-e2e-"));
  mkdirSync(join(dir, "tasks"));
  writeFileSync(join(dir, "SKILL.md"), "# demo skill\nSay the word denominator.");

  const entries = [];
  for (const t of tasks) {
    if (omitHarm && t.kind === "harm") continue;
    const body = JSON.stringify(t);
    writeFileSync(join(dir, "tasks", `${t.id}.json`), body);
    entries.push({
      id: t.id, file: `tasks/${t.id}.json`,
      sha256: corrupt === t.id ? "0".repeat(64) : sha(body),
      kind: t.kind, predict: t.predict ?? (t.kind === "harm" ? "no-effect" : "helps"),
    });
  }
  writeFileSync(join(dir, "nullbench.json"),
    JSON.stringify({ model: "sonnet", judge_model: "sonnet", reps, tasks: entries }, null, 2));
  return dir;
}

export function useStub(dir, plan) {
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  process.env.NULLBENCH_CLAUDE_BIN = STUB;
  process.env.NULLBENCH_STUB_PLAN = join(dir, "plan.json");
  process.env.NULLBENCH_STUB_STATE = join(dir, "state.json");
}
export function clearStub() {
  for (const k of ["NULLBENCH_CLAUDE_BIN", "NULLBENCH_STUB_PLAN", "NULLBENCH_STUB_STATE"]) delete process.env[k];
}

// Collects everything main() writes to stdout.
export function capture() {
  let buf = "";
  return { stdout: { write: (s) => { buf += s; return true; } }, text: () => buf };
}

export const ledger = (dir) => readFileSync(join(dir, "LEDGER.md"), "utf8");

// TWO signal tasks, deliberately. With one, "the average is suppressed" is true under
// every implementation (a mean needs two discriminating tasks), and "non-discriminating"
// is satisfied by the harm row -- so both assertions pass with ceiling detection ripped
// out. Two signal tasks is what makes these tests falsifiable.
export const SIGNAL = { id: "sig", kind: "signal", prompt: "is three caught enough", verify: { type: "any", patterns: ["denominator"] } };
export const SIGNAL2 = { id: "sig2", kind: "signal", prompt: "is the coverage gate sound", verify: { type: "any", patterns: ["gaming"] } };
export const HARM = { id: "harm", kind: "harm", prompt: "btree versus gin", verify: { type: "none", patterns: ["goodhart"], maxWords: 500 } };
```

- [ ] **Step 2: Write `test/e2e/protocol.test.mjs`** — the six promises

```js
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli.mjs";
import { makeSuite, useStub, clearStub, capture, ledger, SIGNAL, SIGNAL2, HARM } from "./helpers.mjs";

afterEach(clearStub);

const ALL = [SIGNAL, SIGNAL2, HARM];

// Both signal tasks discriminate: treatment says the magic word, control does not.
const WORKING = {
  rules: [
    { promptIncludes: "three caught", arm: "treatment", outs: ["the denominator is missing"] },
    { promptIncludes: "three caught", arm: "control", outs: ["looks fine"] },
    { promptIncludes: "coverage gate", arm: "treatment", outs: ["that invites gaming"] },
    { promptIncludes: "coverage gate", arm: "control", outs: ["seems reasonable"] },
  ],
  default: { outs: ["a clean neutral answer"] },
};

// sig is at ceiling in both arms; sig2 still discriminates.
const ONE_AT_CEILING = {
  rules: [
    { promptIncludes: "three caught", arm: "any", outs: ["the denominator is missing"] },
    { promptIncludes: "coverage gate", arm: "treatment", outs: ["that invites gaming"] },
    { promptIncludes: "coverage gate", arm: "control", outs: ["seems reasonable"] },
  ],
  default: { outs: ["a clean neutral answer"] },
};

test("a clean run is CONFIRMATORY, prints the average, and lands in the ledger", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  const cap = capture();
  const code = await main([dir, "--yes"], cap);
  assert.equal(code, 0);
  assert.match(cap.text(), /CONFIRMATORY/);
  // Both signal tasks discriminate, so the average MUST print here. Without this the
  // suppression assertions elsewhere are unfalsifiable.
  assert.match(cap.text(), /Average across discriminating signal tasks/);
  assert.match(cap.text(), /no interval/);
  assert.match(ledger(dir), /CONFIRMATORY/);
});

test("TAMPER: editing a task after registration forces EXPLORATORY and no average", async () => {
  // Uses the WORKING plan, where the average would otherwise print -- so the
  // suppression assertion below actually discriminates.
  const dir = makeSuite({ tasks: ALL, corrupt: "sig" });
  useStub(dir, WORKING);
  const cap = capture();
  const code = await main([dir, "--yes"], cap);
  assert.equal(code, 0);
  assert.match(cap.text(), /EXPLORATORY/);
  assert.match(cap.text(), /average across signal tasks: suppressed/i);
  assert.ok(!/Average across discriminating/.test(cap.text()),
    "an exploratory run must not print an average it would have printed when clean");
});

test("FILTER: running a subset of registered tasks forces EXPLORATORY", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  const cap = capture();
  await main([dir, "--yes", "--task", "sig"], cap);
  assert.match(cap.text(), /EXPLORATORY/);
  assert.match(cap.text(), /task set differs/);
});

test("MISSING HARM: a suite with no negative control cannot be confirmed", async () => {
  const dir = makeSuite({ tasks: ALL, omitHarm: true });
  useStub(dir, WORKING);
  const cap = capture();
  await main([dir, "--yes"], cap);
  assert.match(cap.text(), /EXPLORATORY/);
  assert.match(cap.text(), /negative control/);
});

test("CEILING: the ceiling task's own row is flagged and the discriminating one is not", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, ONE_AT_CEILING);
  const cap = capture();
  await main([dir, "--yes"], cap);
  const lines = cap.text().split("\n");
  const sigRow = lines.find((l) => l.includes("`sig`"));
  const sig2Row = lines.find((l) => l.includes("`sig2`"));
  // Asserting on the ROWS, not on the presence of the word anywhere: the harm row is
  // also at 100/100 and would satisfy a document-wide match with detection removed.
  assert.match(sigRow, /non-discriminating/, "the ceiling signal task must be flagged");
  assert.ok(!/non-discriminating/.test(sig2Row), "the discriminating task must not be flagged");
  assert.match(cap.text(), /1 of 2 signal tasks discriminate/);
});

test("DEAD RUNS: a batch with too few graded runs is VOID, exits 1, and still logs", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, { default: { outs: [""], code: 1 } });
  const cap = capture();
  const code = await main([dir, "--yes"], cap);
  assert.equal(code, 1, "a void batch must exit non-zero");
  assert.match(cap.text(), /VOID/);
  assert.ok(!/[+-]\d+\.\d+pp/.test(cap.text()), "no deltas printed for a void batch");
  assert.match(ledger(dir), /VOID/, "the file drawer stays shut");
});

test("FILE DRAWER: a run that spends anything is logged; a dry run is not", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  await main([dir, "--dry-run"], capture());
  assert.equal(existsSync(join(dir, "LEDGER.md")), false, "a dry run spends nothing and logs nothing");
  await main([dir, "--yes"], capture());
  assert.ok(ledger(dir).includes("CONFIRMATORY"));
});

test("FILE DRAWER: a crash after the batch still leaves a ledger entry", async () => {
  // The expensive failure: the runs are paid for, then something downstream throws, and
  // the batch vanishes. `main` wraps the post-run block in try/finally for this reason.
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  rmSync(join(dir, "SKILL.md"));           // leakage scan will fail to read it
  await main([dir, "--yes"], capture()).catch(() => {});
  assert.equal(existsSync(join(dir, "LEDGER.md")), true,
    "a batch that was paid for must never disappear from the ledger");
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `node --test test/e2e/`
Expected: FAIL — `helpers.mjs` or assertions not yet satisfied.

- [ ] **Step 4: Make them pass**

No new source module. Fix whatever these surface in Tasks 1–12 — they are the first
time the modules run together, and wiring mistakes surface here rather than in unit
tests. Do not weaken an assertion to get green; each one encodes a published promise.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, all files, with no network access and no `ANTHROPIC_API_KEY` set.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/
git commit -m "test(e2e): the six protocol promises, offline and free"
```

---

### Task 14: The live bracket — placebo and known-positive

The most important test in the repository, and the one that will run least often. It needs real API calls, so it lives outside `npm test`.

**Files:**
- Create: `test/live/fixtures/placebo/` (skill + suite)
- Create: `test/live/fixtures/positive/` (skill + suite)
- Create: `test/live/bracket.test.mjs`

**Interfaces:**
- Consumes: `main` (Task 11), `aggregate`/`discriminates` via the written `records.json`.
- Produces: nothing importable. `npm run verify:live` is the entry point.

- [ ] **Step 1: Write the placebo fixture**

`test/live/fixtures/placebo/SKILL.md` — a genuinely well-written skill about something
irrelevant to the tasks, so a positive delta cannot be explained by the skill being bad:

```markdown
---
name: iso-date-formatting
description: Use when formatting or parsing dates for machine interchange.
---

# ISO 8601 date formatting

Always serialize timestamps as `YYYY-MM-DDTHH:mm:ssZ` in UTC. Never emit a naive
wall-clock string: `new Date(x).toISOString()` on a timezone-less string resolves
against the host timezone, so the same code passes under `TZ=UTC` and fails under
`America/Denver`.

Prefer a single formatting helper over ad-hoc `toLocaleString` calls at each site.
```

The suite reuses the same reasoning tasks as the positive fixture, so the only variable
is which skill is injected.

- [ ] **Step 2: Write the known-positive fixture**

`test/live/fixtures/positive/SKILL.md`:

```markdown
---
name: three-bullets
description: Use when answering any question, to control response shape.
---

# Answer in exactly three bullets

Every answer is exactly three bullet points, each starting with "- ". No preamble,
no closing paragraph, no headings. Three bullets, nothing else.
```

Task verifier is deterministic — `{"type": "any", "patterns": ["- "]}` plus a
`maxWords` bound is too loose; instead use a dedicated task whose verify is
`{"type": "any", "patterns": ["- "]}` **and** assert the shape in the test by reading
`records.json`. Simplest correct approach: give the task `{"type": "none", "patterns":
["\n\n\n"], "maxWords": 120}` and rely on the delta rather than the absolute rate.

- [ ] **Step 3: Write `test/live/bracket.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli.mjs";
import { aggregate } from "../../src/report.mjs";
import { discriminates } from "../../src/stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const capture = () => { let b = ""; return { stdout: { write: (s) => (b += s, true) }, text: () => b }; };

function latestRecords(dir) {
  const results = join(dir, "results");
  const newest = readdirSync(results).sort().at(-1);
  return JSON.parse(readFileSync(join(results, newest, "records.json"), "utf8"));
}

test("PLACEBO: an irrelevant skill must produce a null", { timeout: 1_800_000 }, async () => {
  const dir = join(HERE, "fixtures", "placebo");
  await main([dir, "--yes"], capture());
  const { records } = latestRecords(dir);
  const rows = aggregate(records, [{ id: "reasoning", kind: "signal", predict: "no-effect" }]);
  for (const r of rows) {
    assert.equal(discriminates(r.ci), false,
      `a placebo skill produced a discriminating delta (${JSON.stringify(r.ci)}). ` +
      `The harness manufactures effects and nothing else it reports can be trusted.`);
  }
});

test("KNOWN POSITIVE: a trivially detectable effect must be detected", { timeout: 1_800_000 }, async () => {
  const dir = join(HERE, "fixtures", "positive");
  await main([dir, "--yes"], capture());
  const { records } = latestRecords(dir);
  const rows = aggregate(records, [{ id: "shape", kind: "signal", predict: "helps" }]);
  const row = rows[0];
  assert.equal(discriminates(row.ci), true,
    `a known-positive skill was not detected (${JSON.stringify(row.ci)}). ` +
    `A harness that reports null for everything passes the placebo test perfectly.`);
  assert.ok(row.delta > 0);
});
```

- [ ] **Step 4: Run the live bracket**

Run: `npm run verify:live`
Expected: both PASS. This costs real money and takes tens of minutes. Record the date,
the model, and the two intervals — Task 16 pins them in `PROTOCOL.md`.

- [ ] **Step 5: Commit**

```bash
git add test/live/
git commit -m "test(live): placebo and known-positive bracket around the runner"
```

---

### Task 15: `examples/cobra` — the worked example

This is success criterion 1: the protocol's first act is to decline to print its own author's published average.

**Files:**
- Create: `examples/cobra/nullbench.json`
- Create: `examples/cobra/tasks/*.json` (copied from `cobra-skill/eval/tasks/`)
- Create: `examples/cobra/canaries.json` (converted from `cobra-skill/eval/judge-canaries.json`)
- Create: `examples/cobra/SKILL.md` (copied from `cobra-skill/skills/cobra/SKILL.md`)
- Create: `examples/cobra/README.md`

- [ ] **Step 1: Copy the suite**

```bash
mkdir -p examples/cobra/tasks
cp ~/code/cobra-skill/eval/tasks/*.json examples/cobra/tasks/
cp ~/code/cobra-skill/skills/cobra/SKILL.md examples/cobra/SKILL.md
cp ~/code/cobra-skill/eval/judge-canaries.json examples/cobra/canaries.json
cp -R ~/code/cobra-skill/eval/fixtures examples/cobra/fixtures
```

The `fixtures` copy is not optional: `ic-agent-under-pressure.json` declares
`"fixture": "failing-suite"`, and `makeCwd` resolves it against the suite directory.
Without it that task throws inside a worker and kills the run — which is the task the
success criterion depends on.

`canaries.json` needs no reshaping: `loadCanaries` (Task 6) reads cobra's existing
`{ "<task-id>": [{ label, expect, reply }] }` shape directly and resolves the prompt and
rubric from the registered task. Verify with `node -e` that every top-level key in the
file matches a task id in `tasks/`, since `loadCanaries` aborts the run otherwise.

- [ ] **Step 2: Generate `nullbench.json` with correct hashes**

```bash
node -e '
const {readdirSync,readFileSync,writeFileSync}=require("node:fs");
const {createHash}=require("node:crypto");
const dir="examples/cobra/tasks";
const tasks=readdirSync(dir).filter(f=>f.endsWith(".json")).map(f=>{
  const body=readFileSync(`${dir}/${f}`);
  const spec=JSON.parse(body);
  return {id:spec.id,file:`tasks/${f}`,sha256:createHash("sha256").update(body).digest("hex"),
          kind:spec.kind,predict:spec.kind==="harm"?"no-effect":"helps"};
}).sort((a,b)=>a.id<b.id?-1:1);
writeFileSync("examples/cobra/nullbench.json",
  JSON.stringify({model:"sonnet",judge_model:"sonnet",reps:10,tasks},null,2)+"\n");
console.log(tasks.map(t=>`${t.id} ${t.kind} ${t.predict}`).join("\n"));
'
```

Note this uses `require` inside `node -e`, which is fine for a one-off CommonJS
evaluation and does not violate the ESM constraint on shipped source.

- [ ] **Step 3: Verify the registration loads clean**

```bash
node bin/nullbench.mjs examples/cobra --dry-run
```

Expected: the preflight prints 5 registered tasks, no drift, and a total run count.
If it reports drift, the hashes are wrong — regenerate rather than editing by hand.

- [ ] **Step 4: Run it for real**

```bash
node bin/nullbench.mjs examples/cobra --yes
```

Expected, and this is the criterion:
- Class **CONFIRMATORY**.
- `ic-smoke-denominator` discriminating, roughly `+80.0pp [+37.0pp, +91.6pp]`.
- `ic-clock-exclusion` and `ic-agent-under-pressure` flagged **non-discriminating**.
- **`Average across signal tasks: suppressed`** — because only one signal task
  discriminates. The published `+26.7pp` does not appear.
- `examples/cobra/LEDGER.md` created with the entry.

If the average prints, Task 8 is wrong — fix it rather than the example.

- [ ] **Step 5: Write `examples/cobra/README.md`**

Explain, in prose: what the suite is, which published figure it withdraws and why,
that the two ceiling tasks have no headroom rather than no effect, and that
`cobra-skill`'s own README has not yet been amended (spec §10, deferred 2026-09-14).

- [ ] **Step 6: Commit**

```bash
git add examples/cobra
git commit -m "example(cobra): the worked example, which suppresses its own published average"
```

---

### Task 16: The published documents

`FAILURES.md` is the half of this project that reaches people who never install the tool. It is written last because by now every entry has a mechanism to point at, and every number has been reproduced.

**Files:**
- Create: `FAILURES.md`, `PROTOCOL.md`, `README.md`, `ATTRIBUTION.md`, `LICENSE`

- [ ] **Step 0: Amend the spec where the implementation diverged**

The plan's header says the spec is authoritative and disagreements get a commit that
says so. Two are outstanding; resolve both in `docs/superpowers/specs/2026-09-14-nullbench-design.md`
before writing `PROTOCOL.md`, or `PROTOCOL.md` will document code that does not exist.

1. **Hash construction (§5.2).** The spec says
   `H = sha256(canonical(nullbench.json) || sha256(task_1) || ...)`. Task 3 instead
   hashes a canonical projection — `{model, judge_model, reps, tasks:[{id, kind,
   predict, sha256: actual}]}` — which excludes `file` paths and the *declared* hashes.
   The implementation is the better design: it names what actually ran, so a registration
   reformatted or with a path moved still hashes identically, while a changed task does
   not. Amend §5.2 to the implemented formula and say why.
2. **VOID output (§5.3 vs §5.5).** §5.5 says a thin cell "reports `n/a`"; §5.3 says a
   VOID run reports no per-task figures at all. These contradict. The implementation
   follows §5.3 — `renderReport` returns before the tables. Amend §5.5 to match, and
   state that the graded-run counts appear in the ledger entry and in the reasons list,
   which is where a reader looks to find out what died.

```bash
git add docs/superpowers/specs/2026-09-14-nullbench-design.md
git commit -m "spec: hash the projection rather than the file, and drop n/a from VOID output"
```

- [ ] **Step 1: Write `FAILURES.md`**

Thirteen entries in four classes, verbatim in structure from spec §6. Each entry:

```markdown
### N. <Name of the lie>

**What it looks like from the inside.** <Prose — why a careful person does this.>

**What it cost.** <The real numbers from the cobra runs.>

**What nullbench does.** <caught | mitigated | open> — <the mechanism, or the reason
there isn't one.>
```

Copy the numbers from spec §6 — with one correction. **Entry 2 is wrong in both the
spec and in `cobra-skill/eval/RESULTS.md`.** RESULTS.md line 25 gives the re-graded
`ic-smoke-denominator` as 10% → 90%, a delta of **+80.0pp**; its prose at line 55 says
"+90.0pp against +50.0pp". 10 → 90 is +80.0pp, so the prose figure is the error and it
propagated into the spec. Write `+80.0pp` in `FAILURES.md`, and note in the entry that
the substring verifier *understated* the effect by 30pp rather than 40pp.

This is a defect in a published document, and correcting `cobra-skill/eval/RESULTS.md`
is a separate task in a separate repository — raise it, do not silently fix it from here.

Entries 3, 9 and 12's open/mitigated status must not be upgraded — three of thirteen
marked open is the credibility of the document.

- [ ] **Step 2: Write `PROTOCOL.md`**

The normative spec: registration file schema, canonicalization rules (RFC 8785 subset,
as implemented in Task 2), hash construction, the three report classes and their exact
conditions, ledger format, the graded-run floor, and the interval methods with
citations (Wilson 1927; Newcombe 1998, method 10).

Include a **Placebo status** block, filled in from the Task 14 run:

```markdown
## Placebo status

Last verified: <date> · nullbench <version> · model <model>
Placebo interval: <[lo, hi]> — spans zero, as required.
Known-positive interval: <[lo, hi]> — excludes zero, as required.

This is the guarantee that the runner does not manufacture effects. It costs real API
spend and therefore runs rarely. If the date above is old, treat it as unverified.
```

- [ ] **Step 3: Write `README.md`**

Lead with the retraction, not the feature list: cobra published +40.0pp, re-measurement
under a blind judge put it at +26.7pp, and nullbench's own worked example declines to
print even that. Then: what the protocol is, the three classes, install and usage, a
pointer to `FAILURES.md`, and an explicit statement of what nullbench does *not* do —
it does not help you write a discriminating task, which is the hard part.

- [ ] **Step 4: Write `ATTRIBUTION.md`**

SkillsBench (arXiv 2602.12670) for the paired design; OSF/AsPredicted for
pre-registration and the file-drawer framing; `cobra-skill/eval` for the judge prompt,
the negation-aware ordering verifier and every number in `FAILURES.md`; Wilson (1927)
and Newcombe (1998) for the intervals. Follow the convention already set in
`cobra-skill/ATTRIBUTION.md`.

- [ ] **Step 5: Add `LICENSE`** — MIT, matching `package.json`.

- [ ] **Step 6: Add the pointer from `cobra-skill` (spec §7)**

In `~/code/cobra-skill`, on a feature branch, add a short note to `eval/README.md`
saying that the suite has been ported to nullbench as its worked example, with a link.
This is the *pointer* only. Amending cobra's `+26.7pp` headline is the separate deferred
item from spec §10 and is explicitly **not** part of this step. Two things also belong
in that branch's description, both found while building this plan:

- `eval/RESULTS.md` line 55 says `+90.0pp` where the table at line 25 gives `+80.0pp`.
- `eval/run.mjs` has the same sentence-boundary bug in `firstUnnegated` that Task 4
  fixes here: a negation cue in the preceding sentence suppresses the following clause.

Open it as a pull request against `cobra-skill`; do not commit to its `main`.

- [ ] **Step 7: Final check**

```bash
npm test && node bin/nullbench.mjs examples/cobra --dry-run
```

Expected: all tests pass; the dry run reports no drift.

- [ ] **Step 8: Commit**

```bash
git add README.md FAILURES.md PROTOCOL.md ATTRIBUTION.md LICENSE
git commit -m "docs: the failure catalog, the protocol, and the retraction that opens the README"
```

---

## Done when

1. `npm test` passes with no network and no API key.
2. `npm run verify:live` passes, and its intervals are pinned in `PROTOCOL.md`.
3. `node bin/nullbench.mjs examples/cobra --yes` returns CONFIRMATORY and **suppresses**
   the average, with `ic-smoke-denominator` at roughly `+80.0pp [+37.0pp, +91.6pp]`.
4. `FAILURES.md` reads as a standalone document, with three entries still marked open.
5. No per-task delta appears anywhere in any output without its interval, and the
   average appears only with its explicit `no interval` marker.
6. The e2e suite is stable across ten consecutive runs. The stub's state file is written
   atomically; before that fix the suite flaked at roughly 30%, and each flake surfaced
   as a spurious VOID — the harness misreporting its own dead runs.
7. `npm test` never executes anything under `test/live/` and never loads
   `tools/stub-claude.mjs` as a test.
