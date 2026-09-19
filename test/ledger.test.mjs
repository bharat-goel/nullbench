import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("prediction scoring matrix: all 9 combinations", () => {
  // Comprehensive coverage: helps/harms/no-effect × above/below/spanning
  const matrix = [
    // helps predictions
    { predict: "helps", ci: { lo: 0.01, hi: 0.5 }, expected: "HIT", label: "helps + above" },
    { predict: "helps", ci: { lo: -0.5, hi: -0.01 }, expected: "MISS", label: "helps + below" },
    { predict: "helps", ci: { lo: -0.2, hi: 0.2 }, expected: "MISS", label: "helps + spanning" },
    // harms predictions
    { predict: "harms", ci: { lo: 0.01, hi: 0.5 }, expected: "MISS", label: "harms + above" },
    { predict: "harms", ci: { lo: -0.5, hi: -0.01 }, expected: "HIT", label: "harms + below" },
    { predict: "harms", ci: { lo: -0.2, hi: 0.2 }, expected: "MISS", label: "harms + spanning" },
    // no-effect predictions
    { predict: "no-effect", ci: { lo: 0.01, hi: 0.5 }, expected: "MISS", label: "no-effect + above" },
    { predict: "no-effect", ci: { lo: -0.5, hi: -0.01 }, expected: "MISS", label: "no-effect + below" },
    { predict: "no-effect", ci: { lo: -0.2, hi: 0.2 }, expected: "HIT", label: "no-effect + spanning" },
  ];

  for (const tc of matrix) {
    const dir = mkdtempSync(join(tmpdir(), "nb-led-"));
    const p = join(dir, "LEDGER.md");
    const testRow = {
      id: "test", kind: "signal", predict: tc.predict,
      control: { k: 5, n: 10, rate: 0.5, ci: { lo: 0.3, hi: 0.7 } },
      treatment: { k: 5, n: 10, rate: 0.5, ci: { lo: 0.3, hi: 0.7 } },
      delta: 0, ci: tc.ci, discriminating: true,
    };
    appendEntry(p, { ...base, rows: [testRow] });
    const text = readFileSync(p, "utf8");
    assert.match(text, new RegExp(`test\\b.*${tc.expected}`), `Failed: ${tc.label}`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every row with a delta carries an interval", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-led-"));
  const p = join(dir, "LEDGER.md");
  appendEntry(p, { ...base, rows: rows() });
  const text = readFileSync(p, "utf8");
  const deltaPattern = /[+-]\d+\.\d+pp/;
  let deltaCount = 0;
  for (const line of text.split("\n")) {
    if (!deltaPattern.test(line)) continue;
    deltaCount++;
    assert.ok(/\[[+-]\d+\.\d+pp, [+-]\d+\.\d+pp\]/.test(line),
      `Line with delta missing bracketed interval: ${line}`);
  }
  assert.ok(deltaCount > 0, "Should have found at least one delta line");
  rmSync(dir, { recursive: true, force: true });
});

test("ledger file always has a heading, even if created empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-led-"));
  const p = join(dir, "LEDGER.md");
  // Create empty file
  writeFileSync(p, "");
  appendEntry(p, { ...base, rows: rows() });
  const text = readFileSync(p, "utf8");
  assert.match(text, /# Run ledger/);
  rmSync(dir, { recursive: true, force: true });
});

// Also test: pre-existing headless file gets the heading
test("ledger adds heading to headless pre-existing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-led-"));
  const p = join(dir, "LEDGER.md");
  // Create file with stale content
  writeFileSync(p, "old stuff\n");
  appendEntry(p, { ...base, rows: rows() });
  const text = readFileSync(p, "utf8");
  assert.match(text, /# Run ledger/);
  assert.match(text, /old stuff/);
  rmSync(dir, { recursive: true, force: true });
});
