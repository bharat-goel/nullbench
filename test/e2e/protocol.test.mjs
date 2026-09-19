import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli.mjs";
import { makeSuite, useStub, clearStub, capture, ledger, SIGNAL, SIGNAL2, HARM, JUDGE } from "./helpers.mjs";

afterEach(clearStub);

const ALL = [SIGNAL, SIGNAL2, HARM];

// Both signal tasks discriminate: treatment says the magic word, control does not.
const WORKING = {
  rules: [
    { promptIncludes: "three caught", arm: "treatment", outs: ["the denominator is missing"] },
    { promptIncludes: "three caught", arm: "control", outs: ["looks fine"] },
    { promptIncludes: "coverage gate", arm: "treatment", outs: ["that invites gaming"] },
    { promptIncludes: "coverage gate", arm: "control", outs: ["seems reasonable"] },
  ],
  default: { outs: ["a clean neutral answer"] },
};

// sig is at ceiling in both arms; sig2 still discriminates.
const ONE_AT_CEILING = {
  rules: [
    { promptIncludes: "three caught", arm: "any", outs: ["the denominator is missing"] },
    { promptIncludes: "coverage gate", arm: "treatment", outs: ["that invites gaming"] },
    { promptIncludes: "coverage gate", arm: "control", outs: ["seems reasonable"] },
  ],
  default: { outs: ["a clean neutral answer"] },
};

test("a clean run is CONFIRMATORY, prints the average, and lands in the ledger", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  const cap = capture();
  const code = await main([dir, "--yes"], cap);
  assert.equal(code, 0);
  assert.match(cap.text(), /CONFIRMATORY/);
  // Both signal tasks discriminate, so the average MUST print here. Without this the
  // suppression assertions elsewhere are unfalsifiable.
  assert.match(cap.text(), /Average across discriminating signal tasks/);
  assert.match(cap.text(), /no interval/);
  assert.match(ledger(dir), /CONFIRMATORY/);
});

test("TAMPER: editing a task after registration forces EXPLORATORY and no average", async () => {
  // Uses the WORKING plan, where the average would otherwise print -- so the
  // suppression assertion below actually discriminates.
  const dir = makeSuite({ tasks: ALL, corrupt: "sig" });
  useStub(dir, WORKING);
  const cap = capture();
  const code = await main([dir, "--yes"], cap);
  assert.equal(code, 0);
  assert.match(cap.text(), /EXPLORATORY/);
  assert.match(cap.text(), /average across signal tasks: suppressed/i);
  assert.ok(!/Average across discriminating/.test(cap.text()),
    "an exploratory run must not print an average it would have printed when clean");
});

test("FILTER: running a subset of registered tasks forces EXPLORATORY", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  const cap = capture();
  await main([dir, "--yes", "--task", "sig"], cap);
  assert.match(cap.text(), /EXPLORATORY/);
  assert.match(cap.text(), /task set differs/);
});

test("MISSING HARM: a suite with no negative control cannot be confirmed", async () => {
  const dir = makeSuite({ tasks: ALL, omitHarm: true });
  useStub(dir, WORKING);
  const cap = capture();
  await main([dir, "--yes"], cap);
  assert.match(cap.text(), /EXPLORATORY/);
  assert.match(cap.text(), /negative control/);
});

test("CEILING: the ceiling task's own row is flagged and the discriminating one is not", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, ONE_AT_CEILING);
  const cap = capture();
  await main([dir, "--yes"], cap);
  const lines = cap.text().split("\n");
  const sigRow = lines.find((l) => l.includes("`sig`"));
  const sig2Row = lines.find((l) => l.includes("`sig2`"));
  // Asserting on the ROWS, not on the presence of the word anywhere: the harm row is
  // also at 100/100 and would satisfy a document-wide match with detection removed.
  assert.match(sigRow, /non-discriminating/, "the ceiling signal task must be flagged");
  assert.ok(!/non-discriminating/.test(sig2Row), "the discriminating task must not be flagged");
  assert.match(cap.text(), /1 of 2 signal tasks discriminate/);
});

