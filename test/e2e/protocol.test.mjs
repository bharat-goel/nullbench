import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli.mjs";
import { makeSuite, useStub, useSkillDir, clearStub, capture, ledger, SIGNAL, SIGNAL2, HARM, JUDGE } from "./helpers.mjs";

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

// RUBRIC_TERM_IN_SKILL -- the same failure with a judge rubric in place of a pattern.
// skill-audit's uap-release-analyzer run: rubrics passing a reply only if it named the
// skill's own scripts carried 29 of 34 extra treatment passes, and PATTERN_IN_SKILL could
// not see them because there was no pattern to check. A warning, not drift: a rubric
// naming a skill-taught API can be a legitimate test of a reference skill, so the reader
// is told, and the class is left alone.
test("GAMING: a judge rubric naming a file only the skill teaches is warned about before any spend, and in the report and ledger", async () => {
  const rubricTask = { id: "jboot", kind: "signal", prompt: "how do I get from a download to a report",
    verify: { type: "judge", rubric: "RUBRIC TEXT. PASS if the reply says to run scripts/run_all.py." } };
  const dir = makeSuite({ tasks: [rubricTask, HARM] });
  writeFileSync(join(dir, "SKILL.md"), "# demo skill\nRun scripts/run_all.py on the release root.");
  useStub(dir, {
    rules: [{ promptIncludes: "RUBRIC TEXT", arm: "any", outs: ["VERDICT: PASS\nREASON: fine"] }],
    default: { outs: ["a plain reply"] },
  });

  const dry = capture();
  assert.equal(await main([dir, "--dry-run"], dry), 0);
  assert.match(dry.text(), /task "jboot" rubric grades term\(s\) found in SKILL\.md/);
  assert.match(dry.text(), /scripts\/run_all\.py/);
  assert.doesNotMatch(dry.text(), /drift detected/, "a rubric term is a warning, never drift");

  const run = capture();
  await main([dir, "--yes"], run);
  assert.match(run.text(), /task "jboot" rubric grades term/, "the report carries the warning");
  assert.match(ledger(dir), /task "jboot" rubric grades term/, "and so does the ledger");
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

// skill_dir end-to-end wiring, item by item against nullbench-skilldir-brief.md.

// N4 (fix round 2): resolveSkill(dir, {override}) always returns kind:"file" for an
// override -- correct, --skill is always a single file -- but classify.mjs used the
// RESOLVED skill's kind to decide whether to say "registered skill_dir" or "registered
// SKILL.md", so that branch could never fire for a skill_dir suite: with an override
// present, registration.skill.kind is always "file" regardless of what was actually
// registered. Tested through loadRegistration + classify's real inputs (a real
// skill_dir suite, a real --skill run), not a hand-built registration object standing
// in for one.
test("SKILL OVERRIDE: on a skill_dir suite, the reason names skill_dir, not SKILL.md", async () => {
  const dir = makeSuite({ tasks: ALL });
  useSkillDir(dir, { "SKILL.md": "# demo skill\nAsk what a count leaves out." });
  const other = join(dir, "other-skill.md");
  writeFileSync(other, "# a different skill\nSomething else entirely.");
  useStub(dir, { default: { outs: ["a plain reply"] } });

  const cap = capture();
  const code = await main([dir, "--yes", "--skill", other], cap);
  assert.equal(code, 0);
  assert.match(cap.text(), /EXPLORATORY/);
  assert.match(cap.text(), /registered skill_dir/, "the reason must name skill_dir, since that's what was actually registered");
  assert.doesNotMatch(cap.text(), /registered SKILL\.md/);
});

// Retitled and rewritten (fix round 2, "SKILLDIR 1"): this used to assert only exit 0
// and CONFIRMATORY, which is true of ANY clean skill_dir run and proves nothing
// specific about the system prompt actually reaching the CLI. The pure
// renderSkillSystemPrompt unit test in test/runner.test.mjs covers the STRING it
// builds; nothing end-to-end confirmed runner.mjs actually PASSES that file to the
// real invocation. NULLBENCH_STUB_ECHO_SYSTEM_PROMPT closes that: the stub reads back
// whatever --append-system-prompt-file pointed at and echoes it, landing in the raw
// reply file main() writes to disk.
test("SKILLDIR: the system prompt actually reaching the CLI starts with the Base directory line", async () => {
  const dir = makeSuite({ tasks: ALL });
  useSkillDir(dir, {
    "SKILL.md": "# demo skill\nAsk what a count leaves out before treating it as evidence.",
    "references/foo.md": "a reference file, loaded on demand, not injected wholesale",
  });
  useStub(dir, WORKING);
  process.env.NULLBENCH_STUB_ECHO_SYSTEM_PROMPT = "1";
  const cap = capture();
  let code;
  try {
    code = await main([dir, "--yes"], cap);
  } finally {
    delete process.env.NULLBENCH_STUB_ECHO_SYSTEM_PROMPT;
  }
  assert.equal(code, 0);
  assert.match(cap.text(), /CONFIRMATORY/, "a clean skill_dir run must still confirm");

  const reportMatch = /Report: (.+report\.md)/.exec(cap.text());
  assert.ok(reportMatch, "main() must announce the report path");
  const rawDir = join(reportMatch[1], "..", "raw");
  const treatmentReply = readFileSync(join(rawDir, "sig__treatment__1.txt"), "utf8");
  const systemPrompt = /<system-prompt>([\s\S]*?)<\/system-prompt>/.exec(treatmentReply)?.[1] ?? "";
  assert.match(systemPrompt, /^Base directory for this skill: /, "the file the CLI actually received must start with the Base directory line");
  assert.match(systemPrompt, /demo skill/, "and it must carry SKILL.md's own text");

  const controlReply = readFileSync(join(rawDir, "sig__control__1.txt"), "utf8");
  const controlSystemPrompt = /<system-prompt>([\s\S]*?)<\/system-prompt>/.exec(controlReply)?.[1] ?? "";
  assert.equal(controlSystemPrompt, "", "control must never receive a system prompt file at all");
});

test("SKILLDIR: PATTERN_IN_SKILL fires on a pattern found only in a reference file, not SKILL.md", async () => {
  const dir = makeSuite({ tasks: ALL });
  useSkillDir(dir, {
    "SKILL.md": "# demo skill\nOrdinary guidance, nothing quotable here.",
    // "denominator" is SIGNAL's verifier pattern (see helpers.mjs) -- it appears only
    // in this reference file, never in SKILL.md itself.
    "references/answer-key.md": "Always say denominator when a count lacks one.",
  });
  useStub(dir, { default: { outs: ["a plain reply"] } });

  const cap = capture();
  const code = await main([dir, "--dry-run"], cap);
  assert.equal(code, 0);
  // The match is in a reference file, not SKILL.md -- the message must say so rather
  // than naming SKILL.md when the actual hit could be anywhere in skill_dir.
  assert.match(cap.text(), /appears verbatim in skill_dir/, "a skill_dir suite's drift message must name skill_dir, not SKILL.md");
  assert.doesNotMatch(cap.text(), /appears verbatim in SKILL\.md/);
  assert.match(cap.text(), /denominator/, "the offending pattern must be named");
  assert.match(cap.text(), /"sig"/, "the offending task must be named");
});

test("SKILLDIR: a symlink anywhere in skill_dir is a structural failure, exit 2, nothing spent", async () => {
  const dir = makeSuite({ tasks: ALL });
  writeFileSync(join(dir, "elsewhere.md"), "outside the skill directory");
  useSkillDir(dir, { "SKILL.md": "# demo skill" });
  symlinkSync(join(dir, "elsewhere.md"), join(dir, "skill", "linked.md"));
  useStub(dir, { default: { outs: ["a plain reply"] } });

  const cap = capture();
  const code = await main([dir, "--dry-run"], cap);
  assert.equal(code, 2, "a symlink in skill_dir must be structural, not drift");
  assert.match(cap.text(), /symlink/);
  assert.equal(existsSync(join(dir, "results")), false, "nothing must be spent");
});

test("SKILLDIR: a fixture carrying a top-level `skill` entry is a structural failure", async () => {
  const FIXTURE_TASK = {
    id: "fx", kind: "signal", predict: "helps", prompt: "a task needing a project",
    fixture: "colliding-fixture", verify: { type: "any", patterns: ["x"] },
  };
  const dir = makeSuite({ tasks: [FIXTURE_TASK, HARM] });
  useSkillDir(dir, { "SKILL.md": "# demo skill" });
  mkdirSync(join(dir, "colliding-fixture", "skill"), { recursive: true });
  writeFileSync(join(dir, "colliding-fixture", "README.md"), "a fixture project");
  useStub(dir, { default: { outs: ["a plain reply"] } });

  const cap = capture();
  const code = await main([dir, "--dry-run"], cap);
  assert.equal(code, 2, "a fixture colliding with the injected skill/ must be structural");
  assert.match(cap.text(), /"fx"/);
  assert.match(cap.text(), /skill/);
  assert.equal(existsSync(join(dir, "results")), false);
});

test("SKILLDIR: a nested CLAUDE.md inside skill_dir is a structural failure, not just a top-level one", async () => {
  const dir = makeSuite({ tasks: ALL });
  useSkillDir(dir, {
    "SKILL.md": "# demo skill",
    "references/foo.md": "ordinary reference content",
  });
  mkdirSync(join(dir, "skill", "nested"), { recursive: true });
  writeFileSync(join(dir, "skill", "nested", "CLAUDE.md"), "# a nested project doc");
  useStub(dir, { default: { outs: ["a plain reply"] } });

  const cap = capture();
  const code = await main([dir, "--dry-run"], cap);
  assert.equal(code, 2, "a nested CLAUDE.md inside skill_dir must be structural");
  assert.match(cap.text(), /CLAUDE\.md/);
  assert.equal(existsSync(join(dir, "results")), false);
});

test("a fixture with a top-level 'skill' entry is fine for a suite with no skill_dir at all", async () => {
  // The collision check exists because treatment copies skill_dir to <sandbox>/skill/ --
  // a suite with no skill_dir (the single-file SKILL.md default) never does that, so a
  // fixture's own "skill" directory or file cannot collide with anything.
  const FIXTURE_TASK = {
    id: "fx", kind: "signal", predict: "helps", prompt: "a task needing a project",
    fixture: "ok-fixture", verify: { type: "any", patterns: ["reply"] },
  };
  const dir = makeSuite({ tasks: [FIXTURE_TASK, HARM] });
  mkdirSync(join(dir, "ok-fixture", "skill"), { recursive: true });
  writeFileSync(join(dir, "ok-fixture", "README.md"), "a fixture project");
  useStub(dir, { default: { outs: ["a plain reply"] } });

  const cap = capture();
  const code = await main([dir, "--dry-run"], cap);
  assert.equal(code, 0, "no skill_dir means no collision is possible");
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

// Audit gap: a paid canary pass used to leave behind only a count. Which checks the
// judge got wrong -- the only thing that says whether it erred strict or lenient, and
// on which rubric -- was computed and then thrown away. And a run answered through
// NULLBENCH_CLAUDE_BIN recorded only the registered model names.
test("CANARY DETAIL: misgraded canaries and the backend are named in records.json, report and ledger", async () => {
  const dir = makeSuite({ tasks: [JUDGE, HARM] });
  writeFileSync(join(dir, "canaries.json"), JSON.stringify({
    jsig: [
      { label: "good", expect: "PASS", reply: "x" },
      { label: "bad", expect: "FAIL", reply: "y" },
    ],
  }));
  useStub(dir, {
    rules: [{ promptIncludes: "RUBRIC TEXT", arm: "any", outs: ["VERDICT: PASS\nREASON: looks fine to me"] }],
    default: { outs: ["a healthy subject reply"] },
  });
  const cap = capture();
  const code = await main([dir, "--yes"], cap);
  assert.equal(code, 0);
  const [stampDir] = readdirSync(join(dir, "results"));
  const rec = JSON.parse(readFileSync(join(dir, "results", stampDir, "records.json"), "utf8"));
  assert.deepEqual(rec.canary.misgrades.map((m) => [m.id, m.expected, m.got]), [["jsig:bad", "FAIL", "PASS"]]);
  assert.equal(rec.requested.backend, "stub-claude.mjs", "recorded by basename, not the operator's full path");
  assert.match(cap.text(), /misgraded `jsig:bad`: expected FAIL, judge said PASS/);
  assert.match(cap.text(), /backend `[^`]*stub-claude\.mjs`/);
  assert.match(ledger(dir), /canary misgraded: jsig:bad \(expected FAIL, judge said PASS\)/);
  assert.match(ledger(dir), /backend=\S*stub-claude\.mjs/);
});

test("PREFLIGHT: a v1 registration with canaries says H does not cover them; h_version 2 does not", async () => {
  const dir = makeSuite({ tasks: [JUDGE, HARM] });
  writeFileSync(join(dir, "canaries.json"), JSON.stringify({ jsig: [{ label: "a", expect: "PASS", reply: "x" }] }));
  const cap1 = capture();
  assert.equal(await main([dir, "--dry-run"], cap1), 0);
  assert.match(cap1.text(), /H \(v1\) does not cover canaries\.json; set "h_version": 2/);
  const reg = JSON.parse(readFileSync(join(dir, "nullbench.json"), "utf8"));
  reg.h_version = 2;
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify(reg));
  const cap2 = capture();
  assert.equal(await main([dir, "--dry-run"], cap2), 0);
  assert.doesNotMatch(cap2.text(), /does not cover/);
});

test("PREFLIGHT: a canary whose expect is not PASS/FAIL, or whose label spans lines, fails the dry run", async () => {
  for (const bad of [{ label: "a", expect: "maybe", reply: "x" }, { label: "a\nb", expect: "PASS", reply: "x" }]) {
    const dir = makeSuite({ tasks: [JUDGE, HARM] });
    writeFileSync(join(dir, "canaries.json"), JSON.stringify({ jsig: [bad] }));
    const cap = capture();
    assert.equal(await main([dir, "--dry-run"], cap), 2, JSON.stringify(bad));
    assert.match(cap.text(), /"expect" must be PASS or FAIL|"label" must be a non-empty single-line string/);
  }
});
