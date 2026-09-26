import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { resolveSkill, hashSkill, combinedSkillText } from "../src/skill.mjs";
import { RegistrationError } from "../src/errors.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "nb-skill-"));
}

test("resolveSkill falls back to <dir>/SKILL.md when nothing else is given", () => {
  const dir = tmp();
  const skill = resolveSkill(dir, {});
  assert.equal(skill.kind, "file");
  assert.equal(skill.mdFile, join(dir, "SKILL.md"));
  rmSync(dir, { recursive: true, force: true });
});

test("resolveSkill prefers an explicit override over skill_dir", () => {
  const dir = tmp();
  const skill = resolveSkill(dir, { override: "/elsewhere/SKILL.md", skillDir: "skill" });
  assert.equal(skill.kind, "file");
  assert.equal(skill.mdFile, "/elsewhere/SKILL.md");
  rmSync(dir, { recursive: true, force: true });
});

test("resolveSkill treats skill_dir as a directory containing SKILL.md", () => {
  const dir = tmp();
  const skill = resolveSkill(dir, { skillDir: "skill" });
  assert.equal(skill.kind, "dir");
  assert.equal(skill.root, join(dir, "skill"));
  assert.equal(skill.mdFile, join(dir, "skill", "SKILL.md"));
  rmSync(dir, { recursive: true, force: true });
});

// skill_dir path rules: each is its own structural failure, tested individually so a
// fix for one can't silently regress another.

test("resolveSkill refuses an absolute skill_dir", () => {
  const dir = tmp();
  assert.throws(() => resolveSkill(dir, { skillDir: "/etc/skill" }), (e) => {
    assert.ok(e instanceof RegistrationError);
    assert.match(e.message, /absolute/);
    return true;
  });
  rmSync(dir, { recursive: true, force: true });
});

test('resolveSkill refuses a skill_dir containing ".."', () => {
  const dir = tmp();
  assert.throws(() => resolveSkill(dir, { skillDir: "../elsewhere" }), (e) => {
    assert.ok(e instanceof RegistrationError);
    assert.match(e.message, /\.\./);
    return true;
  });
  rmSync(dir, { recursive: true, force: true });
});

test('resolveSkill refuses skill_dir "."', () => {
  const dir = tmp();
  assert.throws(() => resolveSkill(dir, { skillDir: "." }), (e) => {
    assert.ok(e instanceof RegistrationError);
    assert.match(e.message, /"\."/);
    return true;
  });
  rmSync(dir, { recursive: true, force: true });
});

test("resolveSkill refuses a skill_dir that resolves to the suite directory itself", () => {
  const dir = tmp();
  mkdirSync(join(dir, "sub"));
  // "sub/.." resolves right back to `dir` -- not caught by the "." or ".." segment
  // checks alone, since neither literal appears as a bare match against those, so this
  // needs the resolved-path check too.
  assert.throws(() => resolveSkill(dir, { skillDir: "sub/.." }), (e) => {
    assert.ok(e instanceof RegistrationError);
    return true;
  });
  rmSync(dir, { recursive: true, force: true });
});

test("resolveSkill requires skill_dir to be a strict subdirectory of the suite", () => {
  const dir = tmp();
  const sibling = tmp();
  // A relative path that, joined with dir, escapes dir entirely -- e.g. dir is
  // /tmp/nb-skill-A and skillDir is "../nb-skill-B/skill", both segments containing
  // ".." so the segment check alone already catches most of this, but the resolved
  // check is the one that must hold regardless of how the escape is spelled.
  const rel = join("..", basename(sibling), "skill");
  assert.throws(() => resolveSkill(dir, { skillDir: rel }), RegistrationError);
  rmSync(dir, { recursive: true, force: true });
  rmSync(sibling, { recursive: true, force: true });
});