test("DEAD RUNS: a batch with too few graded runs is VOID, exits 1, and still logs", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, { default: { outs: [""], code: 1 } });
  const cap = capture();
  const code = await main([dir, "--yes"], cap);
  assert.equal(code, 1, "a void batch must exit non-zero");
  assert.match(cap.text(), /VOID/);
  assert.ok(!/[+-]\d+\.\d+pp/.test(cap.text()), "no deltas printed for a void batch");
  assert.match(ledger(dir), /VOID/, "the file drawer stays shut");
});

test("FILE DRAWER: a run that spends anything is logged; a dry run is not", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  await main([dir, "--dry-run"], capture());
  assert.equal(existsSync(join(dir, "LEDGER.md")), false, "a dry run spends nothing and logs nothing");
  await main([dir, "--yes"], capture());
  assert.ok(ledger(dir).includes("CONFIRMATORY"));
});

test("FILE DRAWER: a crash after the batch still leaves a ledger entry", async () => {
  // The expensive failure: the runs are paid for, then something downstream throws, and
  // the batch vanishes. `main` wraps the post-run block in try/finally for this reason.
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  // A plain rmSync trips cli.mjs's own structural `existsSync(skillFile)` gate (added
  // deliberately in Task 11 -- see the comment above `structural` in src/cli.mjs) and
  // returns exit code 2 before the batch runs at all, which defeats the point of this
  // test. A directory passes `existsSync` (so the batch runs and gets paid for) but
  // fails `readFileSync(skillFile, "utf8")` in the post-run leakage scan with EISDIR,
  // root-safe -- the same trick test/cli.test.mjs already uses for this exact scenario.
  rmSync(join(dir, "SKILL.md"));
  mkdirSync(join(dir, "SKILL.md"));
  await main([dir, "--yes"], capture()).catch(() => {});
  assert.equal(existsSync(join(dir, "LEDGER.md")), true,
    "a batch that was paid for must never disappear from the ledger");
});

// RULING B: nothing in the repository asserts exit code 2 (RegistrationError). The CLI's
// contract is 0 for CONFIRMATORY/EXPLORATORY, 1 for VOID, 2 for a RegistrationError --
// distinguishing "your registration is broken" from "your result was void". Without this
// test the two codes could be swapped and nothing would notice. Cause here is genuinely
// structural: an unknown --task id, which main() rejects before any run happens.
test("STRUCTURAL: an unknown --task id is a RegistrationError, exit code 2, never 1", async () => {
  const dir = makeSuite({ tasks: ALL });
  useStub(dir, WORKING);
  const cap = capture();
  const code = await main([dir, "--yes", "--task", "does-not-exist"], cap);
  assert.equal(code, 2, "a structurally invalid registration/request must exit 2");
  assert.notEqual(code, 1, "a RegistrationError must not collapse into the VOID exit code");
  assert.equal(existsSync(join(dir, "LEDGER.md")), false,
    "nothing ran, so nothing should be logged");
});

// Task 15 fix round 1, Finding 1 + 2: canaries.json must be loaded and validated
// during the free preflight, not only once the batch has been paid for. A cobra-style
// canaries.json still carrying its "_comment" key is exactly the shape that slipped
// through before this test existed -- loadCanaries treats every top-level key as a
// task id, so "_comment" reads as a reference to an unregistered task.
test("PREFLIGHT: a canaries.json referencing an unregistered task id fails a dry run with exit 2 and names the id", async () => {
  const dir = makeSuite({ tasks: [JUDGE, HARM] });
  writeFileSync(join(dir, "canaries.json"), JSON.stringify({
    _comment: "not a task",
    jsig: [{ label: "ok", expect: "PASS", reply: "a fine reply" }],
  }));
  const cap = capture();
  const code = await main([dir, "--dry-run"], cap);
  assert.equal(code, 2, "a broken canaries.json is structural, not a run outcome");
  assert.match(cap.text(), /"_comment"/, "the offending id must be named");
  assert.equal(existsSync(join(dir, "results")), false, "a dry run must still spend nothing");
});

