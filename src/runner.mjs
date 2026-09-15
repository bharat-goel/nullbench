// Paired execution.
//
// Control and treatment are identical in every respect except that treatment has the
// skill's SKILL.md appended to the system prompt. Both run in a fresh temp directory
// outside the repository with --setting-sources project, so neither arm can see the
// installed skills, the repository, or its CLAUDE.md.

import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "./claude.mjs";
import { assertIsolated } from "./leakage.mjs";
import { verify } from "./verify.mjs";
import { runJudge } from "./judge.mjs";

// A task may declare a fixture: a small project copied fresh for every run, so a run
// that edits files cannot contaminate the next one.
function makeCwd(task, fixtureRoot, shared) {
  if (!task.spec.fixture) return { cwd: shared, temporary: false };
  const src = join(fixtureRoot, task.spec.fixture);
  if (!existsSync(src)) {
    throw new Error(`task "${task.id}" declares fixture "${task.spec.fixture}", but ${src} does not exist`);
  }
  const dir = mkdtempSync(join(tmpdir(), "nullbench-fx-"));
  cpSync(src, dir, { recursive: true });
  // A fixture is a real project copied in, and it may carry its own CLAUDE.md or
  // .claude directory. Every cwd is checked, not just the shared one.
  const iso = assertIsolated(dir, fixtureRoot);
  if (!iso.ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`fixture sandbox for "${task.id}" is not isolated:\n  - ${iso.problems.join("\n  - ")}`);
  }
  return { cwd: dir, temporary: true };
}

export function gradedCounts(records) {
  const out = {};
  for (const r of records) {
    out[r.task] ??= { control: 0, treatment: 0 };
    if (!r.failed) out[r.task][r.cond] += 1;
  }
  return out;
}

export async function runSuite({
  registration, requested, skillFile, fixtureRoot = ".", rawDir = null,
  concurrency = 4, onProgress = () => {},
}) {
  const shared = mkdtempSync(join(tmpdir(), "nullbench-"));
  if (rawDir) mkdirSync(rawDir, { recursive: true });

  const byId = new Map(registration.tasks.map((t) => [t.id, t]));
  const jobs = [];
  for (const id of requested.taskIds) {
    const task = byId.get(id);
    for (const cond of ["control", "treatment"]) {
      for (let rep = 1; rep <= requested.reps; rep++) jobs.push({ task, cond, rep });
    }
  }

  const records = [];
  let done = 0;

  async function worker(queue) {
    while (queue.length) {
      const { task, cond, rep } = queue.shift();
      const { cwd, temporary } = makeCwd(task, fixtureRoot, shared);
      const { out, err, code } = await invoke({
        prompt: task.spec.prompt,
        systemPromptFile: cond === "treatment" ? skillFile : null,
        cwd, model: requested.model,
      });
      if (temporary) rmSync(cwd, { recursive: true, force: true });

      const name = `${task.id}__${cond}__${rep}`;
      if (rawDir) writeFileSync(join(rawDir, `${name}.txt`), out || `<<no output>>\n${err}`);

      let v;
      if (code !== 0 || !out) {
        // Not a wrong answer -- no answer. Counting these as failures let an 83%-dead
        // batch print a tidy -13.3pp. FAILURES.md entry 8.
        v = { pass: false, failed: true, why: `run failed (exit ${code}): ${(out || err).slice(0, 80)}` };
      } else if (task.spec.verify.type === "judge") {
        v = await runJudge({ task: task.spec, reply: out, model: requested.judgeModel, cwd: shared });
      } else {
        v = verify(task.spec.verify, out);
      }

      records.push({ task: task.id, cond, rep, pass: v.pass, failed: !!v.failed, why: v.why });
      onProgress(++done, jobs.length, name, v.pass);
    }
  }

  const queue = [...jobs];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker(queue)));
  rmSync(shared, { recursive: true, force: true });
  return { records };
}