test("resolveSkill refuses skill_dir overlapping a protected path (nullbench.json, canaries.json, a task file, a fixture)", () => {
  const dir = tmp();
  // Each case: skillDir is a plausible-looking strict subdirectory that happens to
  // contain one of the four protected paths nested inside it -- the realistic way a
  // careless skill_dir choice (or a coincidentally named directory) would leak a
  // rubric, a canary bank, or a fixture into the treatment sandbox.
  assert.throws(
    () => resolveSkill(dir, { skillDir: "sub", protectedPaths: [join(dir, "sub", "nullbench.json")] }),
    RegistrationError, "must refuse when nullbench.json sits inside skill_dir");
  assert.throws(
    () => resolveSkill(dir, { skillDir: "sub", protectedPaths: [join(dir, "sub", "canaries.json")] }),
    RegistrationError, "must refuse when canaries.json sits inside skill_dir");
  assert.throws(
    () => resolveSkill(dir, { skillDir: "wrapper", protectedPaths: [join(dir, "wrapper", "tasks", "sig.json")] }),
    RegistrationError, "must refuse when a task file sits inside skill_dir");
  assert.throws(
    () => resolveSkill(dir, { skillDir: "wrapper2", protectedPaths: [join(dir, "wrapper2", "some-fixture")] }),
    RegistrationError, "must refuse when a declared fixture sits inside skill_dir");
  rmSync(dir, { recursive: true, force: true });
});

