// --resume, end to end, against the stub. PROTOCOL.md §10.
//
// The motivating failure: a plan's session limit lands partway through a batch, every
// remaining call dies fast, and the batch comes back VOID. Before --resume the only
// remedy was to re-run all of it. These tests pin both halves of the feature: that a
// resume finishes the batch paying only for the dead cells, and that it refuses every
// way of using "resume" to re-draw a number that has already been observed.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli.mjs";
import { makeSuite, useStub, clearStub, capture, ledger, SIGNAL, SIGNAL2, HARM, JUDGE } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../../bin/nullbench.mjs", import.meta.url));

afterEach(() => {
  clearStub();
  delete process.env.NULLBENCH_STUB_LIMIT_AFTER;
});

const ALL = [SIGNAL, SIGNAL2, HARM];

// Control answers are graded FAILs, not dead runs -- the resume must carry them.
const WORKING = {
  rules: [
    { promptIncludes: "three caught", arm: "treatment", outs: ["the denominator is missing"] },
    { promptIncludes: "three caught", arm: "control", outs: ["looks fine"] },
    { promptIncludes: "coverage gate", arm: "treatment", outs: ["that invites gaming"] },
    { promptIncludes: "coverage gate", arm: "control", outs: ["seems reasonable"] },
  ],
  default: { outs: ["a clean neutral answer"] },
};

// 3 tasks x 2 arms x 4 reps. Concurrency 1 throughout, so "which cells died" is fixed.
const CELLS = 24;
const calls = (dir) => {
  const p = join(dir, "state.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).__calls__ ?? 0 : 0;
};
const runs = (dir) => existsSync(join(dir, "results")) ? readdirSync(join(dir, "results")).sort() : [];
const records = (dir, run) => JSON.parse(readFileSync(join(dir, "results", run, "records.json"), "utf8"));
const key = (r) => `${r.task}/${r.cond}/${r.rep}`;

// Runs a batch whose session limit hits after `after` calls. Returns the dead run's
// records.json.
async function interrupted(dir, after, extra = []) {
  process.env.NULLBENCH_STUB_LIMIT_AFTER = String(after);
  const cap = capture();
  const code = await main([dir, "--yes", "--concurrency", "1", ...extra], cap);
  delete process.env.NULLBENCH_STUB_LIMIT_AFTER;
  assert.equal(code, 1, "the interrupted batch must itself be VOID");
  const [run] = runs(dir);
  return records(dir, run);
}

test("SESSION LIMIT: a batch voided partway through is completed by --resume, paying only for the dead runs", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);

  const first = await interrupted(dir, 15);
  assert.equal(first.klass, "VOID");
  assert.equal(first.complete, true);
  assert.equal(first.records.filter((r) => !r.failed).length, 15);
  assert.equal(first.records.filter((r) => r.failed).length, CELLS - 15);
  assert.ok(first.records.filter((r) => r.failed).every((r) => /session limit/.test(r.why)),
    "the dead runs are the session-limit ones");
  const ledgerBefore = ledger(dir);

  const before = calls(dir);
  const cap = capture();
  const code = await main([dir, "--yes", "--concurrency", "1", "--resume", first.stamp], cap);
  assert.equal(code, 0);
  assert.equal(calls(dir) - before, CELLS - 15, "exactly the dead cells are re-attempted -- nothing else is paid for twice");
  assert.match(cap.text(), /CONFIRMATORY/, "a resume under the same H and config can still be confirmed");
  assert.match(cap.text(), /Average across discriminating signal tasks/);

  const [, second] = runs(dir);
  const combined = records(dir, second);
  assert.equal(combined.resumes, first.stamp);
  assert.deepEqual(combined.chain, [first.stamp, combined.stamp]);
  assert.equal(combined.records.length, CELLS, "one record per cell, no duplicates");
  assert.equal(new Set(combined.records.map(key)).size, CELLS);
  assert.equal(combined.records.filter((r) => r.stamp === first.stamp).length, 15);
  assert.equal(combined.records.filter((r) => r.stamp === combined.stamp).length, CELLS - 15);
  assert.equal(combined.reattempted.length, CELLS - 15, "superseded dead runs are listed, not silently dropped");

  // The report names every contributing stamp.
  const report = readFileSync(join(dir, "results", second, "report.md"), "utf8");
  assert.match(report, /## Resumed batch/);
  assert.ok(report.includes(`\`${first.stamp}\` — 15 graded run(s)`));
  assert.ok(report.includes(`\`${combined.stamp}\` — ${CELLS - 15} graded run(s) (this run)`));

  // The ledger keeps the VOID entry untouched and adds the resume as its own entry.
  const after = ledger(dir);
  assert.ok(after.startsWith(ledgerBefore), "the earlier entry is never rewritten");
  const entry = after.slice(ledgerBefore.length);
  assert.match(entry, new RegExp(`## ${combined.stamp} · CONFIRMATORY · H=\\w+ · resumes ${first.stamp}`));
  assert.match(entry, new RegExp(`resume: of=${first.stamp} origin=${first.stamp} reattempted=${CELLS - 15}`));
  assert.ok(entry.includes(`contributing: ${first.stamp} (15 graded), ${combined.stamp} (${CELLS - 15} graded)`));
});

