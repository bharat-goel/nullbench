// Flag parsing, cost preflight, orchestration, exit codes.

import { mkdirSync, writeFileSync, existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { loadRegistration, patternDrift, RegistrationError } from "./prereg.mjs";
import { runSuite, gradedCounts } from "./runner.mjs";
import { runCanaries, loadCanaries } from "./judge.mjs";
import { classify } from "./classify.mjs";
import { aggregate, renderReport } from "./report.mjs";
import { appendEntry } from "./ledger.mjs";
import { binaryPath } from "./claude.mjs";
import { distinctiveTermsForSkill, scanControlLeakage, assertIsolated } from "./leakage.mjs";
import { combinedSkillText, skillFilePaths } from "./skill.mjs";

// A value-taking flag in final position reads `undefined` and used to fall back to the
// registered value in silence -- `nullbench . --model` ran the registered model and said
// nothing. Every flag below routes its operand through here first.
function operand(raw, flag) {
  if (raw === undefined) throw new RegistrationError([`${flag} requires a value`]);
  return raw;
}

// The float sibling of intArg. --cost-per-call abc printed "est. spend ~$NaN at an
// assumed $NaN/call"; intArg existed precisely because a NaN reached the preflight once
// before, and this flag never got the same treatment.
function floatArg(raw, flag) {
  const v = Number(operand(raw, flag));
  if (!Number.isFinite(v) || v < 0) throw new RegistrationError([`${flag} must be a non-negative number, got "${raw}"`]);
  return v;
}

function intArg(raw, flag) {
  const v = Number(operand(raw, flag));
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
  const out = { dir: ".", reps: null, model: null, judgeModel: null, taskIds: [], yes: false, dryRun: false, skill: null, costPerCall: 0.02, concurrency: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reps") out.reps = intArg(argv[++i], "--reps");
    else if (a === "--model") out.model = operand(argv[++i], "--model");
    else if (a === "--judge-model") out.judgeModel = operand(argv[++i], "--judge-model");
    else if (a === "--task") out.taskIds.push(operand(argv[++i], "--task"));
    else if (a === "--skill") out.skill = operand(argv[++i], "--skill");
    else if (a === "--cost-per-call") out.costPerCall = floatArg(argv[++i], "--cost-per-call");
    else if (a === "--concurrency") out.concurrency = intArg(argv[++i], "--concurrency");
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

  // Resolved before loadRegistration: the skill is hashed into H, so the registration
  // must be loaded knowing which skill file will actually be injected. `null` here
  // (no --skill) lets loadRegistration itself pick between skill_dir and the default
  // SKILL.md -- it can't be precomputed here any more, because which one applies
  // depends on nullbench.json's own skill_dir field, not read until loadRegistration
  // parses it.
  const skillOverride = args.skill ? resolve(args.skill) : null;

  let registration;
  try {
    registration = loadRegistration(dir, skillOverride);
  } catch (e) {
    if (e instanceof RegistrationError) { stdout.write(`${e.message}\n`); return 2; }
    throw e;
  }
  const skill = registration.skill;

  const requested = {
    reps: args.reps ?? registration.config.reps,
    model: args.model ?? registration.config.model,
    judgeModel: args.judgeModel ?? registration.config.judge_model,
    taskIds: args.taskIds.length ? args.taskIds : registration.tasks.map((t) => t.id),
    // A --skill override swaps the thing under test. H already covers the substituted
    // file's contents, but a reader comparing two reports needs to see that the skill
    // came from somewhere other than the registered location.
    skillOverride,
    // Set only when NULLBENCH_CLAUDE_BIN replaced the hosted CLI. The model names above
    // are then the REGISTERED ones, not verified to be what answered: the 2026-09-18
    // bracket runs were answered by a local gemma model and recorded as "sonnet".
    // Recorded as the basename: enough to name the adapter, without writing the
    // operator's home-directory layout into a ledger that gets committed. A bare
    // `claude` is the hosted CLI itself, not an override.
    ...(process.env.NULLBENCH_CLAUDE_BIN && process.env.NULLBENCH_CLAUDE_BIN !== "claude"
      ? { backend: basename(binaryPath()) } : {}),
  };

  // Structural, not drift: an unknown id and a missing SKILL.md both mean the run
  // cannot happen. Without these, --task nope threw a TypeError deep in plan(), and a
  // missing SKILL.md crashed AFTER the whole batch was paid for. `skill.mdFile` is
  // <skill_dir>/SKILL.md for a directory skill, so this same check covers both shapes.
  const known = new Set(registration.tasks.map((t) => t.id));
  const unknown = requested.taskIds.filter((id) => !known.has(id));
  const structural = [
    ...unknown.map((id) => `--task "${id}" is not in the registration`),
    ...(existsSync(skill.mdFile) ? [] : [`no SKILL.md at ${skill.mdFile}`]),
  ];

  // A fixture is copied to the sandbox root, and treatment additionally copies the
  // skill directory to <sandbox>/skill/. A fixture that already has a top-level `skill`
  // entry would collide with that copy in a way indistinguishable from real leakage --
  // refused outright, same posture as assertIsolated's forbidden-name check, but kept
  // separate from it: that check runs on every sandbox including the one this project's
  // own treatment arm builds, and "skill" belongs there.
  //
  // Declared fixtures are checked here, at preflight, not when the worker first reaches
  // a task that needs one. makeCwd throws on a missing fixture and that throw aborts the
  // whole batch -- after the canaries have been paid for and, depending on scheduling,
  // after subject runs have too. A missing directory is knowable for free before any of
  // that. This cost a real run to find: the worked example aborted 13 canary calls in.
  const missingFixtures = [];
  for (const id of requested.taskIds) {
    const t = registration.tasks.find((x) => x.id === id);
    const fx = t?.spec?.fixture;
    if (!fx) continue;
    const fxDir = join(dir, fx);
    if (!existsSync(fxDir)) {
      missingFixtures.push(`task "${id}" declares fixture "${fx}", but ${fxDir} does not exist`);
    } else if (skill.kind === "dir" && existsSync(join(fxDir, "skill"))) {
      // Only meaningful when treatment will actually copy something to <sandbox>/skill/
      // -- a suite with no skill_dir never does that, so a fixture's own "skill" entry
      // cannot collide with anything.
      missingFixtures.push(`task "${id}" fixture "${fx}" has a top-level "skill" entry, which collides with the injected skill directory`);
    } else {
      // runner.mjs's makeCwd copies this exact directory into a fresh sandbox and calls
      // assertIsolated on the copy before any invocation runs. That check used to run
      // only at makeCwd time, i.e. mid-batch: a fixture that fails it gets its judge
      // canaries paid for first, then aborts the whole batch the moment the first
      // subject job reaches it (skill-audit Task 5's otel-go review, finding C-1 --
      // "the fixture is refused at run time, and the preflight does not catch it").
      // Reproduce that exact check here, against a throwaway copy, so the same fixture
      // that would abort mid-run fails structurally (exit 2) instead, before anything
      // is spent. isolation is checked against repoRoot, matching makeCwd's own call.
      const probe = mkdtempSync(join(tmpdir(), "nullbench-fx-preflight-"));
      try {
        cpSync(fxDir, probe, { recursive: true });
        const iso = assertIsolated(probe, repoRoot);
        if (!iso.ok) {
          missingFixtures.push(`task "${id}" fixture "${fx}" is not isolated:\n    - ${iso.problems.join("\n    - ")}`);
        }
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
    }
  }
  if (structural.length || missingFixtures.length) {
    stdout.write(new RegistrationError([...structural, ...missingFixtures]).message + "\n");
    return 2;
  }

  // Verifier patterns are cross-checked against every text file the treatment arm can
  // see here -- after the skill is known to exist, before the preflight prints, and
  // well before anything is spent. A verbatim lift is drift, not a structural failure:
  // the run can happen, it just cannot be confirmed. See patternDrift's header for what
  // it checks and what it cannot; combinedSkillText covers only SKILL.md for a
  // single-file skill, and every file under skill_dir for a directory one, since an
  // answer key can sit in a reference file just as easily.
  //
  // An unreadable-but-existing SKILL.md (a directory, say) is left alone deliberately.
  // The post-run leakage scan reads the same file and will surface it there; failing
  // here instead would change an established exit path for an unrelated reason.
  try {
    registration.drift.push(...patternDrift(
      registration.tasks, combinedSkillText(skill), skill.kind === "dir" ? "skill_dir" : "SKILL.md"));
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
  // v1 is the default and stays byte-identical to the H every existing registration was
  // frozen under -- so say plainly what it does not name, whenever there is something
  // it could have named.
  const hasFixture = registration.tasks.some((t) => typeof t.spec?.fixture === "string");
  if (registration.hVersion === 1 && (hasFixture || existsSync(cPath))) {
    stdout.write(`  note          H (v1) does not cover ${[hasFixture && "fixture contents", existsSync(cPath) && "canaries.json"].filter(Boolean).join(" or ")}; ` +
      `set "h_version": 2 in nullbench.json to include them\n`);
  }
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
      // runCanaries mkdtemps, isolation-checks and removes one sandbox per canary call.
      canary = await runCanaries({
        canaries: loadedCanaries, model: requested.judgeModel, repoRoot });
      // Report graded separately from dead. "7/13 correct" for a batch where six calls
      // never reached the model reads as a judge that misgraded half its cases.
      stdout.write(`judge canaries: ${canary.graded - canary.misgrades.length}/${canary.graded} correct` +
        (canary.dead?.length ? ` (${canary.dead.length} of ${canary.total} never answered — the judge could not be verified)` : "") + `\n`);
    }
  }

  const { records } = await runSuite({
    registration, requested, skillFile: skill, fixtureRoot: dir, repoRoot, rawDir: join(outDir, "raw"),
    // Default 4 suits a hosted endpoint. A local model behind LM Studio drops
    // connections under it -- observed as `fetch failed` on 39 of 40 calls, which is a
    // VOID report rather than a wrong number, but still a wasted run. --concurrency 1
    // is the right setting for a single local GPU.
    ...(args.concurrency ? { concurrency: args.concurrency } : {}),
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
    // combinedSkillText's return value isn't used here -- distinctiveTermsForSkill
    // re-reads every file itself, per-file, so frontmatter stripping isn't lost the way
    // concatenating first would lose it (only the first file's frontmatter would ever
    // strip). It's still called for its side effect: it's the one thing left that lets
    // an unreadable SKILL.md itself (a directory, in an existing regression test) throw
    // here rather than being silently absorbed -- distinctiveTermsForSkill tolerates a
    // bad path on any OTHER file in skill_dir, same as combinedSkillText does.
    combinedSkillText(skill);
    const terms = distinctiveTermsForSkill(skillFilePaths(skill));
    const leak = scanControlLeakage({ rawDir: join(outDir, "raw"), terms });
    if (leak.suspicious) {
      warnings.push(
        `possible control-arm leakage: ${leak.hits}/${leak.checked} control replies contain ` +
        `the skill's distinctive vocabulary. A weak heuristic, not proof — see FAILURES.md entry 5.`);
    }
    md = renderReport({ rows, klass, reasons, warnings, registration, requested, hash: registration.hash, canary });
    writeFileSync(join(outDir, "report.md"), md);
    // canary is saved whole -- which checks misgraded, what the judge said, which never
    // answered -- so the evidence a paid canary pass produced is not reduced to a count.
    writeFileSync(join(outDir, "records.json"), JSON.stringify({ stamp, hash: registration.hash, klass, requested, canary, records }, null, 2));
  } finally {
    appendEntry(join(dir, "LEDGER.md"), { stamp, klass, hash: registration.hash, requested, rows, reasons: [...reasons, ...warnings], canary });
  }

  stdout.write(`${md}\n`);
  stdout.write(`Report: ${join(outDir, "report.md")}\nLedger: ${join(dir, "LEDGER.md")}\n`);
  return klass === "VOID" ? 1 : 0;
}
