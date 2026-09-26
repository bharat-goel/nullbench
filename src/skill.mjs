// Resolving the thing under test: either today's single SKILL.md file, or a skill_dir --
// a real Claude Code skill directory whose reference files are loaded on demand rather
// than injected wholesale. Both shapes collapse into one descriptor so prereg.mjs,
// runner.mjs and cli.mjs don't need to branch on which one they were handed.

import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJSON } from "./canonical.mjs";
import { RegistrationError } from "./errors.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// True when `child` is `ancestor` itself or nested anywhere inside it, computed by
// resolved path rather than string prefix (so "/a/b" is not mistaken for inside "/a/bc").
function isInside(ancestor, child) {
  const rel = relative(resolve(ancestor), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// skill_dir is a string typed straight into nullbench.json, and every one of these is a
// way to point the treatment arm's sandbox copy at something other than a clean
// subdirectory of the suite. Each gets its own check and its own message -- a suite
// author fixing one must not have to guess which of five things was actually wrong.
function validateSkillDirPath(dir, skillDir, protectedPaths) {
  if (isAbsolute(skillDir)) {
    throw new RegistrationError([`"skill_dir" must be a relative path, got an absolute one: "${skillDir}"`]);
  }
  if (skillDir.split(/[\\/]+/).includes("..")) {
    throw new RegistrationError([`"skill_dir" must not contain ".." segments: "${skillDir}"`]);
  }
  if (skillDir === "." || skillDir === "") {
    throw new RegistrationError([`"skill_dir" must not be "." -- it must name a subdirectory, not the suite directory itself`]);
  }
  const root = resolve(join(dir, skillDir));
  const suiteDir = resolve(dir);
  const rel = relative(suiteDir, root);
  // Catches what the segment checks above don't: a spelling like "sub/.." that resolves
  // right back to the suite directory, or (belt and braces) any other escape the string
  // checks missed.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new RegistrationError([`"skill_dir" must resolve to a strict subdirectory of the registration directory, got "${skillDir}"`]);
  }
  // A skill_dir that contains the registration file, the canary bank, a task file, or a
  // declared fixture would copy that content straight into the treatment sandbox as
  // part of "the skill" -- rubrics, verifier patterns and known-PASS canary replies are
  // exactly what PATTERN_IN_SKILL and the leakage scan exist to keep out of there.
  for (const p of protectedPaths) {
    if (isInside(root, p)) {
      throw new RegistrationError([`"skill_dir" ("${skillDir}") must not contain ${relative(suiteDir, p).split(sep).join("/")}`]);
    }
  }
}

// Recursively lists every FILE under root as POSIX-relative paths (joined with "/"
// regardless of platform, since these paths are hashed and must not vary by OS). A
// symlink anywhere in the tree -- file or directory -- is refused outright rather than
// followed: it can point outside skill_dir entirely, so a manifest hash over it would
// not name what actually gets copied into the sandbox. Structural, like a missing task
// file: exit 2, nothing spent.
function walkSkillDir(root, rel = "") {
  const abs = join(root, rel);
  let out = [];
  for (const name of readdirSync(abs).sort()) {
    const childRel = rel ? `${rel}/${name}` : name;
    const childAbs = join(abs, name);
    const st = lstatSync(childAbs);
    if (st.isSymbolicLink()) {
      throw new RegistrationError([`skill_dir contains a symlink at "${childRel}"; refused as a structural failure`]);
    }
    if (st.isDirectory()) out = out.concat(walkSkillDir(root, childRel));
    else out.push(childRel);
  }
  return out;
}

// `override` (an absolute --skill path) always wins and is always a single file --
// nothing in the brief asks --skill to accept a directory, and keeping it file-only
// keeps the existing SKILL-OVERRIDE behaviour byte-identical. Otherwise `skillDir`
// (nullbench.json's raw.skill_dir, relative to the registration directory) resolves to
// a directory; absent either, fall back to today's single SKILL.md beside the
// registration.
export function resolveSkill(dir, { override = null, skillDir = null, protectedPaths = [] } = {}) {
  if (override) return { kind: "file", mdFile: override };
  if (skillDir != null) {
    validateSkillDirPath(dir, skillDir, protectedPaths);
    const root = resolve(join(dir, skillDir));
    return { kind: "dir", root, mdFile: join(root, "SKILL.md") };
  }
  return { kind: "file", mdFile: join(dir, "SKILL.md") };
}

// H must cover every byte the treatment arm actually sees. A single file hashes
// directly -- unchanged from before skill_dir existed, so an absent-skill_dir
// registration's H does not move. A directory hashes a sorted manifest of
// {path, sha256} over every file in it, so editing any reference file -- not only
// SKILL.md -- moves H; a byte-identical rewrite (a no-op reformat that changes nothing)
// does not, since the manifest is over bytes. Absent entirely hashes to null rather
// than throwing: a missing skill is the CLI's own existence check to report, not this
// function's job. `skill.files` is cached on the descriptor (relative paths) so
// pattern-drift and leakage don't have to re-walk the directory.
export function hashSkill(skill) {
  try {
    if (skill.kind === "dir") {
      const files = walkSkillDir(skill.root);
      const manifest = files.map((p) => ({ path: p, sha256: sha256(readFileSync(join(skill.root, p))) }));
      skill.files = files;
      return sha256(Buffer.from(canonicalJSON(manifest), "utf8"));
    }
    return sha256(readFileSync(skill.mdFile));
  } catch (e) {
    if (e instanceof RegistrationError) throw e;
    return null; // absent or unreadable
  }
}

// Every text file the treatment arm can actually see: just SKILL.md for a single file,
// every file under skill_dir for a directory -- an answer key can sit in a reference
// file as easily as in SKILL.md. Requires hashSkill to have run first for a directory
// skill (it populates skill.files); falls back to just mdFile if it hasn't, which is
// only ever wrong for a directory skill whose files were never walked -- not a path any
// caller takes, since loadRegistration always hashes before this is used. Unreadable or
// undecodable entries are skipped silently: this is a cross-check, not a correctness
// gate.
export function combinedSkillText(skill) {
  const paths = skill.kind === "dir" && skill.files
    ? skill.files.map((p) => join(skill.root, p))
    : [skill.mdFile];
  let out = "";
  for (const p of paths) {
    // mdFile itself is let through unguarded -- an unreadable SKILL.md (a directory, in
    // one existing regression test) is a real problem the CLI's callers decide how to
    // handle, exactly as before skill_dir existed. Only the EXTRA files a directory
    // skill contributes are tolerated: a reference file can be binary or otherwise
    // undecodable without that being this cross-check's problem.
    if (p === skill.mdFile) {
      out += "\n" + readFileSync(p, "utf8");
    } else {
      try { out += "\n" + readFileSync(p, "utf8"); } catch { /* unreadable or binary, skip */ }
    }
  }
  return out;
}