// N1 (fix round 2): the overlap check compared resolved path STRINGS, not real-path
// identity. On a case-insensitive filesystem (default macOS/APFS), "skill_dir": "Tasks"
// is a different STRING than "tasks/sig.json"'s parent, so string comparison waves it
// through -- but it is the SAME directory on disk, and every task file (a rubric, a
// verifier pattern) would be copied into the treatment sandbox as part of "the skill".
// Skipped, not failed, on a filesystem where this genuinely doesn't apply (case-sensitive
// Linux, say) -- creating "Tasks" there makes a real, unrelated, empty directory, and
// the scenario this test pins simply does not exist.
test("resolveSkill refuses a case-variant of a protected path via real-path identity, not string comparison", (t) => {
  const dir = tmp();
  mkdirSync(join(dir, "tasks"));
  writeFileSync(join(dir, "tasks", "sig.json"), "{}");
  const caseInsensitive = existsSync(join(dir, "Tasks", "sig.json"));
  if (!caseInsensitive) {
    t.skip("filesystem is case-sensitive; the case-variant bypass this test pins does not apply here");
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const protectedPaths = [join(dir, "tasks", "sig.json")];
  assert.throws(() => resolveSkill(dir, { skillDir: "Tasks", protectedPaths }), RegistrationError);
  rmSync(dir, { recursive: true, force: true });
});

test("resolveSkill accepts a clean strict-subdirectory skill_dir with no overlap", () => {
  const dir = tmp();
  const protectedPaths = [join(dir, "nullbench.json"), join(dir, "tasks", "sig.json")];
  const skill = resolveSkill(dir, { skillDir: "skill", protectedPaths });
  assert.equal(skill.kind, "dir");
  rmSync(dir, { recursive: true, force: true });
});

test("hashSkill returns null for a missing file, not a throw", () => {
  const dir = tmp();
  const skill = resolveSkill(dir, {});
  assert.equal(hashSkill(skill), null);
  rmSync(dir, { recursive: true, force: true });
});

test("hashSkill hashes a single file's bytes directly (unchanged shape)", () => {
  const dir = tmp();
  writeFileSync(join(dir, "SKILL.md"), "# one\n");
  const skill = resolveSkill(dir, {});
  const a = hashSkill(skill);
  writeFileSync(join(dir, "SKILL.md"), "# two\n");
  const skill2 = resolveSkill(dir, {});
  const b = hashSkill(skill2);
  assert.notEqual(a, b);
  rmSync(dir, { recursive: true, force: true });
});

function makeSkillDir(dir) {
  mkdirSync(join(dir, "skill"));
  writeFileSync(join(dir, "skill", "SKILL.md"), "# demo\nsee references/foo.md");
  mkdirSync(join(dir, "skill", "references"));
  writeFileSync(join(dir, "skill", "references", "foo.md"), "reference content");
}

test("hashSkill over a directory changes when a reference file changes, not just SKILL.md", () => {
  const dir = tmp();
  makeSkillDir(dir);
  const skill = resolveSkill(dir, { skillDir: "skill" });
  const before = hashSkill(skill);

  writeFileSync(join(dir, "skill", "references", "foo.md"), "changed reference content");
  const skill2 = resolveSkill(dir, { skillDir: "skill" });
  const after = hashSkill(skill2);

  assert.notEqual(before, after, "editing a reference file must move H");
  rmSync(dir, { recursive: true, force: true });
});

test("hashSkill is stable when a file is rewritten with byte-identical content", () => {
  const dir = tmp();
  makeSkillDir(dir);
  const skill = resolveSkill(dir, { skillDir: "skill" });
  const before = hashSkill(skill);

  // Rewrite with the exact same bytes -- a no-op from the manifest's point of view,
  // since the manifest hashes bytes, not mtimes or a formatter's opinion.
  writeFileSync(join(dir, "skill", "references", "foo.md"), "reference content");
  const skill2 = resolveSkill(dir, { skillDir: "skill" });
  const after = hashSkill(skill2);

  assert.equal(before, after);
  rmSync(dir, { recursive: true, force: true });
});

// Proven in the review: walking depth-first with a per-directory sort is NOT the same
// as sorting the full path list -- "a/x" and "a-b" walk in the order [a/x, a-b] (since
// "a" the directory and "a-b" the file are compared as SIBLING NAMES at the top level,
// where "a" < "a-b" puts the directory first and its contents get walked into before
// "a-b" is ever reached), but PROTOCOL §3 promises a manifest sorted by full path, where
// "a-b" < "a/x" (as plain strings, "-" is code point 45 and "/" is 47, so "a-" sorts
// before "a/"). Anyone recomputing H from the spec would get a different value unless
// the implementation actually sorts by path after the walk, not merely within it.
test("hashSkill's manifest is sorted by full path, not by per-directory walk order", () => {
  const dir = tmp();
  mkdirSync(join(dir, "skill"));
  writeFileSync(join(dir, "skill", "SKILL.md"), "# demo");
  mkdirSync(join(dir, "skill", "a"));
  writeFileSync(join(dir, "skill", "a", "x"), "inside a/");
  writeFileSync(join(dir, "skill", "a-b"), "a sibling file, not inside a/");
  const skill = resolveSkill(dir, { skillDir: "skill" });
  hashSkill(skill);
  assert.deepEqual(skill.files, ["SKILL.md", "a-b", "a/x"],
    "files must be sorted by full path (a-b before a/x, code unit 45 < 47), not walk order");
  rmSync(dir, { recursive: true, force: true });
});

test("hashSkill caches the file list on the descriptor for reuse", () => {
  const dir = tmp();
  makeSkillDir(dir);
  const skill = resolveSkill(dir, { skillDir: "skill" });
  hashSkill(skill);
  assert.deepEqual(skill.files.sort(), ["SKILL.md", "references/foo.md"]);
  rmSync(dir, { recursive: true, force: true });
});

test("hashSkill refuses a symlinked skill_dir root, not just a symlink somewhere inside it", () => {
  // cpSync copies a symlinked root AS a symlink, so <sandbox>/skill would point at the
  // original directory outside the sandbox -- the walk previously lstat'd only the
  // CHILDREN it iterated over, never the root passed in, so this slipped through.
  const dir = tmp();
  makeSkillDir(dir);
  rmSync(join(dir, "skill"), { recursive: true, force: true });
  mkdirSync(join(dir, "real-skill"));
  writeFileSync(join(dir, "real-skill", "SKILL.md"), "# demo");
  symlinkSync(join(dir, "real-skill"), join(dir, "skill"));
  const skill = resolveSkill(dir, { skillDir: "skill" });
  assert.throws(() => hashSkill(skill), (e) => {
    assert.ok(e instanceof RegistrationError);
    assert.match(e.message, /symlink/);
    return true;
  });
  rmSync(dir, { recursive: true, force: true });
});

test("hashSkill throws (never returns null) on a read error inside an existing skill_dir", () => {
  const dir = tmp();
  makeSkillDir(dir);
  chmodSync(join(dir, "skill", "references", "foo.md"), 0o000);
  const skill = resolveSkill(dir, { skillDir: "skill" });
  try {
    assert.throws(() => hashSkill(skill), RegistrationError,
      "an unreadable file inside an existing skill_dir must never silently hash to null");
  } finally {
    chmodSync(join(dir, "skill", "references", "foo.md"), 0o644); // so rmSync can clean up
  }
  rmSync(dir, { recursive: true, force: true });
});

test("hashSkill refuses a non-regular entry (FIFO) anywhere in skill_dir", { skip: process.platform === "win32" }, () => {
  const dir = tmp();
  makeSkillDir(dir);
  execFileSync("mkfifo", [join(dir, "skill", "references", "a-fifo")]);
  const skill = resolveSkill(dir, { skillDir: "skill" });
  assert.throws(() => hashSkill(skill), (e) => {
    assert.ok(e instanceof RegistrationError);
    assert.match(e.message, /a-fifo/);
    return true;
  });
  rmSync(dir, { recursive: true, force: true });
});

test("hashSkill returns null (not a throw) when skill_dir's root does not exist at all", () => {
  const dir = tmp();
  const skill = resolveSkill(dir, { skillDir: "no-such-dir" });
  assert.equal(hashSkill(skill), null);
  rmSync(dir, { recursive: true, force: true });
});

test("hashSkill refuses a symlink anywhere in skill_dir as a structural failure", () => {
  const dir = tmp();
  makeSkillDir(dir);
  writeFileSync(join(dir, "elsewhere.md"), "outside the skill directory");
  symlinkSync(join(dir, "elsewhere.md"), join(dir, "skill", "references", "linked.md"));
  const skill = resolveSkill(dir, { skillDir: "skill" });
  assert.throws(() => hashSkill(skill), (e) => {
    assert.ok(e instanceof RegistrationError);
    assert.match(e.message, /symlink/);
    assert.match(e.message, /linked\.md/);
    return true;
  });
  rmSync(dir, { recursive: true, force: true });
});

test("combinedSkillText concatenates every file's text for a directory skill", () => {
  const dir = tmp();
  makeSkillDir(dir);
  const skill = resolveSkill(dir, { skillDir: "skill" });
  hashSkill(skill);
  const text = combinedSkillText(skill);
  assert.match(text, /demo/);
  assert.match(text, /reference content/);
  rmSync(dir, { recursive: true, force: true });
});

test("combinedSkillText is just SKILL.md's text for a single-file skill", () => {
  const dir = tmp();
  writeFileSync(join(dir, "SKILL.md"), "# one\nunique-marker-xyz");
  const skill = resolveSkill(dir, {});
  const text = combinedSkillText(skill);
  assert.match(text, /unique-marker-xyz/);
  rmSync(dir, { recursive: true, force: true });
});

// combinedSkillText is only ever called after the CLI's own existsSync(mdFile) check
// has passed, so "mdFile is entirely missing" is not a realistic input -- what actually
// happens on a real suite is one BAD reference file among otherwise-good ones (binary,
// permissions, whatever), and that must not sink the whole cross-check.
test("combinedSkillText skips an unreadable reference file but keeps SKILL.md's own text", () => {
  const dir = tmp();
  makeSkillDir(dir);
  writeFileSync(join(dir, "skill", "references", "foo.md"), "reference content");
  const skill = resolveSkill(dir, { skillDir: "skill" });
  hashSkill(skill);
  // Replace one already-hashed reference file with a directory -- unreadable as text,
  // same shape as the EISDIR case below, but on a file combinedSkillText must tolerate.
  rmSync(join(dir, "skill", "references", "foo.md"));
  mkdirSync(join(dir, "skill", "references", "foo.md"));
  const text = combinedSkillText(skill);
  assert.match(text, /demo/, "SKILL.md's own text must still come through");
  rmSync(dir, { recursive: true, force: true });
});

// Regression guard: test/cli.test.mjs pins an EISDIR from an unreadable SKILL.md
// surfacing as a crash at the reporting stage. combinedSkillText must not quietly
// absorb that -- only the EXTRA files a directory skill contributes are tolerated.
test("combinedSkillText lets an unreadable mdFile throw, unlike a reference file", () => {
  const dir = tmp();
  mkdirSync(join(dir, "SKILL.md")); // a directory where a file belongs
  const skill = resolveSkill(dir, {});
  assert.throws(() => combinedSkillText(skill), /EISDIR/);
  rmSync(dir, { recursive: true, force: true });
});
