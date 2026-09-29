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

test("aggregate with zero-n arms does not throw and marks as non-discriminating", () => {
  const rows = aggregate([], [{ id: "empty", kind: "signal", predict: "helps" }]);
  const empty = rows.find((r) => r.id === "empty");
  assert.equal(empty.control.n, 0);
  assert.equal(empty.treatment.n, 0);
  assert.equal(empty.discriminating, false, "zero-n arms must not discriminate");
});

test("harm tasks are excluded from the average even when discriminating", () => {
  const taskDefs = [
    { id: "sig1", kind: "signal", predict: "helps" },
    { id: "sig2", kind: "signal", predict: "helps" },
    { id: "harm_disc", kind: "harm", predict: "no-effect" },
  ];
  const recs = [];
  // sig1: 2/10 -> 9/10 (discriminates, delta = 0.7)
  for (let i = 0; i < 2; i++) recs.push({ task: "sig1", cond: "control", pass: true, failed: false });
  for (let i = 0; i < 8; i++) recs.push({ task: "sig1", cond: "control", pass: false, failed: false });
  for (let i = 0; i < 9; i++) recs.push({ task: "sig1", cond: "treatment", pass: true, failed: false });
  recs.push({ task: "sig1", cond: "treatment", pass: false, failed: false });
  // sig2: 1/10 -> 8/10 (discriminates, delta = 0.7)
  recs.push({ task: "sig2", cond: "control", pass: true, failed: false });
  for (let i = 0; i < 9; i++) recs.push({ task: "sig2", cond: "control", pass: false, failed: false });
  for (let i = 0; i < 8; i++) recs.push({ task: "sig2", cond: "treatment", pass: true, failed: false });
  for (let i = 0; i < 2; i++) recs.push({ task: "sig2", cond: "treatment", pass: false, failed: false });
  // harm_disc: 0/10 -> 10/10 (discriminates, delta = 1.0, but is harm so should NOT be averaged)
  for (let i = 0; i < 10; i++) recs.push({ task: "harm_disc", cond: "control", pass: false, failed: false });
  for (let i = 0; i < 10; i++) recs.push({ task: "harm_disc", cond: "treatment", pass: true, failed: false });

  const rows = aggregate(recs, taskDefs);
  const avg = averageDelta(rows);

  assert.equal(avg.suppressed, false, "with 2 discriminating signal tasks, average should print");
  // Average should be (0.7 + 0.7) / 2 = 0.7, not (0.7 + 0.7 + 1.0) / 3 = 0.8333...
  assert.ok(Math.abs(avg.value - 0.7) < 1e-9, "average should exclude harm task");
});

const canaryWithMisgrade = {
  ok: false, total: 3, graded: 3, dead: [],
  misgrades: [{ id: "sig:plain-words", expected: "FAIL", got: "PASS", why: "The reply\n paraphrases well." }],
};

test("an exploratory report names each misgraded canary, not just the count", () => {
  const md = renderReport({
    rows: aggregate(records(), tasks), klass: "EXPLORATORY",
    reasons: ["judge canaries misgraded; judged tasks cannot be confirmed"],
    requested: { reps: 10, model: "sonnet", judgeModel: "sonnet" }, hash: "c".repeat(64),
    canary: canaryWithMisgrade,
  });
  assert.match(md, /Judge canaries: 2\/3 graded correctly\./);
  assert.match(md, /misgraded `sig:plain-words`: expected FAIL, judge said PASS — judge: The reply paraphrases well\./);
});

test("a VOID report still names the misgraded canaries it paid for", () => {
  const md = renderReport({
    rows: [], klass: "VOID", reasons: ['task "sig" control: 0 graded runs, 8 required'],
    requested: { reps: 10, model: "sonnet", judgeModel: "sonnet" }, hash: "d".repeat(64),
    canary: { ...canaryWithMisgrade, dead: [{ id: "sig:other", why: "session limit" }] },
  });
  assert.match(md, /## Judge canaries/);
  assert.match(md, /misgraded `sig:plain-words`/);
  assert.match(md, /never answered `sig:other`/);
  assert.doesNotMatch(md, /\| Task \|/, "a VOID report still prints no per-task table");
});

test("the header names a NULLBENCH_CLAUDE_BIN backend when one answered", () => {
  const req = { reps: 10, model: "sonnet", judgeModel: "sonnet" };
  const plain = renderReport({ rows: aggregate(records(), tasks), klass: "CONFIRMATORY", reasons: [], requested: req, hash: "e".repeat(64), canary: null });
  assert.doesNotMatch(plain, /backend/);
  const local = renderReport({ rows: aggregate(records(), tasks), klass: "CONFIRMATORY", reasons: [], requested: { ...req, backend: "/x/local-claude.mjs" }, hash: "e".repeat(64), canary: null });
  assert.match(local, /backend `\/x\/local-claude\.mjs` \(NULLBENCH_CLAUDE_BIN override/);
});

test("a judge reason already prefixed 'judge:' is not printed twice; dead canaries are not counted correct", () => {
  const md = renderReport({
    rows: aggregate(records(), tasks), klass: "EXPLORATORY", reasons: ["x"],
    requested: { reps: 10, model: "sonnet", judgeModel: "sonnet" }, hash: "f".repeat(64),
    canary: { ok: false, total: 4, graded: 3, dead: [{ id: "sig:gone", why: "judge failed to run" }],
      misgrades: [{ id: "sig:a", expected: "FAIL", got: "PASS", why: "judge: fine" }] },
  });
  assert.match(md, /— judge: fine/);
  assert.doesNotMatch(md, /judge: judge:/);
  assert.match(md, /Judge canaries: 2\/3 graded correctly; 1 of 4 never answered\./);
});
