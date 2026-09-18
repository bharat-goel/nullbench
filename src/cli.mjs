// Flag parsing, cost preflight, orchestration, exit codes.

import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { loadRegistration, patternDrift, RegistrationError } from "./prereg.mjs";
import { runSuite, gradedCounts } from "./runner.mjs";
import { runCanaries, loadCanaries } from "./judge.mjs";
import { classify } from "./classify.mjs";
import { aggregate, renderReport } from "./report.mjs";
import { appendEntry } from "./ledger.mjs";
import { assertIsolated, distinctiveTerms, scanControlLeakage } from "./leakage.mjs";

function intArg(raw, flag) {
  const v = Number(raw);
  // Number("abc") is NaN, and `args.reps ?? registration.reps` does not catch NaN --
  // it flowed through to a "TOTAL NaN invocations" preflight and a RangeError later.
  if (!Number.isInteger(v) || v < 1) throw new RegistrationError([`${flag} must be a positive integer, got "${raw}"`]);
  return v;
}

// The isolation root for a run is the repository that contains the registration, not
// the registration directory itself. A suite that lives in a subdirectory of a larger
// repo (the real worked example is cobra-skill/eval/, inside the cobra-skill repo)
// needs sandboxes kept out of the whole repository, not merely out of eval/ -- a
// sandbox created as a sibling of eval/ but still inside cobra-skill/ would pass an
// isolation check scoped to eval/ while still letting the control arm see the
// installed skill. Walk up from the registration dir to the nearest ancestor
// containing a .git entry; a suite that lives outside any repository falls back to
// the registration dir itself.
export function findRepoRoot(dir) {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return resolve(dir);
    cur = parent;
  }
}

export function parseArgs(argv) {
  const out = { dir: ".", reps: null, model: null, judgeModel: null, taskIds: [], yes: false, dryRun: false, skill: null, costPerCall: 0.02 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reps") out.reps = intArg(argv[++i], "--reps");
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--judge-model") out.judgeModel = argv[++i];
    else if (a === "--task") out.taskIds.push(argv[++i]);
    else if (a === "--skill") out.skill = argv[++i];
    else if (a === "--cost-per-call") out.costPerCall = Number(argv[++i]);
    else if (a === "--yes") out.yes = true;
    else if (a === "--dry-run") out.dryRun = true;
    else rest.push(a);
  }
  if (rest.length) out.dir = rest[0];
  return out;
}

export function plan(registration, requested, canaryCount = 0) {
  const byId = new Map(registration.tasks.map((t) => [t.id, t]));
  const chosen = requested.taskIds.map((id) => byId.get(id));
  const subjectRuns = chosen.length * 2 * requested.reps;
  const judgeRuns = chosen.filter((t) => t.spec.verify.type === "judge").length * 2 * requested.reps;
  return { subjectRuns, judgeRuns, canaryRuns: canaryCount, total: subjectRuns + judgeRuns + canaryCount };
}

function confirm(stdin, stdout, question) {
  return new Promise((res) => {
    stdout.write(question);
    stdin.setEncoding("utf8");
    stdin.once("data", (d) => res(/^\s*y(es)?\s*$/i.test(String(d))));
  });
}

