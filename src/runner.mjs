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

// ONE SANDBOX PER INVOCATION. Not per task, not per suite.
//
// This used to hand every non-fixture run the same `shared` directory for the whole
// batch -- tasks x 2 arms x reps invocations, at concurrency 4, treatment and control
// interleaved in one directory, with assertIsolated run exactly once before the first
// job. Two ways that is fatal:
//
//   1. Anything a treatment run wrote was sitting there for later control runs to read.
//   2. assertIsolated's FORBIDDEN check is point-in-time. One run creating .claude/ or
//      CLAUDE.md in that directory meant every subsequent control run saw precisely
//      what the check exists to prevent -- no error, no warning, no class change. That
//      is FAILURES.md entry 5 reintroduced one level up.
//
// So: mkdtemp before the invocation, assertIsolated it, rmSync it in a `finally`. A
// fixture task gets the same lifecycle with the fixture copied in first -- that path
// was always per-run, and is now simply the general case rather than the exception.
function makeCwd(task, fixtureRoot, repoRoot) {
  const fixture = task.spec.fixture;
  let src = null;
  if (fixture) {
    src = join(fixtureRoot, fixture);
    if (!existsSync(src)) {
      throw new Error(`task "${task.id}" declares fixture "${fixture}", but ${src} does not exist`);
    }
  }
  const dir = mkdtempSync(join(tmpdir(), fixture ? "nullbench-fx-" : "nullbench-run-"));
  if (src) cpSync(src, dir, { recursive: true });
  // A fixture is a real project copied in, and it may carry its own CLAUDE.md or
  // .claude directory. This is deliberately strict: a fixture carrying CLAUDE.md,
  // .claude, skills/, or AGENTS.md is indistinguishable by inspection from actual
  // leakage, so it is refused outright rather than inspected for whether the contents
  // are actually dangerous. The one fixture this project uses (cobra's failing-suite)
  // contains only README.md, package.json, prorate.js and test.js, so nothing real is
  // blocked by this.
  //
  // Isolation is checked against repoRoot, not fixtureRoot: fixtureRoot only resolves
  // where fixture sources live (e.g. cobra-skill/eval/), and a sandbox can sit inside
  // the repository above that directory without ever being a descendant of it.
  const iso = assertIsolated(dir, repoRoot);
  if (!iso.ok) {
    rmSync(dir, { recursive: true, force: true });
    // Throwing aborts the whole batch, not just this task. A sandbox that fails this
    // check means the environment is wrong, and every other run in flight shares that
    // environment -- a contaminated batch is not salvageable one task at a time.
    throw new Error(`sandbox for task "${task.id}" is not isolated:\n  - ${iso.problems.join("\n  - ")}`);
  }
  return dir;
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
  registration, requested, skillFile, fixtureRoot = ".", repoRoot = fixtureRoot, rawDir = null,
  concurrency = 4, onProgress = () => {},
}) {
  // A preflight probe, and nothing else. No run executes here any more -- every
  // invocation gets its own sandbox from makeCwd. What this still buys is failing
  // before a single CLI call is paid for when the temp directory itself is unusable:
  // TMPDIR pointing inside the repository under evaluation is the case that matters,
  // and it is a property of the environment, identical for every per-run sandbox that
  // would follow. repoRoot defaults to fixtureRoot so every existing caller keeps its
  // old behavior; the CLI passes a real, resolved repository root instead.
  const probe = mkdtempSync(join(tmpdir(), "nullbench-"));
  const iso = assertIsolated(probe, repoRoot);
  if (!iso.ok) {
    rmSync(probe, { recursive: true, force: true });
    throw new Error(`shared sandbox is not isolated:\n  - ${iso.problems.join("\n  - ")}`);
  }
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
      // Throws before the sandbox exists (missing fixture) or after cleaning it up
      // itself (failed isolation check) -- either way there is nothing to unwind here.
      const cwd = makeCwd(task, fixtureRoot, repoRoot);
      let v;
      try {
        const { out, err, code } = await invoke({
          prompt: task.spec.prompt,
          systemPromptFile: cond === "treatment" ? skillFile : null,
          cwd, model: requested.model,
        });

        const name = `${task.id}__${cond}__${rep}`;
        if (rawDir) writeFileSync(join(rawDir, `${name}.txt`), out || `<<no output>>\n${err}`);

        if (code !== 0 || !out) {
          // Not a wrong answer -- no answer. Counting these as failures let an 83%-dead
          // batch print a tidy -13.3pp. FAILURES.md entry 8.
          v = { pass: false, failed: true, why: `run failed (exit ${code}): ${(out || err).slice(0, 80)}` };
        } else if (task.spec.verify.type === "judge") {
          // The judge runs in this run's own sandbox, which is destroyed below. It is
          // the one invocation here with no tool restrictions (see the report note),
          // so giving it a directory nothing else will ever see is what keeps an
          // unrestricted judge from being a cross-run channel.
          v = await runJudge({ task: task.spec, reply: out, model: requested.judgeModel, cwd });
        } else {
          v = verify(task.spec.verify, out);
        }

        records.push({ task: task.id, cond, rep, pass: v.pass, failed: !!v.failed, why: v.why });
        onProgress(++done, jobs.length, name, v.pass);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  }

  const queue = [...jobs];
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker(queue)));
  } finally {
    // A worker throws (e.g. a fixture failing assertIsolated), which rejects
    // Promise.all -- without `finally`, the probe directory mkdtemp'd at the top of
    // this function is left behind on disk permanently, one leak per rejecting call.
    // Per-run sandboxes clean themselves up in the worker's own `finally`.
    rmSync(probe, { recursive: true, force: true });
  }
  return { records };
}
