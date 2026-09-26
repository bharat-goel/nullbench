// Resolving the thing under test: either today's single SKILL.md file, or a skill_dir --
// a real Claude Code skill directory whose reference files are loaded on demand rather
// than injected wholesale. Both shapes collapse into one descriptor so prereg.mjs,
// runner.mjs and cli.mjs don't need to branch on which one they were handed.

import { readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJSON } from "./canonical.mjs";
import { RegistrationError } from "./errors.mjs";
import { FORBIDDEN } from "./leakage.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const FORBIDDEN_NAMES = new Set(FORBIDDEN);

// Resolves every symlink AND canonicalizes case (on a case-insensitive filesystem, the
// on-disk casing wins over whatever casing the caller typed) for the longest existing
// prefix of `p`, then rejoins whatever doesn't exist yet lexically. A path that doesn't
// exist at all can't alias anything real by definition, so there's nothing further to
// resolve for the non-existent tail -- this only has to get the EXISTING part right.
function realpathOrSelf(p) {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p; // filesystem root; nothing left to walk up to
    return join(realpathOrSelf(parent), basename(p));
  }
}

// True when `child` is `ancestor` itself or nested anywhere inside it. Compared by REAL
// path, not resolved-string: `resolve()`/`relative()` alone are lexical and never touch
// the filesystem, so on a case-insensitive filesystem (default macOS/APFS) a
// differently-cased alias of the same directory -- or a symlink standing in for it --
// would compare as a different path while being the identical thing on disk. Both are
// exactly the case this project can't afford to miss: they'd copy a task file, a
// fixture, or the registration itself into the treatment sandbox while looking, by
// string comparison alone, like a clean, unrelated directory.
function isInside(ancestor, child) {
  const a = realpathOrSelf(resolve(ancestor));
  const c = realpathOrSelf(resolve(child));
  const rel = relative(a, c);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// skill_dir is a string typed straight into nullbench.json, and every one of these is a
// way to point the treatment arm's sandbox copy at something other than a clean
// subdirectory of the suite. Each gets its own check and its own message -- a suite
// author fixing one must not have to guess which of five things was actually wrong.
function validateSkillDirPath(dir, skillDir, protectedPaths, fixtureDirs) {
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
  // Compared by REAL path (resolves symlinks AND on-disk casing), not the lexical
  // string `resolve()`/`relative()` alone would compare -- a case-insensitive
  // filesystem's own alias of the suite directory, or an intermediate symlink standing
  // in for one of skillDir's path components, would otherwise look like a clean strict
  // subdirectory by string comparison while actually landing somewhere else entirely.
  const realRoot = realpathOrSelf(root);
  const realSuite = realpathOrSelf(suiteDir);
  const rel = relative(realSuite, realRoot);
  // Catches what the segment checks above don't: a spelling like "sub/.." that resolves
  // right back to the suite directory, an intermediate symlink that escapes it, or
  // (belt and braces) any other escape the string checks missed.
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
  // A declared fixture is copied into BOTH arms' sandboxes (runner.mjs's makeCwd), not
  // only treatment's. A skill_dir inside, equal to, or containing one would put
  // SKILL.md and every reference file into the control arm too -- FAILURES.md entry 5's
  // control-arm contamination, reached through the fixture path instead of the repo
  // root, and invisible to PATTERN_IN_SKILL on a suite with no pattern-verified task to
  // trip over it. Checked both directions: `protectedPaths` above only ever asked
  // "is X inside skill_dir"; a fixture also has to ask "is skill_dir inside X".
  for (const fx of fixtureDirs) {
    if (isInside(root, fx) || isInside(fx, root)) {
      throw new RegistrationError([`"skill_dir" ("${skillDir}") must not be inside, equal to, or contain the fixture directory "${relative(suiteDir, fx).split(sep).join("/")}"`]);
    }
  }
}

// Recursively lists every FILE under root as POSIX-relative paths (joined with "/"
// regardless of platform, since these paths are hashed and must not vary by OS). Three
// things are refused outright rather than followed or read, each a structural failure
// like a missing task file (exit 2, nothing spent):
//
//   - a symlink anywhere in the tree -- it can point outside skill_dir entirely, so a
//     manifest hash over it would not name what actually gets copied into the sandbox;
//   - anything that is neither a file nor a directory (a FIFO, socket, or device node)
//     -- lstat classifies it WITHOUT opening it, which is what keeps this from ever
//     calling readFileSync on a FIFO with no writer and hanging forever;
//   - CLAUDE.md, AGENTS.md, .claude or skills at ANY depth -- the same names
//     assertIsolated refuses at a sandbox's top level, refused here too because Claude
//     Code itself loads nested CLAUDE.md/.claude when working in a subdirectory, and a
//     skill_dir copy is not inspected for whether its contents are actually dangerous
//     any more than a fixture is (see makeCwd in runner.mjs).
function walkSkillDir(root, rel = "") {
  const abs = join(root, rel);
  let out = [];
  for (const name of readdirSync(abs)) {
    const childRel = rel ? `${rel}/${name}` : name;
    const childAbs = join(abs, name);
    const st = lstatSync(childAbs);
    if (st.isSymbolicLink()) {
      throw new RegistrationError([`skill_dir contains a symlink at "${childRel}"; refused as a structural failure`]);
    }
    if (FORBIDDEN_NAMES.has(name)) {
      throw new RegistrationError([`skill_dir contains "${name}" at "${childRel}"; refused as a structural failure -- it could change how the treatment arm's sandbox behaves beyond the skill itself`]);
    }
    if (st.isDirectory()) {
      out = out.concat(walkSkillDir(root, childRel));
    } else if (st.isFile()) {
      out.push(childRel);
    } else {
      throw new RegistrationError([`skill_dir contains a non-regular entry at "${childRel}" (not a file or directory); refused as a structural failure`]);
    }
  }
  return out;
}

// `override` (an absolute --skill path) always wins and is always a single file --
// nothing in the brief asks --skill to accept a directory, and keeping it file-only
// keeps the existing SKILL-OVERRIDE behaviour byte-identical. Otherwise `skillDir`
// (nullbench.json's raw.skill_dir, relative to the registration directory) resolves to
// a directory; absent either, fall back to today's single SKILL.md beside the
// registration.
export function resolveSkill(dir, { override = null, skillDir = null, protectedPaths = [], fixtureDirs = [] } = {}) {
  if (override) return { kind: "file", mdFile: override };
  if (skillDir != null) {
    validateSkillDirPath(dir, skillDir, protectedPaths, fixtureDirs);
    const root = resolve(join(dir, skillDir));
    return { kind: "dir", root, mdFile: join(root, "SKILL.md") };
  }
  return { kind: "file", mdFile: join(dir, "SKILL.md") };
}

// H must cover every byte the treatment arm actually sees. A single file hashes
// directly -- unchanged from before skill_dir existed, so an absent-skill_dir
// registration's H does not move; unreadable there still hashes to null (the CLI's own
// existence check reports it), exactly as before this file existed.
//
// A directory is stricter, on purpose: once skill_dir's root demonstrably exists, ANY
// problem reading it -- a symlinked root (cpSync would copy it AS a symlink, so
// <sandbox>/skill would point outside the sandbox entirely), a walk error, or a single
// unreadable file among otherwise-good ones -- throws RegistrationError rather than
// quietly hashing to null. A null H that looks identical before and after someone broke
// a file's permissions is worse than no H: the registration still LOOKS confirmable.
// Only the root being entirely absent hashes to null, matching the single-file case,
// because that is the CLI's own existence check to report.
//
// The manifest covers every file in it, so editing any reference file -- not only
// SKILL.md -- moves H; a byte-identical rewrite (a no-op reformat that changes nothing)
// does not, since the manifest is over bytes. `skill.files` is cached on the descriptor
// (relative paths) so pattern-drift and leakage don't have to re-walk the directory.
export function hashSkill(skill) {
  if (skill.kind !== "dir") {
    try {
      return sha256(readFileSync(skill.mdFile));
    } catch {
      return null; // absent or unreadable
    }
  }

  let rootStat;
  try {
    rootStat = lstatSync(skill.root);
  } catch {
    return null; // skill_dir's resolved location doesn't exist at all
  }
  if (rootStat.isSymbolicLink()) {
    throw new RegistrationError([`skill_dir root "${skill.root}" is a symlink; refused as a structural failure`]);
  }

  let files;
  try {
    files = walkSkillDir(skill.root);
  } catch (e) {
    if (e instanceof RegistrationError) throw e;
    throw new RegistrationError([`skill_dir could not be read: ${e.message}`]);
  }
  // walkSkillDir's own order is depth-first with directory entries interleaved among
  // sibling files -- NOT a sort by full path ("a/x" can come before "a-b" there, since
  // "a" the directory and "a-b" the file are compared as sibling NAMES at the level
  // where they're actually siblings). PROTOCOL §3 promises the manifest sorted by full
  // path, where "a-b" < "a/x" as plain strings (code unit 45 for "-" against 47 for
  // "/"), so it has to be sorted here, once, after the walk -- not relied on to fall out
  // of readdir order at each level.
  files.sort();

  const manifest = [];
  for (const p of files) {
    let bytes;
    try {
      bytes = readFileSync(join(skill.root, p));
    } catch (e) {
      throw new RegistrationError([`skill_dir file "${p}" could not be read: ${e.message}`]);
    }
    manifest.push({ path: p, sha256: sha256(bytes) });
  }
  skill.files = files;
  return sha256(Buffer.from(canonicalJSON(manifest), "utf8"));
}

// Every file path the treatment arm can actually see: just SKILL.md for a single file,
// every file under skill_dir for a directory. Requires hashSkill to have run first for
// a directory skill (it populates skill.files); falls back to just mdFile if it hasn't,
// which is only ever wrong for a directory skill whose files were never walked -- not a
// path any caller takes, since loadRegistration always hashes before this is used.
export function skillFilePaths(skill) {
  return skill.kind === "dir" && skill.files
    ? skill.files.map((p) => join(skill.root, p))
    : [skill.mdFile];
}

// Every text file the treatment arm can actually see, concatenated -- an answer key can
// sit in a reference file as easily as in SKILL.md. Used by pattern-drift, which checks
// for a verifier pattern anywhere in the RAW text; frontmatter stripping (leakage.mjs's
// job, per-file, via distinctiveTermsForSkill) does not apply here on purpose --
// patternDrift never stripped it even for a single-file skill. Unreadable or
// undecodable entries are skipped silently: this is a cross-check, not a correctness
// gate.
export function combinedSkillText(skill) {
  const paths = skillFilePaths(skill);
  const parts = [];
  for (const p of paths) {
    // mdFile itself is let through unguarded -- an unreadable SKILL.md (a directory, in
    // one existing regression test) is a real problem the CLI's callers decide how to
    // handle, exactly as before skill_dir existed. Only the EXTRA files a directory
    // skill contributes are tolerated: a reference file can be binary or otherwise
    // undecodable without that being this cross-check's problem.
    if (p === skill.mdFile) {
      parts.push(readFileSync(p, "utf8"));
    } else {
      try { parts.push(readFileSync(p, "utf8")); } catch { /* unreadable or binary, skip */ }
    }
  }
  // Joined BETWEEN files, not prefixed before each -- a leading "\n" broke every
  // frontmatter-stripping consumer downstream (distinctiveTerms checks whether the
  // string's own first line is "---"; prefixing one made the first line "" instead).
  return parts.join("\n");
}