test("GRADED RUNS: a resume never re-attempts a graded run, pass or fail", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  const first = await interrupted(dir, 10);
  const graded = first.records.filter((r) => !r.failed);
  assert.ok(graded.some((r) => r.pass) && graded.some((r) => !r.pass),
    "the fixture must carry graded passes AND graded fails, or this test proves half of what it claims");

  await main([dir, "--yes", "--concurrency", "1", "--resume", first.stamp], capture());
  const combined = records(dir, runs(dir)[1]);
  for (const g of graded) {
    const now = combined.records.find((r) => key(r) === key(g));
    assert.deepEqual(now, { ...g, stamp: first.stamp }, `graded cell ${key(g)} must be carried unchanged`);
  }
  const fresh = combined.records.filter((r) => r.stamp === combined.stamp).map(key).sort();
  const dead = first.records.filter((r) => r.failed).map(key).sort();
  assert.deepEqual(fresh, dead, "the new run touched exactly the dead cells");
});

test("GRADED RUNS: a batch with no dead runs cannot be resumed at all", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  await main([dir, "--yes", "--concurrency", "1"], capture());
  const [run] = runs(dir);
  const before = calls(dir);
  const cap = capture();
  const code = await main([dir, "--yes", "--resume", records(dir, run).stamp], cap);
  assert.equal(code, 2);
  assert.match(cap.text(), /no dead runs to re-attempt/);
  assert.equal(calls(dir), before, "nothing spent");
  assert.equal(runs(dir).length, 1, "no results directory created");
});

test("REFUSED: a resume after a task file changed exits 2, spends nothing and logs nothing", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  const first = await interrupted(dir, 15);
  const ledgerBefore = ledger(dir);

  // Edit the task AND update its declared hash, so there is no HASH_MISMATCH drift to
  // hide behind -- only H itself says the experiment changed.
  const body = JSON.stringify({ ...SIGNAL, prompt: "is three caught enough, really" });
  writeFileSync(join(dir, "tasks", "sig.json"), body);
  const reg = JSON.parse(readFileSync(join(dir, "nullbench.json"), "utf8"));
  const { createHash } = await import("node:crypto");
  reg.tasks.find((t) => t.id === "sig").sha256 = createHash("sha256").update(body).digest("hex");
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify(reg));

  const before = calls(dir);
  const cap = capture();
  const code = await main([dir, "--yes", "--resume", first.stamp], cap);
  assert.equal(code, 2, "a refused resume is structural, never VOID");
  assert.match(cap.text(), /resume refused/);
  assert.match(cap.text(), /registration hash differs/);
  assert.match(cap.text(), /task "sig" \(tasks\/sig\.json\) changed/, "the changed file is named");
  assert.equal(calls(dir), before, "nothing spent");
  assert.equal(runs(dir).length, 1);
  assert.equal(ledger(dir), ledgerBefore);
});

test("REFUSED: a changed SKILL.md, or a different reps/model/judge model, cannot be resumed", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  const first = await interrupted(dir, 15);

  for (const [flags, why] of [
    [["--reps", "5"], /reps differ: .* ran 4, this run would use 5/],
    [["--model", "opus"], /model differs/],
    [["--judge-model", "opus"], /judge model differs/],
    [["--task", "sig"], /task set differs/],
  ]) {
    const cap = capture();
    assert.equal(await main([dir, "--yes", "--resume", first.stamp, ...flags], cap), 2, flags.join(" "));
    assert.match(cap.text(), why);
  }

  writeFileSync(join(dir, "SKILL.md"), "# demo skill\nA different independent variable.");
  const cap = capture();
  assert.equal(await main([dir, "--yes", "--resume", first.stamp], cap), 2);
  assert.match(cap.text(), /SKILL\.md changed/);
  assert.equal(runs(dir).length, 1);
});

