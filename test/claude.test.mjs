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

// Stable substring of the stub's stderr message when it gives up waiting for the lock
// and proceeds unlocked (see tools/stub-claude.mjs). Matching on this fragment rather
// than the full sentence means rewording that message later can't silently disable
// the check below.
const STALE_LOCK_MARKER = "breaking stale lock";

test("concurrent stub invocations do not lose updates to the shared state file", async () => {
  // A longer cycle makes a lost update far less likely to coincidentally land on the
  // correct value anyway; many batches of high concurrency give the race repeated,
  // independent chances to be hit. (8 concurrent calls over a 3-element cycle detected
  // a deliberately-removed lock in 1 of 5 runs in one measurement, and 3 of 5 in
  // another -- not a reliable gate either way.)
  const outs = ["a", "b", "c", "d", "e", "f", "g"];
  const BATCHES = 6;
  const PER_BATCH = 32;
  const plan = { rules: [{ promptIncludes: "x", arm: "any", outs }], default: { outs: ["z"] } };
  await withStub(plan, async (dir) => {
    const all = [];
    for (let b = 0; b < BATCHES; b++) {
      const calls = Array.from({ length: PER_BATCH }, () => invoke({ prompt: "x", cwd: dir, model: "sonnet" }));
      const results = await Promise.all(calls);
      all.push(...results);
    }
    // Check this before the multiset assertion: a broken lock (from 32-way contention
    // outlasting the stub's ~2s wait on a loaded machine) reproduces the same lost-update
    // symptom as a genuinely missing lock. Failing here first tells the two apart instead
    // of leaving a bare multiset mismatch that looks identical to a real regression.
    const brokeLock = all.filter((r) => r.err.includes(STALE_LOCK_MARKER));
    assert.equal(
      brokeLock.length,
      0,
      `${brokeLock.length} of ${all.length} stub calls broke the state-file lock after timing out ` +
        `(stderr contained "${STALE_LOCK_MARKER}"). This means the run was too slow for the lock's ` +
        `~2s deadline under this batch's contention, not that the lock is broken -- rerun, or lower ` +
        `contention, rather than reading the multiset failure below as a real regression.`
    );

    const outVals = all.map((r) => r.out);
    const total = BATCHES * PER_BATCH;
    const expectedCounts = new Array(outs.length).fill(0);
    for (let i = 0; i < total; i++) expectedCounts[i % outs.length]++;
    const expected = outs.flatMap((o, idx) => Array(expectedCounts[idx]).fill(o)).sort();
    // Order is genuinely nondeterministic under concurrency, so assert the multiset only.
    assert.deepEqual(outVals.sort(), expected);
  });
});

// A standalone echo binary rather than another env knob on the stub: the assertion here
// is about argv itself, and the stub's own argv parsing (it reads the LAST argument as
// the prompt) is one of the two things that could break.
function withArgvEcho(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nb-argv-"));
  const bin = join(dir, "argv-echo.mjs");
  writeFileSync(bin, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n", { mode: 0o755 });
  const prev = process.env.NULLBENCH_CLAUDE_BIN;
  process.env.NULLBENCH_CLAUDE_BIN = bin;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.NULLBENCH_CLAUDE_BIN;
    else process.env.NULLBENCH_CLAUDE_BIN = prev;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("disallowedTools is a single --flag=value token, so it cannot swallow the prompt", async () => {
  await withArgvEcho(async () => {
    const r = await invoke({
      prompt: "the actual prompt", cwd: tmpdir(), model: "sonnet",
      disallowedTools: ["Write", "Edit", "Bash"],
    });
    const argv = JSON.parse(r.out);
    // The flag is variadic in the real CLI. Passing the value as its own argv entry lets
    // it keep consuming, INCLUDING the trailing positional prompt -- verified against the
    // real binary, which turned every word of the prompt into a bogus deny rule
    // ("Permission deny rule \"Our\" matches no known tool") and produced 97 dead runs out
    // of 100. Only the =value form terminates it.
    assert.ok(argv.includes("--disallowedTools=Write,Edit,Bash"),
      `expected a single --disallowedTools=... token, got ${JSON.stringify(argv)}`);
    assert.equal(argv.indexOf("--disallowedTools"), -1, "the separate-entry form is the bug");
    assert.equal(argv[argv.length - 1], "the actual prompt", "the prompt must remain the last positional");
  });
});

test("invoke passes no tool restrictions unless asked", async () => {
  await withArgvEcho(async () => {
    const r = await invoke({ prompt: "p", cwd: tmpdir(), model: "sonnet" });
    assert.ok(!JSON.parse(r.out).includes("--disallowedTools"));
  });
});
