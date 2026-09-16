import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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
  assert.equal(p.canaryRuns, 0);    // no canary count given -- existing callers unaffected
  assert.equal(p.total, 60);
});

// Task 15 fix round 1, Finding 3: runCanaries makes one runJudge call per canary, and
// the preflight was silently omitting that from TOTAL -- a cost preflight that
// undercounts is worse than one that is merely approximate. canaryCount is an
// optional third argument specifically so existing callers (and the test above) are
// unaffected when it is omitted.
test("plan() includes canary calls in the total when a canary count is given", () => {
  const requested = { reps: 10, model: "sonnet", judgeModel: "sonnet", taskIds: ["sig", "harm"] };
  const p = plan(registration, requested, 13);
  assert.equal(p.subjectRuns, 40);
  assert.equal(p.judgeRuns, 20);
  assert.equal(p.canaryRuns, 13);
  assert.equal(p.total, 73);
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
  // skillFile is a DIRECTORY, not a file with restrictive permissions. A chmod-based
  // EACCES is uid-dependent -- root (routine in Docker-based CI, and nullbench is meant
  // to run in other people's CI) ignores permission bits entirely, so readFileSync
  // would succeed, the reporting stage would never throw, and this test would fail on
  // its own setup rather than on the behavior it pins. A directory makes
  // readFileSync(skillFile, "utf8") fail with EISDIR on any uid, root included.
  // existsSync(skillFile) at cli.mjs's structural check is still true for a directory,
  // so the run still reaches and pays for the batch before this bites -- do not
  // "simplify" this back to chmod.
  const skillFile = join(dir, "SKILL.md");
  mkdirSync(skillFile);
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
  // skillFile is a directory (see setUpSuite), so the reporting stage's
  // readFileSync(skillFile) fails with EISDIR. runSuite itself never reads this file's
  // contents (the stub only checks for the --append-system-prompt-file flag), so the
  // run completes and pays for its batch before this bites.
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
    assert.match(result.stderr, /EISDIR/, "the original error must be surfaced, not swallowed");
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
    rmSync(dir, { recursive: true, force: true });
  }
});
