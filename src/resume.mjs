// Resuming an interrupted batch. PROTOCOL.md §10.
//
// The failure this exists for: a plan's session limit lands partway through a batch.
// The process stays alive, every remaining call dies fast, and the batch completes as
// VOID -- correctly, because dead runs leave the denominator (FAILURES.md entry 8). The
// only remedy used to be re-running the whole batch. skill-audit's uap-release-analyzer
// (398 calls) went VOID twice this way; the second time 164 of 180 subject runs had
// graded, and the retry repaid all 398. `--task` cannot be used to split a batch,
// because a subset run is EXPLORATORY by protocol and stays that way.
//
// A resume is a new run that re-attempts only the cells that produced no answer and
// carries every graded cell forward unchanged. What keeps it from being a file drawer
// (FAILURES.md entry 13) is what it refuses:
//
//   - a different registration hash H. Any change to a task file, SKILL.md or
//     nullbench.json's model/judge_model/reps moves H, and a resume across it would
//     splice two different experiments into one table.
//   - a different requested config -- model, judge model, reps, task set, skill
//     override -- even where H would allow it, because the carried records were
//     produced under the old one.
//   - a graded run. Pass or fail, a run that was graded is an observation, and
//     re-running it until the number looks good is the file drawer with extra steps.
//     The only cells re-attempted are those whose record is `failed: true` (the subject
//     or the judge never answered: non-zero exit, empty output, a session limit) or
//     that have no record at all (the process was killed before reaching them).
//   - a run that has already been resumed. Resuming the same run twice would let a
//     second draw on its dead cells replace the first. Resume the resume instead.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { RegistrationError } from "./prereg.mjs";

export const stampDir = (stamp) => stamp.replace(/[:.]/g, "-");
const slotKey = (r) => `${r.task}\u0000${r.cond}\u0000${r.rep}`;
const ARMS = ["control", "treatment"];

// `ref` is a stamp (`2026-09-18T21:41:48Z`), its directory name, a results directory,
// or a records.json path. Anything unreadable is structural: nothing has been spent.
export function loadPrior(dir, ref) {
  const candidates = [
    resolve(ref),
    join(resolve(ref), "records.json"),
    join(dir, "results", stampDir(ref), "records.json"),
    join(dir, "results", ref, "records.json"),
  ];
  const path = candidates.find((p) => p.endsWith(".json") && existsSync(p));
  if (!path) throw new RegistrationError([`--resume "${ref}": no records.json found (looked for ${[...new Set(candidates.slice(1))].join(", ")})`]);
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new RegistrationError([`--resume "${ref}": ${path} is not valid JSON: ${e.message}`]);
  }
  const problems = [];
  if (typeof data.stamp !== "string") problems.push("it has no stamp");
  if (!/^[0-9a-f]{64}$/.test(data.hash ?? "")) problems.push("it has no registration hash");
  if (!data.requested || typeof data.requested !== "object") problems.push("it has no requested config");
  if (!Array.isArray(data.records)) problems.push("it has no records array");
  if (problems.length) throw new RegistrationError(problems.map((p) => `--resume "${ref}": ${path}: ${p}`));
  return { path, data };
}

// Why this resume may not happen. Empty when it may.
export function resumeProblems({ prior, registration, requested, dir }) {
  const problems = [];

  if (prior.hash !== registration.hash) {
    const was = prior.registration;
    const detail = [];
    if (was) {
      const before = new Map((was.tasks ?? []).map((t) => [t.id, t.sha256]));
      for (const t of registration.tasks) {
        if (!before.has(t.id)) detail.push(`task "${t.id}" was not in the registration`);
        else if (before.get(t.id) !== t.actualSha) detail.push(`task "${t.id}" (${t.file}) changed`);
      }
      for (const id of before.keys()) {
        if (!registration.tasks.some((t) => t.id === id)) detail.push(`task "${id}" is no longer registered`);
      }
      if (was.skill_sha256 !== registration.skillSha) detail.push("SKILL.md changed");
      if (was.config && JSON.stringify(was.config) !== JSON.stringify(registration.config)) {
        detail.push("model, judge_model or reps in nullbench.json changed");
      }
    }
    problems.push(
      `registration hash differs: ${prior.stamp} ran under H=${prior.hash.slice(0, 16)}, ` +
      `this registration is H=${registration.hash.slice(0, 16)}` +
      (detail.length ? ` (${detail.join("; ")})` : "") +
      ` -- a resume may only combine runs of the same experiment`);
  }

  const was = prior.requested;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (was.model !== requested.model) problems.push(`model differs: ${prior.stamp} ran ${was.model}, this run would use ${requested.model}`);
  if (was.judgeModel !== requested.judgeModel) problems.push(`judge model differs: ${prior.stamp} ran ${was.judgeModel}, this run would use ${requested.judgeModel}`);
  if (was.reps !== requested.reps) problems.push(`reps differ: ${prior.stamp} ran ${was.reps}, this run would use ${requested.reps}`);
  if (!same([...(was.taskIds ?? [])].sort(), [...requested.taskIds].sort())) {
    problems.push(`task set differs: ${prior.stamp} ran [${(was.taskIds ?? []).join(",")}], this run would use [${requested.taskIds.join(",")}]`);
  }
  if (!same(was.skillOverride, requested.skillOverride)) {
    problems.push(`skill override differs: ${prior.stamp} ran ${was.skillOverride ?? "the registered SKILL.md"}, this run would use ${requested.skillOverride ?? "the registered SKILL.md"}`);
  }

  const by = resumedBy(dir, prior.stamp);
  if (by) problems.push(`${prior.stamp} has already been resumed by ${by}; resume that run instead`);

  if (!problems.length && partition(prior, requested).toRun.length === 0) {
    problems.push(`${prior.stamp} has no dead runs to re-attempt; every cell already graded`);
  }
  return problems;
}