// Finding 2's regression guard: fixing the above must not turn "no canaries.json at
// all" into an error. That is the documented, intentional un-gated state -- a warning,
// not a RegistrationError -- both during a free dry run and once a real run proceeds.
test("PREFLIGHT: a judged suite with no canaries.json at all still dry-runs clean and still warns for real", async () => {
  const dir = makeSuite({ tasks: [JUDGE, HARM] });
  useStub(dir, {
    rules: [{ promptIncludes: "RUBRIC TEXT", arm: "any", outs: ["VERDICT: PASS\nREASON: fine"] }],
    default: { outs: ["a plain reply"] },
  });

  const dryCap = capture();
  const dryCode = await main([dir, "--dry-run"], dryCap);
  assert.equal(dryCode, 0, "a missing canaries.json must not become a dry-run error");
  assert.doesNotMatch(dryCap.text(), /RegistrationError|canary references/i);

  const runCap = capture();
  const code = await main([dir, "--yes"], runCap);
  assert.notEqual(code, 2, "a missing canaries.json must not become a structural error for a real run either");
  assert.match(runCap.text(), /This suite has judge-graded tasks but no canaries\.json/);
});

// Finding 3: the cost preflight must count canary calls, and show them on their own
// line, not fold them silently into TOTAL or omit them.
test("PREFLIGHT: canary calls are counted and shown on their own line, and included in TOTAL", async () => {
  const dir = makeSuite({ tasks: [JUDGE, HARM] }); // reps defaults to 4 in makeSuite
  writeFileSync(join(dir, "canaries.json"), JSON.stringify({
    jsig: [
      { label: "a", expect: "PASS", reply: "x" },
      { label: "b", expect: "FAIL", reply: "y" },
    ],
  }));
  const cap = capture();
  const code = await main([dir, "--dry-run"], cap);
  assert.equal(code, 0);
  // subjectRuns = 2 tasks x 2 arms x 4 reps = 16; judgeRuns = 1 judged task x 2 x 4 = 8;
  // canaryRuns = 2 -> total 26.
  assert.match(cap.text(), /canary runs {3}2\b/);
  assert.match(cap.text(), /TOTAL {9}26 CLI invocations/);
});

// CRITICAL 2's end-to-end guard. A judge that stops answering partway through a batch
// (rate limit, auth expiry, a crashed CLI) used to be indistinguishable from a judge
// that graded everything FAIL: runJudge set no `failed` flag, so every dead judge call
// was recorded as a graded wrong answer. Both arms then sat at 0%, the delta came out
// near zero with a tight interval, the graded-run floor was cleared because no cell
// looked thin, and the batch printed as a clean, quotable null. PROTOCOL.md 5.1 says a
// run that produced no reply leaves the denominator; a judge-graded run is no
// exception. The subject here is healthy -- only the judge is dead -- which is what
// makes this a test of the judge path and not of the existing DEAD RUNS case.
test("DEAD JUDGE: a judge that never answers voids the batch instead of printing a null", async () => {
  const dir = makeSuite({ tasks: [JUDGE, HARM] });
  useStub(dir, {
    rules: [
      // Only the judge's prompt carries the rubric text, so this rule cannot match the
      // subject invocation -- the subject's own prompt is "please grade this reply".
      { promptIncludes: "RUBRIC TEXT", arm: "any", outs: ["VERDICT: PASS\nREASON: should never be read"], code: 1 },
    ],
    default: { outs: ["a healthy subject reply"] },
  });
  const cap = capture();
  const code = await main([dir, "--yes"], cap);
  assert.equal(code, 1, "a batch whose judge never answered must exit non-zero, not 0");
  assert.match(cap.text(), /VOID/);
  assert.ok(!/[+-]\d+\.\d+pp/.test(cap.text()),
    "a dead judge must not produce a printable delta -- that is the quotable null this exists to prevent");
  assert.match(ledger(dir), /VOID/, "the file drawer stays shut");
});

// PATTERN_IN_SKILL — the cobra test applied to nullbench itself.
//
// The gaming recipe: give a signal task a verifier pattern lifted verbatim from your own
// SKILL.md. Control has never seen the word and cannot say it; treatment reads it off the
// injected system prompt. Both cells swing from floor to ceiling, the intervals sit far
// from zero, and the report reads CONFIRMATORY for a skill that did nothing. That is
// FAILURES.md entry 1, reproduced deliberately rather than by accident.

