import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
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

test("runSuite rejects a shared sandbox that is not isolated", async () => {
  const dir = env({ default: { outs: ["a reply"] } });
  // fixtureRoot = the OS temp dir itself means the freshly mkdtemp'd shared sandbox is
  // a child of fixtureRoot, so assertIsolated reports it as "inside the repository".
  await assert.rejects(
    () => runSuite({ registration, requested, skillFile: join(dir, "SKILL.md"), fixtureRoot: tmpdir() }),
    /not isolated/,
  );
  clean(dir);
});

test("a task declaring a fixture that does not exist fails with a clear error", async () => {
  const dir = env({ default: { outs: ["a reply"] } });
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nb-fxroot-"));
  const withFixture = {
    ...registration,
    tasks: [{
      id: "fx", kind: "signal", predict: "helps",
      spec: { id: "fx", prompt: "fixture task", fixture: "missing-fixture", verify: { type: "any", patterns: ["x"] } },
    }],
  };
  await assert.rejects(
    () => runSuite({ registration: withFixture, requested: { ...requested, taskIds: ["fx"] }, skillFile: join(dir, "SKILL.md"), fixtureRoot }),
    (err) => {
      assert.match(err.message, /"fx"/);
      assert.match(err.message, /missing-fixture/);
      assert.doesNotMatch(err.message, /ENOENT/);
      return true;
    },
  );
  clean(dir);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test("a task declaring a fixture that exists runs normally, and the copy actually lands", async () => {
  const dir = env({ default: { outs: ["a reply"] } });
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nb-fxroot-"));
  mkdirSync(join(fixtureRoot, "ok-fixture"));
  writeFileSync(join(fixtureRoot, "ok-fixture", "README.md"), "a fixture project");
  // A distinctively named file the stub can report back via NULLBENCH_STUB_ECHO_CWD --
  // the scripted "a reply" output is identical regardless of cwd, so without this the
  // test would pass even against an empty sandbox if the fixture copy silently broke.
  writeFileSync(join(fixtureRoot, "ok-fixture", "fixture-marker.txt"), "marker");
  const withFixture = {
    ...registration,
    tasks: [{
      id: "fx", kind: "signal", predict: "helps",
      spec: { id: "fx", prompt: "fixture task", fixture: "ok-fixture", verify: { type: "any", patterns: ["reply"] } },
    }],
  };
  const raw = join(dir, "raw");
  process.env.NULLBENCH_STUB_ECHO_CWD = "1";
  const { records } = await runSuite({
    registration: withFixture, requested: { ...requested, taskIds: ["fx"] },
    skillFile: join(dir, "SKILL.md"), fixtureRoot, rawDir: raw,
  });
  delete process.env.NULLBENCH_STUB_ECHO_CWD;
  assert.equal(records.length, 8);
  assert.ok(records.every((r) => r.pass));
  const reply = readFileSync(join(raw, "fx__control__1.txt"), "utf8");
  assert.match(reply, /fixture-marker\.txt/, "the run's actual cwd must contain the fixture's files, not an empty sandbox");
  clean(dir);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test("a fixture carrying CLAUDE.md is rejected as not isolated", async () => {
  const dir = env({ default: { outs: ["a reply"] } });
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nb-fxroot-"));
  mkdirSync(join(fixtureRoot, "dirty-fixture"));
  writeFileSync(join(fixtureRoot, "dirty-fixture", "CLAUDE.md"), "# not allowed");
  const withFixture = {
    ...registration,
    tasks: [{
      id: "fx", kind: "signal", predict: "helps",
      spec: { id: "fx", prompt: "fixture task", fixture: "dirty-fixture", verify: { type: "any", patterns: ["reply"] } },
    }],
  };
  await assert.rejects(
    () => runSuite({ registration: withFixture, requested: { ...requested, taskIds: ["fx"] }, skillFile: join(dir, "SKILL.md"), fixtureRoot }),
    /not isolated/,
  );
  clean(dir);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test("gradedCounts reports per-arm graded totals", () => {
  const recs = [
    { task: "a", cond: "control", pass: true, failed: false },
    { task: "a", cond: "control", pass: false, failed: true },
    { task: "a", cond: "treatment", pass: true, failed: false },
  ];
  assert.deepEqual(gradedCounts(recs), { a: { control: 1, treatment: 1 } });
});
