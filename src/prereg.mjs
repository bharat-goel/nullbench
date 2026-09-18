// Loading, validating and hashing a registration.
//
// Two kinds of problem, deliberately handled differently:
//
//   Structural  -- the registration cannot be executed at all (no file, malformed
//                  JSON, missing field, bad enum, task file absent). Throws.
//   Drift       -- the registration can be executed but not confirmed (a task file no
//                  longer matches its declared hash; no harm task present). Returned.
//
// Collapsing these would either block exploratory work, which is a legitimate and
// necessary phase, or let a changed task pass as confirmed, which is the whole thing
// this project exists to stop.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJSON } from "./canonical.mjs";

export class RegistrationError extends Error {
  constructor(problems) {
    super(`registration is not executable:\n  - ${problems.join("\n  - ")}`);
    this.name = "RegistrationError";
    this.problems = problems;
  }
}

const KINDS = new Set(["signal", "harm"]);
const PREDICTIONS = new Set(["helps", "no-effect", "harms"]);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function loadRegistration(dir) {
  const regPath = join(dir, "nullbench.json");
  const problems = [];

  if (!existsSync(regPath)) throw new RegistrationError([`no nullbench.json in ${dir}`]);

  let raw;
  try {
    raw = JSON.parse(readFileSync(regPath, "utf8"));
  } catch (e) {
    throw new RegistrationError([`nullbench.json is not valid JSON: ${e.message}`]);
  }

  for (const f of ["model", "judge_model"]) {
    if (typeof raw[f] !== "string" || !raw[f]) problems.push(`"${f}" must be a non-empty string`);
  }
  if (!Number.isInteger(raw.reps) || raw.reps < 1) problems.push(`"reps" must be a positive integer`);
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) problems.push(`"tasks" must be a non-empty array`);

  if (problems.length) throw new RegistrationError(problems);

  const tasks = [];
  const seen = new Set();
  for (const [i, t] of raw.tasks.entries()) {
    const at = `tasks[${i}]`;
    if (typeof t.id !== "string" || !t.id) { problems.push(`${at}.id must be a non-empty string`); continue; }
    if (seen.has(t.id)) problems.push(`${at}.id "${t.id}" is duplicated`);
    seen.add(t.id);
    if (typeof t.file !== "string") problems.push(`${at}.file must be a string`);
    if (!/^[0-9a-f]{64}$/.test(t.sha256 ?? "")) problems.push(`${at}.sha256 must be 64 hex characters`);
    if (!KINDS.has(t.kind)) problems.push(`${at}.kind must be one of ${[...KINDS].join(", ")}`);
    if (!PREDICTIONS.has(t.predict)) problems.push(`${at}.predict must be one of ${[...PREDICTIONS].join(", ")}`);

    const abs = join(dir, t.file ?? "");
    if (typeof t.file !== "string" || !existsSync(abs)) { problems.push(`${at}.file "${t.file}" does not exist`); continue; }

    let bytes, spec;
    try {
      bytes = readFileSync(abs);
      spec = JSON.parse(bytes.toString("utf8"));
    } catch (e) {
      problems.push(`${at}.file "${t.file}" could not be read as JSON: ${e.message}`);
      continue;
    }
    tasks.push({ id: t.id, file: t.file, declaredSha: t.sha256, actualSha: sha256(bytes), kind: t.kind, predict: t.predict, spec });
  }

  if (problems.length) throw new RegistrationError(problems);

  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const drift = [];
  for (const t of tasks) {
    if (t.actualSha !== t.declaredSha) {
      drift.push({ code: "HASH_MISMATCH", detail: `task "${t.id}" (${t.file}) declared ${t.declaredSha.slice(0, 12)}..., found ${t.actualSha.slice(0, 12)}...` });
    }
  }
  if (!tasks.some((t) => t.kind === "harm")) {
    drift.push({ code: "NO_HARM_TASK", detail: "no harm task; a suite with no negative control cannot be confirmatory" });
  }

  // Hashed over actual contents, not declared ones, so the hash names what really ran.
  const body = canonicalJSON({
    model: raw.model, judge_model: raw.judge_model, reps: raw.reps,
    tasks: tasks.map((t) => ({ id: t.id, kind: t.kind, predict: t.predict, sha256: t.actualSha })),
  });
  const hash = sha256(Buffer.from(body, "utf8"));

  return { config: { model: raw.model, judge_model: raw.judge_model, reps: raw.reps }, tasks, hash, drift };
}

// Verifier patterns lifted verbatim out of SKILL.md.
//
// The gaming recipe this exists to interrupt: register two signal tasks whose verifier
// is {type: "any", patterns: ["<a word from your own SKILL.md>"]}. The control arm has
// never seen the word and cannot say it; the treatment arm reads it off the injected
// system prompt. Both cells go from near 0/10 to 10/10, both intervals sit far from
// zero, and the report is CONFIRMATORY. That is FAILURES.md entry 1 -- the artefact this
// project opens with -- reproduced deliberately instead of by accident. Nothing else in
// the runner notices it: the post-run leakage scan compares the skill's vocabulary
// against CONTROL replies, which by construction contain none of it, so it stays silent
// exactly when the gaming worked.
//
// WHICH PATTERNS ARE CHECKED, and why it is not all of them:
//
//   any            -- checked. A match IS the pass, so a skill-lifted pattern hands the
//                     treatment arm the answer key.
//   ordered        -- checked, both before[] and after[]. Same reasoning; ordering
//                     verifiers have no legitimate reason to quote the skill.
//   none, signal   -- checked. A signal task has no business forbidding the skill's own
//                     words.
//   none, harm     -- NOT checked. This is the vocabulary-leak negative control, and it
//                     is the shape this project recommends: a harm task asserting the
//                     skill does not inject "goodhart" or "iso 8601" into an unrelated
//                     answer MUST name the skill's vocabulary to do its job. Flagging it
//                     would put permanent drift on the two negative controls nullbench
//                     itself ships (examples/cobra's ic-noop-routine and the placebo
//                     fixture's vocabulary-leak), and it cannot be gamed in the
//                     rewarding direction: a skill-lifted `none` pattern can only make
//                     the treatment arm look WORSE.
//
// Patterns carrying no letters or digits are skipped: "\n\n" tells you nothing about
// vocabulary and matches any SKILL.md with a blank line in it.
//
// What this does NOT catch, and the documentation must not claim otherwise: a paraphrase
// of a skill phrase, a word the skill merely makes more likely, or a pattern the author
// chose after reading skill-influenced replies. It catches a verbatim lift.
export function patternDrift(tasks, skillText) {
  const hay = String(skillText).toLowerCase();
  const out = [];
  for (const t of tasks) {
    const v = t.spec?.verify;
    if (!v || typeof v !== "object") continue;
    let pats = [];
    if (v.type === "any") pats = v.patterns ?? [];
    else if (v.type === "ordered") pats = [...(v.before ?? []), ...(v.after ?? [])];
    else if (v.type === "none" && t.kind !== "harm") pats = v.patterns ?? [];
    for (const p of pats) {
      if (typeof p !== "string") continue;
      const needle = p.toLowerCase().trim();
      if (!needle || !/[a-z0-9]/.test(needle)) continue;
      if (hay.includes(needle)) {
        out.push({
          code: "PATTERN_IN_SKILL",
          detail: `task "${t.id}" verifier pattern "${p}" appears verbatim in SKILL.md; ` +
            `the treatment arm can pass it by reading its own system prompt`,
        });
      }
    }
  }
  return out;
}
