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

test("concurrent stub invocations do not lose updates to the shared state file", async () => {
  // A longer cycle makes a lost update far less likely to coincidentally land on the
  // correct value anyway; many batches of high concurrency give the race repeated,
  // independent chances to be hit. (8 concurrent calls over a 3-element cycle detected
  // a deliberately-removed lock in only ~60-80% of runs -- not a reliable gate.)
  const outs = ["a", "b", "c", "d", "e", "f", "g"];
  const BATCHES = 6;
  const PER_BATCH = 32;
  const plan = { rules: [{ promptIncludes: "x", arm: "any", outs }], default: { outs: ["z"] } };
  await withStub(plan, async (dir) => {
    const all = [];
    for (let b = 0; b < BATCHES; b++) {
      const calls = Array.from({ length: PER_BATCH }, () => invoke({ prompt: "x", cwd: dir, model: "sonnet" }));
      const results = await Promise.all(calls);
      all.push(...results.map((r) => r.out));
    }
    const total = BATCHES * PER_BATCH;
    const expectedCounts = new Array(outs.length).fill(0);
    for (let i = 0; i < total; i++) expectedCounts[i % outs.length]++;
    const expected = outs.flatMap((o, idx) => Array(expectedCounts[idx]).fill(o)).sort();
    // Order is genuinely nondeterministic under concurrency, so assert the multiset only.
    assert.deepEqual(all.sort(), expected);
  });
});