export async function main(argv, { stdout = process.stdout, stdin = process.stdin } = {}) {
  const args = parseArgs(argv);
  const dir = resolve(args.dir);
  const repoRoot = findRepoRoot(dir);

  let registration;
  try {
    registration = loadRegistration(dir);
  } catch (e) {
    if (e instanceof RegistrationError) { stdout.write(`${e.message}\n`); return 2; }
    throw e;
  }

  const requested = {
    reps: args.reps ?? registration.config.reps,
    model: args.model ?? registration.config.model,
    judgeModel: args.judgeModel ?? registration.config.judge_model,
    taskIds: args.taskIds.length ? args.taskIds : registration.tasks.map((t) => t.id),
  };

  // Structural, not drift: an unknown id and a missing SKILL.md both mean the run
  // cannot happen. Without these, --task nope threw a TypeError deep in plan(), and a
  // missing SKILL.md crashed AFTER the whole batch was paid for.
  const known = new Set(registration.tasks.map((t) => t.id));
  const unknown = requested.taskIds.filter((id) => !known.has(id));
  const skillFile = args.skill ? resolve(args.skill) : join(dir, "SKILL.md");
  const structural = [
    ...unknown.map((id) => `--task "${id}" is not in the registration`),
    ...(existsSync(skillFile) ? [] : [`no SKILL.md at ${skillFile}`]),
  ];
  if (structural.length) { stdout.write(new RegistrationError(structural).message + "\n"); return 2; }

  // Verifier patterns are cross-checked against SKILL.md here -- after the file is known
  // to exist, before the preflight prints, and well before anything is spent. A verbatim
  // lift is drift, not a structural failure: the run can happen, it just cannot be
  // confirmed. See patternDrift's header for what it checks and what it cannot.
  //
  // An unreadable-but-existing SKILL.md (a directory, say) is left alone deliberately.
  // The post-run leakage scan reads the same file and will surface it there; failing
  // here instead would change an established exit path for an unrelated reason.
  try {
    registration.drift.push(...patternDrift(registration.tasks, readFileSync(skillFile, "utf8")));
  } catch { /* unreadable SKILL.md: reported by the post-run scan, as before */ }

  // Canaries are loaded (and validated) here, before the dry-run return, not just
  // before they are run. A broken canaries.json -- one that still carries cobra's
  // "_comment" key, say -- would otherwise pass a free dry run and only abort once the
  // batch has been paid for. Loading is not the same as running: runCanaries is still
  // called later, only after --yes/confirm, exactly where it always was. A suite with
  // no canaries.json at all is not an error here -- that's the explicit un-gated state,
  // reported as a warning once the run actually starts, not a structural failure.
  const hasJudged = requested.taskIds.some(
    (id) => registration.tasks.find((t) => t.id === id).spec.verify.type === "judge");
  const cPath = join(dir, "canaries.json");
  let loadedCanaries = null;
  if (hasJudged && existsSync(cPath)) {
    try {
      loadedCanaries = loadCanaries(cPath, registration);
    } catch (e) {
      if (e instanceof RegistrationError) { stdout.write(`${e.message}\n`); return 2; }
      throw e;
    }
  }

  const p = plan(registration, requested, loadedCanaries ? loadedCanaries.length : 0);
  stdout.write(
    `nullbench — ${registration.tasks.length} registered task(s), running ${requested.taskIds.length}\n` +
    `  registration  ${registration.hash.slice(0, 16)}\n` +
    `  model         ${requested.model} (judge ${requested.judgeModel}), reps ${requested.reps}\n` +
    `  subject runs  ${p.subjectRuns}\n` +
    `  judge calls   ${p.judgeRuns}\n` +
    `  canary runs   ${p.canaryRuns}\n` +
    `  TOTAL         ${p.total} CLI invocations\n` +
    `  est. spend    ~$${(p.total * args.costPerCall).toFixed(2)} at an assumed ` +
    `$${args.costPerCall.toFixed(2)}/call — override with --cost-per-call\n`
  );
  if (registration.drift.length) {
    stdout.write(`  drift detected — this run cannot be confirmatory:\n`);
    for (const d of registration.drift) stdout.write(`    - ${d.detail}\n`);
  }
  if (args.dryRun) return 0;
  if (!args.yes && !(await confirm(stdin, stdout, "Proceed? [y/N] "))) {
    stdout.write("aborted\n");
    return 0;
  }

  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const outDir = join(dir, "results", stamp.replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });

  let canary = null;
  if (hasJudged) {
    if (!loadedCanaries) {
      stdout.write(`\nThis suite has judge-graded tasks but no canaries.json.\n` +
        `An ungated judge is an unverified safeguard; judged results cannot be confirmed.\n`);
      canary = { ok: false, misgrades: [{ id: "missing", why: "no canaries.json" }], total: 0 };
    } else {
      const canarySandbox = mkdtempSync(join(tmpdir(), "nullbench-canary-"));
      const iso = assertIsolated(canarySandbox, repoRoot);
      if (!iso.ok) throw new Error(`canary sandbox is not isolated:\n  - ${iso.problems.join("\n  - ")}`);
      canary = await runCanaries({
        canaries: loadedCanaries, model: requested.judgeModel, cwd: canarySandbox });
      rmSync(canarySandbox, { recursive: true, force: true });
      stdout.write(`judge canaries: ${canary.total - canary.misgrades.length}/${canary.total} correct\n`);
    }
  }

  const { records } = await runSuite({
    registration, requested, skillFile, fixtureRoot: dir, repoRoot, rawDir: join(outDir, "raw"),
    onProgress: (done, total, name, pass) =>
      stdout.write(`\r  ${done}/${total}  ${pass ? "PASS" : "FAIL"}  ${name.padEnd(42)}`),
  });
  stdout.write("\n\n");

  const counts = gradedCounts(records);
  const { klass, reasons } = classify({
    registration, requested, gradedCounts: counts, canaryOk: canary ? canary.ok : null });
  const rows = klass === "VOID" ? [] : aggregate(records, registration.tasks.filter((t) => requested.taskIds.includes(t.id)));

  // Everything from here can throw, and by now the batch has been paid for. The ledger
  // append runs in `finally` so a crash cannot quietly delete a run from the record --
  // the file drawer is the failure this project is named after.
  let md = `# nullbench report — ${klass}\n\n(report rendering failed; see records.json)\n`;
  const warnings = [];
  try {
    const terms = distinctiveTerms(readFileSync(skillFile, "utf8"));
    const leak = scanControlLeakage({ rawDir: join(outDir, "raw"), terms });
    if (leak.suspicious) {
      warnings.push(
        `possible control-arm leakage: ${leak.hits}/${leak.checked} control replies contain ` +
        `the skill's distinctive vocabulary. A weak heuristic, not proof — see FAILURES.md entry 5.`);
    }
    md = renderReport({ rows, klass, reasons, warnings, registration, requested, hash: registration.hash, canary });
    writeFileSync(join(outDir, "report.md"), md);
    writeFileSync(join(outDir, "records.json"), JSON.stringify({ stamp, hash: registration.hash, klass, requested, records }, null, 2));
  } finally {
    appendEntry(join(dir, "LEDGER.md"), { stamp, klass, hash: registration.hash, requested, rows, reasons: [...reasons, ...warnings] });
  }

  stdout.write(`${md}\n`);
  stdout.write(`Report: ${join(outDir, "report.md")}\nLedger: ${join(dir, "LEDGER.md")}\n`);
  return klass === "VOID" ? 1 : 0;
}
