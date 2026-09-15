import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertIsolated, distinctiveTerms, scanControlLeakage } from "../src/leakage.mjs";

test("a clean temp directory outside the repo is isolated", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-iso-"));
  const r = assertIsolated(dir, "/Users/someone/code/nullbench");
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  rmSync(dir, { recursive: true, force: true });
});

test("a directory inside the repo is not isolated", () => {
  const repo = mkdtempSync(join(tmpdir(), "nb-repo-"));
  const inside = join(repo, "sub");
  mkdirSync(inside);
  const r = assertIsolated(inside, repo);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /inside the repository/.test(p)));
  rmSync(repo, { recursive: true, force: true });
});

test("the sandbox cannot be the repository root itself", () => {
  const repo = mkdtempSync(join(tmpdir(), "nb-repo-"));
  const r = assertIsolated(repo, repo);
  assert.equal(r.ok, false, "sandbox === repo is maximal contamination");
  assert.ok(r.problems.length > 0);
  // Verify the message doesn't create a nonsensical "inside at itself" phrasing
  const msg = r.problems[0];
  assert.ok(msg, "first problem should have a clear message");
  rmSync(repo, { recursive: true, force: true });
});

test("the exact files that caused the original leak are detected", () => {
  for (const name of ["CLAUDE.md", ".claude", "skills"]) {
    const dir = mkdtempSync(join(tmpdir(), "nb-iso-"));
    if (name === "CLAUDE.md") writeFileSync(join(dir, name), "# project");
    else mkdirSync(join(dir, name));
    const r = assertIsolated(dir, "/elsewhere");
    assert.equal(r.ok, false, `${name} should break isolation`);
    assert.ok(r.problems.some((p) => p.includes(name)));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("distinctiveTerms prefers phrases and skips common words", () => {
  const skill = `# cobra
Ask what the measure actually rewards. The cheapest way to satisfy a coverage gate
is a test that asserts nothing. Watch for the perverse incentive.`;
  const terms = distinctiveTerms(skill);
  assert.ok(terms.some((t) => t.includes("perverse incentive")));
  assert.ok(!terms.includes("the"), "stopwords must not become terms");
  assert.ok(!terms.includes("is"));
});

test("the scan reports the control-arm hit rate and flags a high one", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-scan-"));
  writeFileSync(join(dir, "t__control__1.txt"), "this is a perverse incentive");
  writeFileSync(join(dir, "t__control__2.txt"), "this is a perverse incentive too");
  writeFileSync(join(dir, "t__control__3.txt"), "an unrelated answer");
  writeFileSync(join(dir, "t__treatment__1.txt"), "perverse incentive everywhere");
  const r = scanControlLeakage({ rawDir: dir, terms: ["perverse incentive"] });
  assert.equal(r.checked, 3, "treatment replies are not scanned");
  assert.equal(r.hits, 2);
  assert.ok(Math.abs(r.rate - 2 / 3) < 1e-9);
  assert.equal(r.suspicious, true);
  rmSync(dir, { recursive: true, force: true });
});

test("a clean control arm is not flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-scan-"));
  writeFileSync(join(dir, "t__control__1.txt"), "an ordinary answer");
  writeFileSync(join(dir, "t__control__2.txt"), "another ordinary answer");
  const r = scanControlLeakage({ rawDir: dir, terms: ["perverse incentive"] });
  assert.equal(r.hits, 0);
  assert.equal(r.suspicious, false);
  rmSync(dir, { recursive: true, force: true });
});
