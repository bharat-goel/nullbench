import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs, plan, findRepoRoot } from "../src/cli.mjs";

const BIN = fileURLToPath(new URL("../bin/nullbench.mjs", import.meta.url));
const STUB = fileURLToPath(new URL("../tools/stub-claude.mjs", import.meta.url));

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

// findRepoRoot backs Ruling 1 (isolate against the repository, not the suite
// directory). Built entirely under a fresh temp dir so these don't depend on -- or
// break when moved out of -- this repository's own layout.

test("findRepoRoot returns the nearest ancestor containing a .git entry", () => {
  const root = mkdtempSync(join(tmpdir(), "nb-repo-"));
  const repo = join(root, "myrepo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const suite = join(repo, "eval", "sub");
  mkdirSync(suite, { recursive: true });
  assert.equal(findRepoRoot(suite), join(root, "myrepo"));
  rmSync(root, { recursive: true, force: true });
});

test("findRepoRoot falls back to the registration dir when no .git exists above it", () => {
  const root = mkdtempSync(join(tmpdir(), "nb-repo-"));
  const suite = join(root, "no-git", "suite");
  mkdirSync(suite, { recursive: true });
  assert.equal(findRepoRoot(suite), suite);
  rmSync(root, { recursive: true, force: true });
});

test("findRepoRoot terminates at the filesystem root instead of looping", () => {
  // dirname("/") === "/" is the loop's own termination condition. Calling directly at
  // the root exercises it without relying on a deep tree to reach there, and without
  // risking a hang if the termination check were ever removed by mistake.
  assert.equal(findRepoRoot("/"), "/");
});

// Reporting-stage crash must still surface as a clean, non-zero process exit, and must
// not skip the ledger append. Run through the actual bin/nullbench.mjs entry point
// (not main() directly) since the bug this pins is specifically in the thin wrapper:
// an unhandled rejection escaping to Node's own generic exit behavior instead of the
// protocol's contract of 0/1/2.

function setUpSuite() {
  const dir = mkdtempSync(join(tmpdir(), "nb-cli-crash-"));
  const skillFile = join(dir, "SKILL.md");
  writeFileSync(skillFile, "# demo skill\n");
  const taskSpec = { prompt: "the smoke test question", verify: { type: "any", patterns: ["denominator"] } };
  const taskPath = join(dir, "sig.json");
  writeFileSync(taskPath, JSON.stringify(taskSpec));
  const sha256 = createHash("sha256").update(readFileSync(taskPath)).digest("hex");
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify({
    model: "sonnet", judge_model: "sonnet", reps: 4,
    tasks: [{ id: "sig", file: "sig.json", sha256, kind: "signal", predict: "helps" }],
  }));
  const planPath = join(dir, "plan.json");
  writeFileSync(planPath, JSON.stringify({ default: { outs: ["the denominator is fine"] } }));
  return { dir, skillFile, planPath };
}

test("a reporting-stage crash still appends to the ledger and exits non-zero, not as an unhandled rejection", () => {
  const { dir, skillFile, planPath } = setUpSuite();
  // Force the reporting stage's readFileSync(skillFile) to fail with EACCES, the same
  // mechanism the review used live. runSuite itself never reads this file's contents
  // (the stub only checks for the --append-system-prompt-file flag), so the run
  // completes and pays for its batch before this bites.
  chmodSync(skillFile, 0o000);
  try {
    const result = spawnSync(process.execPath, [BIN, dir, "--yes"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NULLBENCH_CLAUDE_BIN: STUB,
        NULLBENCH_STUB_PLAN: planPath,
        NULLBENCH_STUB_STATE: join(dir, "state.json"),
      },
    });
    assert.equal(result.status, 1, `expected exit code 1, got ${result.status}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /EACCES/, "the original error must be surfaced, not swallowed");
    // Node's exit code for a top-level unhandled rejection happens to already be 1 on
    // this runtime, so status alone does not distinguish "caught and reported cleanly"
    // from "escaped as an unhandled rejection" -- both would pass a bare status check.
    // The raw-crash form prints the offending source line, a "^" caret pointer, and a
    // trailing "Node.js vX.Y.Z" banner; a caught, console.error(e)'d Error does not.
    // Removing the try/catch in bin/nullbench.mjs must fail these two assertions.
    assert.doesNotMatch(result.stderr, /Node\.js v\d/, "error must be caught and reported, not left as a raw unhandled-rejection crash");
    assert.doesNotMatch(result.stderr, /^\s*\^\s*$/m, "error must be caught and reported, not left as a raw unhandled-rejection crash");
    const ledger = readFileSync(join(dir, "LEDGER.md"), "utf8");
    assert.match(ledger, /# Run ledger/);
    assert.match(ledger, /model=sonnet judge=sonnet reps=4/, "the ledger append must still happen even though reporting crashed");
  } finally {
    chmodSync(skillFile, 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});
