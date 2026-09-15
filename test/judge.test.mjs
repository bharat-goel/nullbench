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

test("a judge whose subprocess exits non-zero fails closed", async () => {
  const dir = stubbed({ default: { outs: ["VERDICT: PASS\nREASON: should never be read"], code: 1 } });
  const r = await runJudge({ task: { prompt: "Q", verify: { rubric: "R" } }, reply: "x", model: "sonnet", cwd: dir });
  assert.equal(r.pass, false);
  assert.match(r.why, /failed to run/);
  unstub(dir);
});

test("a judge whose subprocess exits 0 with empty output fails closed", async () => {
  const dir = stubbed({ default: { outs: [""] } });
  const r = await runJudge({ task: { prompt: "Q", verify: { rubric: "R" } }, reply: "x", model: "sonnet", cwd: dir });
  assert.equal(r.pass, false);
  unstub(dir);
});

test("runJudge never passes a system prompt file, so the skill never reaches the judge", async () => {
  const dir = stubbed({
    rules: [{ promptIncludes: "Q", arm: "control", outs: ["VERDICT: PASS\nREASON: blind"] }],
    default: { outs: ["VERDICT: FAIL\nREASON: fell through to default, a system prompt file was passed"] },
  });
  const r = await runJudge({ task: { prompt: "Q", verify: { rubric: "R" } }, reply: "x", model: "sonnet", cwd: dir });
  assert.equal(r.pass, true);
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
