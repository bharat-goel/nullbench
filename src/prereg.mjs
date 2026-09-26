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
import { resolveSkill, hashSkill } from "./skill.mjs";

export { RegistrationError } from "./errors.mjs";
import { RegistrationError } from "./errors.mjs";

const KINDS = new Set(["signal", "harm"]);
const PREDICTIONS = new Set(["helps", "no-effect", "harms"]);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// skillFile defaults to the registered location. The CLI passes the resolved path so a
// --skill override is hashed as what really ran, not as what was registered.
export function loadRegistration(dir, skillFile = null) {
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
  if (raw.skill_dir !== undefined && (typeof raw.skill_dir !== "string" || !raw.skill_dir)) {
    problems.push(`"skill_dir" must be a non-empty string`);
  }

  if (problems.length) throw new RegistrationError(problems);

  const tasks = [];
  const seen = new Set();
  for (const [i, t] of raw.tasks.entries()) {
    const at = `tasks[${i}]`;
    // Without this, a null or non-object entry threw a raw TypeError out of
    // loadRegistration, which bin/nullbench.mjs caught as exit 1 -- VOID's code. A
    // malformed registration and a voided result must never share an exit status.
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      problems.push(`${at} must be an object`);
      continue;
    }
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

  // The skill is the experiment's independent variable -- the single thing that differs
  // between the arms -- and leaving it out of H meant editing it between registration and
  // run changed nothing about the stamp, and `--skill elsewhere/SKILL.md` produced a
  // CONFIRMATORY report under the same H as the registered run. A hash that claims to
  // name what really ran has to cover it. `resolveSkill` picks a single SKILL.md
  // (unchanged shape, so H does not move for a registration with no skill_dir) or a
  // skill_dir, whose every file -- not only SKILL.md -- is covered by hashSkill's
  // manifest. null when absent or unreadable: that is a structural failure the CLI
  // rejects before spending anything, and hashing it as a distinct value keeps "no
  // skill" from colliding with any real skill.
  // A skill_dir that swallowed the registration file, the canary bank or a task file
  // would copy that content into the treatment sandbox as part of "the skill" -- exactly
  // what PATTERN_IN_SKILL and the leakage scan exist to keep out. Built from the parsed,
  // sorted `tasks` (not `raw.tasks`) so a fixture path comes from the same spec the
  // runner will actually use.
  const protectedPaths = [
    join(dir, "nullbench.json"),
    join(dir, "canaries.json"),
    ...tasks.map((t) => join(dir, t.file)),
  ];
  // Fixtures are checked separately and in BOTH directions (resolveSkill/
  // validateSkillDirPath): a fixture is copied into every arm's sandbox, control
  // included, so skill_dir being inside, equal to, or containing one would leak the
  // skill into the control arm too -- not merely into treatment, which is all
  // `protectedPaths` above is built to catch.
  const fixtureDirs = tasks.filter((t) => typeof t.spec?.fixture === "string").map((t) => join(dir, t.spec.fixture));
  const skill = resolveSkill(dir, { override: skillFile, skillDir: raw.skill_dir, protectedPaths, fixtureDirs });
  const skillSha = hashSkill(skill);

  // Hashed over actual contents, not declared ones, so the hash names what really ran.
  const body = canonicalJSON({
    model: raw.model, judge_model: raw.judge_model, reps: raw.reps,
    skill_sha256: skillSha,
    tasks: tasks.map((t) => ({ id: t.id, kind: t.kind, predict: t.predict, sha256: t.actualSha })),
  });
  const hash = sha256(Buffer.from(body, "utf8"));

  // Kept separate from `skill` (the resolved descriptor for THIS run) because an
  // override always resolves to kind:"file" regardless of what was registered --
  // `skill.kind` alone can never tell classify.mjs "this suite registered a skill_dir"
  // once --skill is in play. `registeredSkillDir` answers a different, narrower
  // question: what does nullbench.json itself declare, independent of any override.
  const registeredSkillDir = typeof raw.skill_dir === "string" ? raw.skill_dir : null;

  return {
    config: { model: raw.model, judge_model: raw.judge_model, reps: raw.reps },
    tasks, hash, drift, skill, registeredSkillDir,
  };
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
// `sourceLabel` names what actually got scanned in the drift message -- "SKILL.md" by
// default (the single-file shape), or a caller-supplied label such as "skill_dir" when
// the hit could be in any reference file, not necessarily SKILL.md itself. Saying
// "appears verbatim in SKILL.md" for a match that only exists in a reference file would
// send a suite author looking in the wrong place.
export function patternDrift(tasks, skillText, sourceLabel = "SKILL.md") {
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
          detail: `task "${t.id}" verifier pattern "${p}" appears verbatim in ${sourceLabel}; ` +
            `the treatment arm can pass it by reading its own system prompt`,
        });
      }
    }
  }
  return out;
}
