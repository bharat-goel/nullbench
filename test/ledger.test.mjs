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
