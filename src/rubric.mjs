// Judge rubrics that grade the skill's own vocabulary. FAILURES.md entry 1, one level up.
//
// PATTERN_IN_SKILL (prereg.mjs) catches a verifier pattern lifted verbatim out of the
// skill. A judge-graded task has no pattern to check, and the same answer key can sit in
// its rubric instead: "PASS if the reply says to run scripts/run_all.py". The control arm
// has never seen that file name and cannot produce it; the treatment arm reads it off its
// system prompt. In skill-audit's uap-release-analyzer run, 29 of the treatment arm's 34
// extra passes came from three rubrics of exactly this shape, and nothing in nullbench
// noticed -- the audit found it by counting file names in replies by hand.
//
// What is checked: the identifier-like terms in a signal task's rubric -- file names,
// paths, package specifiers, snake_case / SCREAMING_CASE / camelCase / PascalCase names,
// dotted members, backticked spans -- that appear in the skill's text but in neither the
// task's prompt nor its fixture. A term the prompt or fixture contains is visible to both
// arms, so grading it is fair; only a term the skill alone supplies is flagged.
//
// Why a warning and not drift: unlike a verbatim pattern, a rubric naming a skill-taught
// API is not always gaming. Supplying names and facts the base model lacks is what a
// reference skill is for (skill-audit's otel-go run is the worked case: real lift, and
// it came from the reference content, not the instruction the author was measuring). The
// warning makes the reader ask which one they are looking at; it does not decide for
// them, so it never changes a run's class.
//
// What this does NOT catch: prose. A rubric that requires the reply to state a fact in
// the skill's words ("integer Retry-After values are seconds") has no identifier to
// extract, and the check is silent on it. It catches named artifacts, and nothing more.

import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

const EXTENSIONS = "py|md|csv|tsv|json|jsonl|js|mjs|cjs|ts|tsx|jsx|go|rs|rb|sh|ya?ml|toml|txt|html|css|sql|java|kt|swift|cpp|hpp|ipynb";

const PATTERNS = [
  /`([^`\n]{2,80})`/g, //                                      backticked span
  /(?:@[\w-]+\/)?[\w.-]*[\w-]\/[\w./-]*\w|(?<![\w/])\/[\w-]+(?:\/[\w.-]+)+/g, // path or package
  new RegExp(`\\b[\\w-]{2,}\\.(?:${EXTENSIONS})\\b`, "g"), //   file name
  /\b[a-z]\w*\.[A-Z]\w+\b/g, //                                 pkg.Member
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, //                      snake_case
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, //                      SCREAMING_CASE
  /\b[a-z]+[A-Z]\w*\b/g, //                                     camelCase
  /\b[A-Z][a-z0-9]+[A-Z]\w*\b/g, //                             PascalCase with an inner capital
];

// A slash-joined pair of plain words ("and/or", "hex/rgb", "API/SDK") is prose, not a
// path. A path either starts at a root (/ or @scope) or has a segment that only code
// would write: a dot, underscore, hyphen or digit.
const isPath = (t) => /^[/@]/.test(t) || /[._\-0-9]/.test(t);

export function rubricTerms(rubric) {
  const out = new Set();
  PATTERNS.forEach((re, i) => {
    for (const m of String(rubric).matchAll(re)) {
      // A path ending a sentence picks up its full stop.
      const t = (m[1] ?? m[0]).trim().replace(/[.,;:]+$/, "");
      if (t.length < 4 || !/[a-z]/i.test(t)) continue;
      if (i === 1 && !isPath(t)) continue;
      out.add(t);
    }
  });
  return [...out];
}

// Everything a fixture puts in front of both arms, lowercased. Symlinks are not followed
// (the sandbox copy refuses them), and files over 1 MB are skipped -- a term that only
// appears in a lockfile is not one either arm is likely to read.
function fixtureText(root) {
  const parts = [];
  const walk = (p) => {
    let st;
    try { st = lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const n of readdirSync(p)) walk(join(p, n)); return; }
    if (st.isFile() && st.size <= 1024 * 1024) {
      try { parts.push(readFileSync(p, "utf8")); } catch { /* unreadable: nothing either arm sees */ }
    }
  };
  walk(root);
  return parts.join("\n").toLowerCase();
}

const MAX_NAMED = 8;

// `sourceLabel` names what was scanned, as in patternDrift: "SKILL.md", or "skill_dir"
// when the term may sit in any reference file.
export function rubricVocabulary(tasks, skillText, { fixtureRoot = ".", sourceLabel = "SKILL.md" } = {}) {
  const hay = String(skillText).toLowerCase();
  const fixtures = new Map();
  const out = [];
  for (const t of tasks) {
    const v = t.spec?.verify;
    if (t.kind === "harm" || v?.type !== "judge" || typeof v.rubric !== "string") continue;
    let seen = String(t.spec.prompt ?? "").toLowerCase();
    if (typeof t.spec.fixture === "string") {
      if (!fixtures.has(t.spec.fixture)) fixtures.set(t.spec.fixture, fixtureText(join(fixtureRoot, t.spec.fixture)));
      seen += "\n" + fixtures.get(t.spec.fixture);
    }
    const hits = rubricTerms(v.rubric).filter((x) => {
      const k = x.toLowerCase();
      return hay.includes(k) && !seen.includes(k);
    });
    const terms = hits.filter((x) => !hits.some((y) => y !== x && y.toLowerCase().includes(x.toLowerCase())));
    if (!terms.length) continue;
    const named = terms.slice(0, MAX_NAMED).join(", ") + (terms.length > MAX_NAMED ? `, +${terms.length - MAX_NAMED} more` : "");
    out.push({
      code: "RUBRIC_TERM_IN_SKILL", task: t.id, terms,
      detail: `task "${t.id}" rubric grades term(s) found in ${sourceLabel} but in neither its prompt nor its fixture: ` +
        `${named}. Only the treatment arm has seen them, so a pass can mean the reply repeated the skill's ` +
        `vocabulary rather than changed its behaviour (FAILURES.md entry 1)`,
    });
  }
  return out;
}