test("GAMING: a verifier pattern lifted from SKILL.md is drift, flagged before any spend", async () => {
  const dir = makeSuite({ tasks: ALL });
  writeFileSync(join(dir, "SKILL.md"), "# demo skill\nAlways say denominator when a count lacks one.");
  useStub(dir, { default: { outs: ["a plain reply"] } });

  // --dry-run: the flag must be raised before the user is asked to spend anything.
  const dry = capture();
  const dryCode = await main([dir, "--dry-run"], dry);
  assert.equal(dryCode, 0);
  // The CLI prints a drift entry's `detail`, not its internal `code` -- same as
  // HASH_MISMATCH. Assert on what a user actually sees.
  assert.match(dry.text(), /appears verbatim in SKILL\.md/);
  assert.match(dry.text(), /denominator/, "the offending pattern must be named");
  assert.match(dry.text(), /"sig"/, "the offending task must be named");
  assert.match(dry.text(), /cannot be confirmatory/);

  const run = capture();
  await main([dir, "--yes"], run);
  assert.match(run.text(), /EXPLORATORY/, "a skill-lifted pattern must block CONFIRMATORY");
});

test("GAMING: a harm task's `none` pattern may name the skill's vocabulary without being flagged", async () => {
  // The vocabulary-leak negative control is the shape this project recommends: a harm
  // task asserting the skill does not inject its own words into an unrelated answer MUST
  // quote those words to do its job. Flagging it would put permanent drift on the two
  // negative controls nullbench itself ships, and it cannot be gamed in the rewarding
  // direction -- a skill-lifted `none` pattern can only make treatment look worse.
  const dir = makeSuite({ tasks: ALL });
  writeFileSync(join(dir, "SKILL.md"), "# demo skill\nBeware goodhart when a count stands in for the thing itself.");
  useStub(dir, { default: { outs: ["a plain reply"] } });

  const cap = capture();
  const code = await main([dir, "--dry-run"], cap);
  assert.equal(code, 0);
  assert.doesNotMatch(cap.text(), /appears verbatim in SKILL\.md/,
    "a harm task's `none` pattern naming skill vocabulary is the negative control working, not gaming");
});

test("SKILL OVERRIDE: --skill swaps the thing under test and cannot be confirmatory", async () => {
  const dir = makeSuite({ tasks: ALL });
  const other = join(dir, "other-skill.md");
  writeFileSync(other, "# a different skill\nSomething else entirely.");
  useStub(dir, { default: { outs: ["a plain reply"] } });

  const cap = capture();
  const code = await main([dir, "--yes", "--skill", other], cap);
  assert.equal(code, 0);
  assert.match(cap.text(), /EXPLORATORY/, "running a skill other than the registered one cannot be confirmed");
  assert.match(cap.text(), /skill differs/, "the report must say which skill actually ran");
});

test("PREFLIGHT: a task declaring a fixture that does not exist fails the dry run, before any spend", async () => {
  // makeCwd throws on a missing fixture and that throw aborts the whole batch -- after
  // the canaries have been paid for. The worked example hit exactly this: 13 canary
  // calls spent, then an abort on a directory whose absence was knowable for free.
  const FIXTURE_TASK = {
    id: "fx", kind: "signal", predict: "helps", prompt: "a task needing a project",
    fixture: "no-such-fixture", verify: { type: "any", patterns: ["x"] },
  };
  const dir = makeSuite({ tasks: [FIXTURE_TASK, HARM] });
  useStub(dir, { default: { outs: ["a plain reply"] } });

  const cap = capture();
  const code = await main([dir, "--dry-run"], cap);
  assert.equal(code, 2, "a missing fixture is structural, not drift");
  assert.notEqual(code, 1, "must not be confused with VOID");
  assert.match(cap.text(), /no-such-fixture/, "the missing fixture must be named");
  assert.match(cap.text(), /"fx"/, "the task needing it must be named");
});
