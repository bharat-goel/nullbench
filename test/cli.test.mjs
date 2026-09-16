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