test("REFUSED: the same run cannot be resumed twice; the resume is resumed instead", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  const first = await interrupted(dir, 10);

  // The first resume hits the limit again, and stays VOID over the combined records.
  process.env.NULLBENCH_STUB_LIMIT_AFTER = String(calls(dir) + 5);
  assert.equal(await main([dir, "--yes", "--concurrency", "1", "--resume", first.stamp], capture()), 1,
    "the floor applies to the combined records");
  delete process.env.NULLBENCH_STUB_LIMIT_AFTER;
  const second = records(dir, runs(dir)[1]);
  assert.equal(second.klass, "VOID");
  assert.equal(second.records.filter((r) => !r.failed).length, 15);

  const cap = capture();
  assert.equal(await main([dir, "--yes", "--resume", first.stamp], cap), 2);
  assert.match(cap.text(), new RegExp(`already been resumed by ${second.stamp}`));

  const before = calls(dir);
  assert.equal(await main([dir, "--yes", "--concurrency", "1", "--resume", second.stamp], capture()), 0);
  assert.equal(calls(dir) - before, CELLS - 15);
  const third = records(dir, runs(dir)[2]);
  assert.deepEqual(third.chain, [first.stamp, second.stamp, third.stamp]);
  assert.match(ledger(dir), new RegExp(`origin=${first.stamp}`));
});

test("CHECKPOINT: a process killed mid-batch leaves its graded runs on disk, and --resume finishes them", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  const killed = spawnSync(process.execPath, [BIN, dir, "--yes", "--concurrency", "1"], {
    env: { ...process.env, NULLBENCH_STUB_KILL_PARENT_AFTER: "10" }, encoding: "utf8",
  });
  assert.equal(killed.signal, "SIGKILL", "the stub must have killed nullbench outright");
  assert.equal(existsSync(join(dir, "LEDGER.md")), false, "no finally ran, so no ledger entry exists");

  const [run] = runs(dir);
  const checkpoint = records(dir, run);
  assert.equal(checkpoint.complete, false);
  assert.equal(checkpoint.records.length, 10, "every run graded before the kill is on disk");

  const before = calls(dir);
  const cap = capture();
  assert.equal(await main([dir, "--yes", "--concurrency", "1", "--resume", checkpoint.stamp], cap), 0);
  assert.equal(calls(dir) - before, CELLS - 10);
  assert.match(cap.text(), /never completed/);
  assert.match(ledger(dir), new RegExp(`note: ${checkpoint.stamp} never completed and has no ledger entry of its own`));
});

// Canaries: re-run in full on every resume, and an earlier misgrade is never forgiven.
// canaries.json is not part of H, so without that rule a resume would let an author fix
// a failing canary file and wash the earlier misgrade out of the combined batch.
test("CANARIES: re-run in full on resume, and an earlier misgrade still blocks CONFIRMATORY", async () => {
  const dir = makeSuite({ tasks: [JUDGE, HARM] });
  useStub(dir, {
    rules: [{ promptIncludes: "RUBRIC TEXT", arm: "any", outs: ["VERDICT: PASS\nREASON: fine"] }],
    default: { outs: ["a plain reply"] },
  });
  const canaries = (expect) => writeFileSync(join(dir, "canaries.json"), JSON.stringify({
    jsig: [{ label: "a", expect: "PASS", reply: "x" }, { label: "b", expect, reply: "y" }],
  }));
  canaries("FAIL"); // the stub judge says PASS: one misgrade
  // 2 canaries, then subject + judge calls; die partway through the batch.
  const first = await interrupted(dir, 12);
  assert.equal(first.canary.misgrades.length, 1);

  canaries("PASS"); // "fixed" between runs
  const judgeBefore = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))["RUBRIC TEXT:any"];
  const cap = capture();
  assert.equal(await main([dir, "--yes", "--concurrency", "1", "--resume", first.stamp], cap), 0);
  const judgeAfter = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))["RUBRIC TEXT:any"];
  const combined = records(dir, runs(dir)[1]);
  const deadJudged = combined.records.filter((r) => r.stamp === combined.stamp && r.task === "jsig").length;
  assert.equal(judgeAfter - judgeBefore, 2 + deadJudged, "both canaries re-run, plus one judge call per re-attempted judged cell");

  assert.match(cap.text(), /EXPLORATORY/, "the earlier misgrade carries forward");
  assert.match(cap.text(), /misgraded in an earlier run of this batch/);
  assert.match(cap.text(), /Canaries were re-run in full on this resume \(2\/2 correct\)/);
});
