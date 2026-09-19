import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const STUB = fileURLToPath(new URL("../../tools/stub-claude.mjs", import.meta.url));
const sha = (s) => createHash("sha256").update(s).digest("hex");

// Builds a suite on disk and returns its directory. `tasks` are task specs; the
// registration is written with correct hashes unless `corrupt` names a task to break.
export function makeSuite({ tasks, reps = 4, omitHarm = false, corrupt = null }) {
  const dir = mkdtempSync(join(tmpdir(), "nb-e2e-"));
  mkdirSync(join(dir, "tasks"));
  // Deliberately shares NO vocabulary with any verifier pattern below. An earlier
  // version read "Say the word denominator." while SIGNAL's verifier matched
  // "denominator" -- the exact gaming recipe PATTERN_IN_SKILL exists to flag, sitting
  // in nullbench's own fixtures. The new check caught it, which is how it was found.
  writeFileSync(join(dir, "SKILL.md"), "# demo skill\nAsk what a count leaves out before treating it as evidence.");

  const entries = [];
  for (const t of tasks) {
    if (omitHarm && t.kind === "harm") continue;
    const body = JSON.stringify(t);
    writeFileSync(join(dir, "tasks", `${t.id}.json`), body);
    entries.push({
      id: t.id, file: `tasks/${t.id}.json`,
      sha256: corrupt === t.id ? "0".repeat(64) : sha(body),
      kind: t.kind, predict: t.predict ?? (t.kind === "harm" ? "no-effect" : "helps"),
    });
  }
  writeFileSync(join(dir, "nullbench.json"),
    JSON.stringify({ model: "sonnet", judge_model: "sonnet", reps, tasks: entries }, null, 2));
  return dir;
}

export function useStub(dir, plan) {
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  process.env.NULLBENCH_CLAUDE_BIN = STUB;
  process.env.NULLBENCH_STUB_PLAN = join(dir, "plan.json");
  process.env.NULLBENCH_STUB_STATE = join(dir, "state.json");
}
export function clearStub() {
  for (const k of ["NULLBENCH_CLAUDE_BIN", "NULLBENCH_STUB_PLAN", "NULLBENCH_STUB_STATE"]) delete process.env[k];
}

// Collects everything main() writes to stdout.
export function capture() {
  let buf = "";
  return { stdout: { write: (s) => { buf += s; return true; } }, text: () => buf };
}

export const ledger = (dir) => readFileSync(join(dir, "LEDGER.md"), "utf8");

// TWO signal tasks, deliberately. With one, "the average is suppressed" is true under
// every implementation (a mean needs two discriminating tasks), and "non-discriminating"
// is satisfied by the harm row -- so both assertions pass with ceiling detection ripped
// out. Two signal tasks is what makes these tests falsifiable.
export const SIGNAL = { id: "sig", kind: "signal", prompt: "is three caught enough", verify: { type: "any", patterns: ["denominator"] } };
export const SIGNAL2 = { id: "sig2", kind: "signal", prompt: "is the coverage gate sound", verify: { type: "any", patterns: ["gaming"] } };
export const HARM = { id: "harm", kind: "harm", prompt: "btree versus gin", verify: { type: "none", patterns: ["goodhart"], maxWords: 500 } };

// A judge-graded task, for canary/preflight tests -- none of SIGNAL/SIGNAL2/HARM route
// through runJudge, and both the canary-loading and canary-counting fixes only engage
// when at least one requested task is verify.type "judge".
export const JUDGE = { id: "jsig", kind: "signal", prompt: "please grade this reply", verify: { type: "judge", rubric: "RUBRIC TEXT" } };
