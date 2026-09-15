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
