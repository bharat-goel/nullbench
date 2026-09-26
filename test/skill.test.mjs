import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("hashSkill caches the file list on the descriptor for reuse", () => {
  const dir = tmp();
  makeSkillDir(dir);
  const skill = resolveSkill(dir, { skillDir: "skill" });
  hashSkill(skill);
  assert.deepEqual(skill.files.sort(), ["SKILL.md", "references/foo.md"]);
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

test("combinedSkillText skips unreadable entries rather than throwing", () => {
  const dir = tmp();
  const skill = resolveSkill(dir, {}); // no SKILL.md at all
  assert.equal(combinedSkillText(skill), "");
  rmSync(dir, { recursive: true, force: true });
});
