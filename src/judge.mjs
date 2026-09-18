// The blind rubric judge, and the canary that validates it.
//
// Prompt text is adapted from cobra-skill/eval/judge-prompt.mjs (see ATTRIBUTION.md).
// It lives in one place because the grading path and the canary path must use an
// identical prompt -- otherwise the canary certifies a judge that never ran.
//
// The judge is never told which arm produced the reply and never sees the skill.
// Without that it rewards replies that sound like the skill rather than replies that do
// the right thing, which inflates every number in the report. FAILURES.md entry 1 is
// what that looks like when it happens: +70.0pp of pure diction.

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "./claude.mjs";
import { RegistrationError } from "./prereg.mjs";
import { assertIsolated } from "./leakage.mjs";

export function judgePrompt(task, reply) {
  return [
    "You are grading one reply against a rubric. You do not know how it was produced.",
    "",
    "=== QUESTION THE REPLY WAS ANSWERING ===",
    task.prompt,
    "",
    "=== RUBRIC ===",
    task.verify.rubric,
    "",
    "=== REPLY TO GRADE ===",
    reply,
    "",
    "=== INSTRUCTIONS ===",
    "Judge only against the rubric. Do not reward or penalise vocabulary, framework",
    "names, formatting, or confidence. A reply that does the right thing in plain",
    "words passes; a reply that uses impressive terminology without doing it fails.",
    "Output exactly two lines:",
    "VERDICT: PASS or FAIL",
    "REASON: one sentence",
  ].join("\n");
}

export function parseVerdict(text) {
  const verdict = /VERDICT:\s*(PASS|FAIL)/i.exec(text);
  const reason = /REASON:\s*(.+)/i.exec(text);
  if (!verdict) return null;
  return { pass: verdict[1].toUpperCase() === "PASS", why: (reason?.[1] ?? "").trim().slice(0, 110) };
}

export async function runJudge({ task, reply, model, cwd }) {
  const { out, code } = await invoke({ prompt: judgePrompt(task, reply), cwd, model });
  // `failed` means "no answer", not "wrong answer" -- the run leaves the denominator
  // entirely (PROTOCOL.md 5.1). A judge that never ran produced no grade, so the
  // subject run it was grading is ungraded. Without this flag a judge rate-limit
  // partway through a batch drove both arms toward 0%, cleared the graded-run floor
  // (nothing was marked failed, so no cell looked thin) and printed a tight, quotable
  // null. That is FAILURES.md entry 8 on the judge path.
  if (code !== 0 || !out) return { pass: false, failed: true, why: "judge failed to run" };
  const v = parseVerdict(out);
  // Deliberately NOT `failed`. The judge answered; the answer was unusable. That is a
  // graded FAIL and belongs in the denominator -- collapsing it into the branch above
  // would let a judge that reliably waffles silently shrink every batch instead.
  if (!v) return { pass: false, why: "judge returned no verdict" };
  return { pass: v.pass, why: `judge: ${v.why}` };
}

// Known-pass and known-fail replies graded before any real run. A judge that misgrades
// a canary is not a judge, and the suite's judged tasks are suppressed rather than
// reported. The observed misgrade rate is published rather than assumed to be zero --
// in the cobra suite it was 1 in 40 judged runs against 0 in 63 canary gradings.
// Canaries live in a file keyed by task id and carry only a label, a reply, and the
// expected verdict. The prompt and rubric come from the registered task itself: a
// canary that supplied its own copy of the rubric would keep passing after the task's
// rubric changed, certifying a judge against text no task uses. That is precisely an
// unverified safeguard, and FAILURES.md exists because of them.
export function loadCanaries(path, registration) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const byId = new Map(registration.tasks.map((t) => [t.id, t]));
  const out = [];
  const problems = [];
  for (const [taskId, entries] of Object.entries(raw)) {
    const task = byId.get(taskId);
    if (!task) { problems.push(`canary references task "${taskId}", which is not registered`); continue; }
    if (task.spec.verify.type !== "judge") { problems.push(`canary references task "${taskId}", which is not judge-graded`); continue; }
    for (const e of entries) {
      out.push({ id: `${taskId}:${e.label}`, task: taskId, prompt: task.spec.prompt, rubric: task.spec.verify.rubric, reply: e.reply, expect: e.expect });
    }
  }
  if (problems.length) throw new RegistrationError(problems);
  return out;
}

// One sandbox per canary call, not one for the whole set -- the same lifecycle the runner
// gives every measured invocation, and for the same reason: a single directory reused
// across calls is checked once and can be dirtied afterwards by anything that runs in it.
// The blast radius here is smaller (canaries grade fixed replies before the batch and
// cannot touch a measured run), but a sandbox whose isolation is asserted at t=0 and then
// shared is precisely the shape of the bug this project found in its own runner.
//
// `cwd` is still accepted, and when given is used as-is for every call: the tests pass a
// directory they control, and a caller who wants one sandbox can still have one. The CLI
// passes `repoRoot` instead and gets the per-call lifecycle.
export async function runCanaries({ canaries, model, cwd = null, repoRoot = null }) {
  const misgrades = [];
  const dead = [];
  for (const c of canaries) {
    const task = { prompt: c.prompt, verify: { rubric: c.rubric } };
    let dir = cwd, temporary = false;
    if (!dir) {
      dir = mkdtempSync(join(tmpdir(), "nullbench-canary-"));
      temporary = true;
      const iso = assertIsolated(dir, repoRoot ?? dir);
      if (!iso.ok) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`canary sandbox is not isolated:\n  - ${iso.problems.join("\n  - ")}`);
      }
    }
    let got;
    try {
      got = await runJudge({ task, reply: c.reply, model, cwd: dir });
    } finally {
      if (temporary) rmSync(dir, { recursive: true, force: true });
    }
    const expected = c.expect.toUpperCase() === "PASS";
    // A judge that never answered did not misgrade anything -- the same dead-run-versus
    // wrong-answer distinction the runner and the report already make, which this path
    // was missing. Counting a dead call as a misgrade reports a judge as broken when the
    // API was. Observed live: a session limit mid-batch turned 13/13 into 7/13, and the
    // six "misgrades" were all calls that never reached the model.
    if (got.failed) { dead.push({ id: c.id, why: got.why }); continue; }
    if (got.pass !== expected) misgrades.push({ id: c.id, expected: c.expect, got: got.pass ? "PASS" : "FAIL", why: got.why });
  }
  // `ok` requires that the canaries actually ran. An ungated judge and an unverifiable
  // one are equally unconfirmable, and neither may pass silently.
  const graded = canaries.length - dead.length;
  return {
    ok: misgrades.length === 0 && dead.length === 0,
    misgrades, dead, graded, total: canaries.length,
  };
}