// A run records the stamp it resumes in its checkpoint before it spends anything, so a
// resume that was itself killed still claims its parent.
export function resumedBy(dir, stamp) {
  const root = join(dir, "results");
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root).sort()) {
    const p = join(root, d, "records.json");
    if (!existsSync(p)) continue;
    try {
      const r = JSON.parse(readFileSync(p, "utf8"));
      if (r.resumes === stamp) return r.stamp;
    } catch { /* an unreadable checkpoint claims nothing */ }
  }
  return null;
}

// Every graded record is carried; every cell without one is re-run. Dead records are
// kept aside so the report can say how many were superseded and where they came from.
export function partition(prior, requested) {
  const carried = [];
  const superseded = [];
  const graded = new Set();
  for (const r of prior.records) {
    const tagged = { ...r, stamp: r.stamp ?? prior.stamp };
    if (r.failed) { superseded.push(tagged); continue; }
    if (graded.has(slotKey(r))) continue;
    graded.add(slotKey(r));
    carried.push(tagged);
  }
  const toRun = [];
  for (const task of requested.taskIds) {
    for (const cond of ARMS) {
      for (let rep = 1; rep <= requested.reps; rep++) {
        if (!graded.has(slotKey({ task, cond, rep }))) toRun.push({ task, cond, rep });
      }
    }
  }
  return { carried, superseded, toRun };
}

// Canaries on resume: the WHOLE canary set is re-run, every time, and nothing about the
// earlier result is forgiven. The resumed runs are graded by a new judge session, which
// has to be validated on its own; the carried runs were graded by the earlier session,
// whose canary result still stands. So:
//
//   - a misgrade anywhere in the chain fails the canary condition for the combined batch;
//   - an earlier canary result that was never recorded (a run killed before it wrote
//     one, or a records.json from before this existed) fails it too, if any carried
//     run was judge-graded -- that judge is unverified;
//   - an earlier canary call that merely never answered does not count against it. A
//     dead call is not a misgrade (see runCanaries), and the fresh set re-checks it.
export function mergeCanary({ fresh, prior, registration }) {
  if (!fresh) return { canary: null, reasons: [] };
  const judged = new Set(registration.tasks.filter((t) => t.spec.verify.type === "judge").map((t) => t.id));
  const carriedJudged = prior.records.some((r) => !r.failed && judged.has(r.task));
  const was = prior.canary;
  const misgrades = was
    ? [...(was.misgrades ?? []).map((m) => ({ ...m, stamp: m.stamp ?? prior.stamp })), ...(was.carried?.misgrades ?? [])]
    : [];
  const unverified = (carriedJudged && !was) || !!was?.carried?.unverified;
  const reasons = [];
  if (misgrades.length) {
    reasons.push(`judge canaries misgraded in an earlier run of this batch (${misgrades.map((m) => `${m.stamp}: ${m.id}`).join(", ")}); ` +
      `its carried judge-graded runs cannot be confirmed`);
  }
  if (unverified) reasons.push(`no canary result was recorded for ${prior.stamp}; the judge that graded its carried runs is unverified`);
  return {
    canary: {
      ...fresh,
      ok: fresh.ok && !misgrades.length && !unverified,
      carried: { stamp: prior.stamp, misgrades, unverified, freshOk: fresh.ok },
    },
    reasons,
  };
}

// Graded records per contributing stamp, in chain order.
export function contributions(chain, records) {
  return chain.map((stamp) => ({ stamp, graded: records.filter((r) => r.stamp === stamp && !r.failed).length }));
}
