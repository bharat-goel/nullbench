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

test("the file filter rejects .bak backups of control files", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-scan-"));
  // Create a real control file and a backup
  writeFileSync(join(dir, "t__control__1.txt"), "perverse incentive");
  writeFileSync(join(dir, "t__control__1.txt.bak"), "perverse incentive backup");
  const r = scanControlLeakage({ rawDir: dir, terms: ["perverse incentive"] });
  // Should count only the .txt file, not the .bak
  assert.equal(r.checked, 1, "backup file must not be scanned");
  assert.equal(r.hits, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("the file filter correctly distinguishes control from treatment in task ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-scan-"));
  // A task whose id contains __control__ substring
  // This would produce: sig__control__treatment__1.txt
  // The old filter would match this as a control file; it must not.
  writeFileSync(join(dir, "sig__control__treatment__1.txt"), "perverse incentive");
  writeFileSync(join(dir, "sig__control__control__1.txt"), "perverse incentive");
  const r = scanControlLeakage({ rawDir: dir, terms: ["perverse incentive"] });
  // Only sig__control__control__1.txt matches __control__<digit>.txt pattern
  assert.equal(r.checked, 1, "treatment file must not be counted as control");
  assert.equal(r.hits, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("distinctiveTerms handles documents that open with a horizontal rule", () => {
  // A document that starts with ---, has body content, then another --- later
  // The old regex would strip from first --- to the second ---, losing the first section
  const skill = `---
A horizontal rule, not YAML frontmatter.

This section contains perverse incentive language that should be extracted.

---

And this is after another separator.`;
  const terms = distinctiveTerms(skill);
  // "perverse incentive" should appear in terms since the first section wasn't stripped
  assert.ok(terms.some((t) => t.includes("perverse incentive")),
    "terms from first section must not be lost to false frontmatter stripping");
});

test("distinctiveTerms correctly strips actual YAML frontmatter", () => {
  // Well-formed frontmatter: first line is ---, body, then closing ---
  const skill = `---
title: cobra
description: measure rewards
---

Ask what the measure actually rewards. Watch for perverse incentive.`;
  const terms = distinctiveTerms(skill);
  // Frontmatter words like "title" and "description" should not be extracted
  assert.ok(!terms.includes("title"), "frontmatter field names must not become terms");
  assert.ok(!terms.includes("description"));
  // Body content should still be there
  assert.ok(terms.some((t) => t.includes("perverse incentive")),
    "body content must be extracted after frontmatter removal");
});
