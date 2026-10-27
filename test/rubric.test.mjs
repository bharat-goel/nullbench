import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rubricTerms, rubricVocabulary } from "../src/rubric.mjs";

// FAILURES.md entry 1 one level up: a judge rubric that passes a reply only when it names
// a file, script or API the skill teaches. The control arm has never seen the name and
// cannot say it; the treatment arm reads it off its system prompt. In skill-audit's
// uap-release-analyzer run, 29 of 34 extra treatment passes came from three rubrics of
// exactly this shape, and PATTERN_IN_SKILL saw none of them, because every task was
// judge-graded.

test("rubricTerms picks out file names, paths, code identifiers and backticked spans", () => {
  const terms = rubricTerms(
    "PASS if the reply says to run scripts/run_all.py, then open REPORT.md, and adds the prefix " +
    "to `agency vocab` rather than PREFIX_RULES in extract_text. It imports ProgressBar from " +
    "@acme/ui-web/visualizations, sets paddingX, calls log.StringValue, and posts to /v1/traces.");
  for (const t of ["scripts/run_all.py", "REPORT.md", "agency vocab", "PREFIX_RULES", "extract_text",
    "ProgressBar", "@acme/ui-web/visualizations", "paddingX", "log.StringValue", "/v1/traces"]) {
    assert.ok(terms.includes(t), `expected "${t}" in ${JSON.stringify(terms)}`);
  }
});

test("rubricTerms ignores prose, including slash-joined words that are not paths", () => {
  const terms = rubricTerms(
    "PASS if the reply is concrete, e.g. names a next step. FAIL on hex/rgb colours, and/or a " +
    "vague API/SDK answer, or a code/configuration dump. Banner and Spinner are fine words.");
  assert.deepEqual(terms, []);
});

const judge = (id, prompt, rubric, extra = {}) =>
  ({ id, kind: "signal", spec: { prompt, verify: { type: "judge", rubric }, ...extra } });

test("a rubric term found in the skill and nowhere the control arm can see is flagged, task and term named", () => {
  const out = rubricVocabulary(
    [judge("boot", "How do I get from a fresh download to a report?", "PASS if it says to run scripts/run_all.py.")],
    "# skill\nRun scripts/run_all.py <release root>.");
  assert.equal(out.length, 1);
  assert.equal(out[0].code, "RUBRIC_TERM_IN_SKILL");
  assert.match(out[0].detail, /task "boot"/);
  assert.match(out[0].detail, /scripts\/run_all\.py/);
  assert.match(out[0].detail, /SKILL\.md/);
});

test("a term the prompt already gives both arms is not flagged", () => {
  const out = rubricVocabulary(
    [judge("t", "Should I migrate log.StringValue?", "PASS if it replaces log.StringValue.")],
    "log.StringValue is deprecated");
  assert.deepEqual(out, []);
});

test("a term the fixture already gives both arms is not flagged; one only the skill holds still is", () => {
  const root = mkdtempSync(join(tmpdir(), "nb-rubric-"));
  try {
    mkdirSync(join(root, "app", "src"), { recursive: true });
    writeFileSync(join(root, "app", "src", "notes.md"), "We call otlptracehttp.WithEndpointURL today.");
    const out = rubricVocabulary(
      [judge("t", "Review the upgrade.", "PASS if it fixes otlptracehttp.WithEndpointURL and uses attribute.KeyValue.",
        { fixture: "app" })],
      "Use attribute.KeyValue; otlptracehttp.WithEndpointURL is pathless.", { fixtureRoot: root });
    assert.equal(out.length, 1);
    assert.match(out[0].detail, /attribute\.KeyValue/);
    assert.doesNotMatch(out[0].detail, /WithEndpointURL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harm tasks and non-judge tasks are not checked", () => {
  // A harm rubric may need the skill's words to assert they stay out; a pattern
  // verifier is PATTERN_IN_SKILL's job, not this one's.
  const out = rubricVocabulary([
    { ...judge("h", "unrelated", "FAIL if it mentions run_all.py."), kind: "harm" },
    { id: "p", kind: "signal", spec: { prompt: "x", verify: { type: "any", patterns: ["run_all.py"] } } },
  ], "run run_all.py");
  assert.deepEqual(out, []);
});

test("a term contained in a longer flagged term is reported once, as the longer one", () => {
  const out = rubricVocabulary(
    [judge("t", "q", "PASS if it runs run_all.py (run_all for short).")], "run_all.py");
  assert.match(out[0].detail, /run_all\.py/);
  assert.doesNotMatch(out[0].detail, /run_all[^.]/);
});

test("the source label names what was scanned", () => {
  const out = rubricVocabulary([judge("t", "q", "PASS if it opens REPORT.md.")], "REPORT.md", { sourceLabel: "skill_dir" });
  assert.match(out[0].detail, /skill_dir/);
});
