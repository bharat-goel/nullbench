// Two checks on control-arm contamination, of deliberately unequal strength.
//
// The failure being guarded: running the subject in the repository let the control arm
// read the skills off disk and inherit the parent CLAUDE.md describing them. Control
// replies came back in the skill's own vocabulary and every delta collapsed toward
// zero. There was no error and no symptom. FAILURES.md entry 5.
//
// assertIsolated is deterministic and reliable. scanControlLeakage is a heuristic and
// is documented as one: it false-positives on skills whose vocabulary is ordinary
// English, and it cannot detect the model knowing the skill from its installed copy or
// from training. It raises a question; it never answers one.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

const FORBIDDEN = ["CLAUDE.md", ".claude", "skills", "AGENTS.md"];

export function assertIsolated(cwd, repoRoot) {
  const problems = [];
  const abs = resolve(cwd);
  const root = resolve(repoRoot);
  const rel = relative(root, abs);
  // rel === "" means cwd IS the repository root -- the worst case, and an earlier
  // version skipped it because of a truthiness check on rel.
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    if (rel === "") {
      problems.push(`sandbox ${abs} is the repository root itself; the control arm can read the skill`);
    } else {
      problems.push(`sandbox ${abs} is inside the repository at ${root}; the control arm can read the skill`);
    }
  }
  for (const name of FORBIDDEN) {
    if (existsSync(join(abs, name))) problems.push(`sandbox contains ${name}, which the control arm must not see`);
  }
  return { ok: problems.length === 0, problems };
}

const STOP = new Set(("the a an and or but if is are was were be been being to of in on at by for with from as that this these those it its " +
  "you your we our they their he she them do does did not no yes can will would should could may might must have has had " +
  "what which who when where why how all any some each more most other into than then so such only own same too very").split(" "));

export function distinctiveTerms(skillText, limit = 12) {
  // Only strip frontmatter if the very first line is exactly --- and a later
  // line is also exactly ---, with no blank lines between them. YAML frontmatter
  // does not contain blank lines, but a document with horizontal-rule separators
  // typically does. This prevents stripping body content when the document opens
  // with a horizontal rule that isn't YAML frontmatter.
  let body = skillText;
  const lines = skillText.split("\n");
  if (lines[0]?.trim() === "---") {
    // Find the closing --- (must be on its own line)
    const closeIdx = lines.slice(1).findIndex((line) => line.trim() === "---");
    if (closeIdx !== -1) {
      // Check if the block contains blank lines (signal of body content, not metadata)
      const block = lines.slice(1, closeIdx + 1);
      const hasBlankLines = block.some((line) => line.trim() === "");
      if (!hasBlankLines) {
        // No blank lines: this looks like YAML frontmatter, strip it
        body = lines.slice(closeIdx + 2).join("\n");
      }
    }
  }
  body = body.toLowerCase();
  const words = body.split(/[^a-z']+/).filter(Boolean);

  // Bigrams whose halves are both content words carry far more signal than any single
  // word, and are much less likely to appear in an unrelated reply by chance.
  const bigrams = new Map();
  for (let i = 0; i < words.length - 1; i++) {
    const [a, b] = [words[i], words[i + 1]];
    if (STOP.has(a) || STOP.has(b) || a.length < 4 || b.length < 4) continue;
    const key = `${a} ${b}`;
    bigrams.set(key, (bigrams.get(key) ?? 0) + 1);
  }
  const phrases = [...bigrams.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);

  const singles = [...new Set(words.filter((w) => w.length >= 8 && !STOP.has(w)))];
  return [...phrases, ...singles].slice(0, limit);
}

export function scanControlLeakage({ rawDir, terms, threshold = 0.5 }) {
  if (!existsSync(rawDir) || terms.length === 0) return { checked: 0, hits: 0, rate: 0, suspicious: false };
  // Match only files with the exact shape: *__control__<digits>.txt
  // This prevents collisions with .bak files or task ids containing __control__ substring
  const files = readdirSync(rawDir).filter((f) => /.*__control__\d+\.txt$/.test(f));
  let hits = 0;
  for (const f of files) {
    const text = readFileSync(join(rawDir, f), "utf8").toLowerCase();
    if (terms.some((t) => text.includes(t))) hits += 1;
  }
  const rate = files.length ? hits / files.length : 0;
  return { checked: files.length, hits, rate, suspicious: rate >= threshold };
}
