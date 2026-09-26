import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistration, RegistrationError, patternDrift } from "../src/prereg.mjs";
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(s).digest("hex");

function makeSuite({ omitHarm = false, corruptSha = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nb-reg-"));
  mkdirSync(join(dir, "tasks"));

  const signal = JSON.stringify({
    id: "sig", skill: "demo", kind: "signal", prompt: "Is 3 caught enough?",
    verify: { type: "any", patterns: ["denominator"] },
  });
  writeFileSync(join(dir, "tasks", "sig.json"), signal);

  const harm = JSON.stringify({
    id: "harm", skill: "demo", kind: "harm", prompt: "B-tree vs GIN?",
    verify: { type: "none", patterns: ["goodhart"], maxWords: 500 },
  });
  writeFileSync(join(dir, "tasks", "harm.json"), harm);

  const tasks = [
    { id: "sig", file: "tasks/sig.json", sha256: corruptSha ? "0".repeat(64) : sha(signal), kind: "signal", predict: "helps" },
  ];
  if (!omitHarm) {
    tasks.push({ id: "harm", file: "tasks/harm.json", sha256: sha(harm), kind: "harm", predict: "no-effect" });
  }
  writeFileSync(join(dir, "nullbench.json"),
    JSON.stringify({ model: "sonnet", judge_model: "sonnet", reps: 10, tasks }, null, 2));
  return dir;
}

test("a well-formed registration loads with no drift", () => {
  const dir = makeSuite();
  const r = loadRegistration(dir);
  assert.equal(r.drift.length, 0);
  assert.equal(r.config.reps, 10);
  assert.deepEqual(r.tasks.map((t) => t.id), ["harm", "sig"]); // sorted by id
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  rmSync(dir, { recursive: true, force: true });
});

test("the hash is stable across reformatting of nullbench.json", () => {
  const dir = makeSuite();
  const before = loadRegistration(dir).hash;
  const raw = JSON.parse(readFileSync(join(dir, "nullbench.json"), "utf8"));
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify(raw)); // minified
  assert.equal(loadRegistration(dir).hash, before);
  rmSync(dir, { recursive: true, force: true });
});

test("the hash is stable across key reordering and task-array reordering", () => {
  const dir = makeSuite();
  const before = loadRegistration(dir).hash;
  const raw = JSON.parse(readFileSync(join(dir, "nullbench.json"), "utf8"));

  // Reorder top-level keys and reverse the tasks array order.
  const reordered = { tasks: [...raw.tasks].reverse(), reps: raw.reps, judge_model: raw.judge_model, model: raw.model };
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify(reordered));

  assert.equal(loadRegistration(dir).hash, before);
  rmSync(dir, { recursive: true, force: true });
});

test("the hash changes when a task file changes", () => {
  const dir = makeSuite();
  const before = loadRegistration(dir).hash;
  writeFileSync(join(dir, "tasks", "sig.json"),
    JSON.stringify({ id: "sig", skill: "demo", kind: "signal", prompt: "different",
      verify: { type: "any", patterns: ["x"] } }));
  assert.notEqual(loadRegistration(dir).hash, before);
  rmSync(dir, { recursive: true, force: true });
});

test("a task file that no longer matches its declared hash is drift, not a crash", () => {
  const dir = makeSuite({ corruptSha: true });
  const r = loadRegistration(dir);
  assert.equal(r.drift.length, 1);
  assert.equal(r.drift[0].code, "HASH_MISMATCH");
  assert.match(r.drift[0].detail, /sig/);
  rmSync(dir, { recursive: true, force: true });
});

test("a suite with no harm task is drift, because it cannot be confirmatory", () => {
  const dir = makeSuite({ omitHarm: true });
  const r = loadRegistration(dir);
  assert.deepEqual(r.drift.map((d) => d.code), ["NO_HARM_TASK"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a task file that is actually a directory aborts with RegistrationError, not EISDIR", () => {
  const dir = makeSuite();
  mkdirSync(join(dir, "tasks", "not-a-file.json"));
  const raw = JSON.parse(readFileSync(join(dir, "nullbench.json"), "utf8"));
  raw.tasks.push({ id: "dirtask", file: "tasks/not-a-file.json", sha256: "0".repeat(64), kind: "signal", predict: "helps" });
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify(raw));
  assert.throws(() => loadRegistration(dir), RegistrationError);
  rmSync(dir, { recursive: true, force: true });
});

test("structural problems abort rather than downgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-reg-"));
  assert.throws(() => loadRegistration(dir), RegistrationError); // no nullbench.json

  writeFileSync(join(dir, "nullbench.json"), "{ not json");
  assert.throws(() => loadRegistration(dir), RegistrationError);

  writeFileSync(join(dir, "nullbench.json"), JSON.stringify({ model: "sonnet" }));
  assert.throws(() => loadRegistration(dir), RegistrationError); // no reps, no tasks

  writeFileSync(join(dir, "nullbench.json"), JSON.stringify({
    model: "sonnet", judge_model: "sonnet", reps: 3,
    tasks: [{ id: "a", file: "nope.json", sha256: "0".repeat(64), kind: "signal", predict: "maybe" }],
  }));
  const e = (() => { try { loadRegistration(dir); } catch (x) { return x; } })();
  assert.ok(e instanceof RegistrationError);
  assert.ok(e.problems.some((p) => /predict/.test(p)), "bad enum reported");
  assert.ok(e.problems.some((p) => /nope\.json/.test(p)), "missing file reported");
  rmSync(dir, { recursive: true, force: true });
});

// SKILL.md is the experiment's independent variable. Before it entered H, editing it
// between registration and run changed nothing about the stamp, and `--skill` could
// substitute a different file entirely under the registered run's hash.
test("the registration hash covers SKILL.md, not just the task files", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-skillhash-"));
  mkdirSync(join(dir, "tasks"));
  const body = JSON.stringify({ id: "t", prompt: "p", verify: { type: "any", patterns: ["x"] } });
  writeFileSync(join(dir, "tasks", "t.json"), body);
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify({
    model: "sonnet", judge_model: "sonnet", reps: 4,
    tasks: [{
      id: "t", file: "tasks/t.json",
      sha256: createHash("sha256").update(body).digest("hex"),
      kind: "harm", predict: "no-effect",
    }],
  }));

  writeFileSync(join(dir, "SKILL.md"), "# one\n");
  const a = loadRegistration(dir);
  writeFileSync(join(dir, "SKILL.md"), "# two\n");
  const b = loadRegistration(dir);

  assert.deepEqual(a.drift, [], "changing only SKILL.md must not be task drift");
  assert.deepEqual(b.drift, []);
  assert.notEqual(a.hash, b.hash, "editing the skill must change the registration hash");

  // A missing skill hashes distinctly rather than colliding with any real skill.
  rmSync(join(dir, "SKILL.md"));
  assert.notEqual(loadRegistration(dir).hash, a.hash);
  assert.notEqual(loadRegistration(dir).hash, b.hash);

  rmSync(dir, { recursive: true, force: true });
});

// Regression pin: computed on the pre-skill_dir code (see nullbench-skilldir-report.md).
// If this ever changes, the skill_dir refactor moved H for a registration that never
// mentions skill_dir at all -- exactly what item 1 of the brief forbids.
test("skill_dir absent: H is byte-identical to the pinned pre-skill_dir value", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-pin-"));
  mkdirSync(join(dir, "tasks"));
  const signal = JSON.stringify({ id: "sig", skill: "demo", kind: "signal", prompt: "Is 3 caught enough?", verify: { type: "any", patterns: ["denominator"] } });
  writeFileSync(join(dir, "tasks", "sig.json"), signal);
  const harm = JSON.stringify({ id: "harm", skill: "demo", kind: "harm", prompt: "B-tree vs GIN?", verify: { type: "none", patterns: ["goodhart"], maxWords: 500 } });
  writeFileSync(join(dir, "tasks", "harm.json"), harm);
  const tasks = [
    { id: "sig", file: "tasks/sig.json", sha256: sha(signal), kind: "signal", predict: "helps" },
    { id: "harm", file: "tasks/harm.json", sha256: sha(harm), kind: "harm", predict: "no-effect" },
  ];
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify({ model: "sonnet", judge_model: "sonnet", reps: 10, tasks }, null, 2));
  writeFileSync(join(dir, "SKILL.md"), "# demo skill\npinned regression fixture, do not change bytes\n");
  assert.equal(loadRegistration(dir).hash, "0d8eca81ab61b751450b911d056eab3b56c297af3b033908a5e724950e734ab1");
  rmSync(dir, { recursive: true, force: true });
});

test("skill_dir present: the registration hash covers every file in it, not only SKILL.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-skilldir-"));
  mkdirSync(join(dir, "tasks"));
  const body = JSON.stringify({ id: "t", prompt: "p", verify: { type: "any", patterns: ["x"] } });
  writeFileSync(join(dir, "tasks", "t.json"), body);
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify({
    model: "sonnet", judge_model: "sonnet", reps: 4, skill_dir: "skill",
    tasks: [{ id: "t", file: "tasks/t.json", sha256: sha(body), kind: "harm", predict: "no-effect" }],
  }));
  mkdirSync(join(dir, "skill"));
  writeFileSync(join(dir, "skill", "SKILL.md"), "# demo\nsee references/foo.md");
  mkdirSync(join(dir, "skill", "references"));
  writeFileSync(join(dir, "skill", "references", "foo.md"), "reference content");

  const before = loadRegistration(dir).hash;
  writeFileSync(join(dir, "skill", "references", "foo.md"), "changed reference content");
  const after = loadRegistration(dir).hash;
  assert.notEqual(before, after, "editing a reference file, not SKILL.md itself, must move H");
  rmSync(dir, { recursive: true, force: true });
});

test("skill_dir present: a missing SKILL.md inside it is reported like today's missing-skill case", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-skilldir-nomd-"));
  mkdirSync(join(dir, "tasks"));
  const body = JSON.stringify({ id: "t", prompt: "p", verify: { type: "any", patterns: ["x"] } });
  writeFileSync(join(dir, "tasks", "t.json"), body);
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify({
    model: "sonnet", judge_model: "sonnet", reps: 4, skill_dir: "skill",
    tasks: [{ id: "t", file: "tasks/t.json", sha256: sha(body), kind: "harm", predict: "no-effect" }],
  }));
  mkdirSync(join(dir, "skill")); // no SKILL.md inside
  const r = loadRegistration(dir);
  assert.equal(r.skill.kind, "dir");
  assert.equal(r.hash, loadRegistration(dir).hash, "still loads; the CLI's own existence check reports the absence");
  rmSync(dir, { recursive: true, force: true });
});

test("skill_dir overlapping the tasks directory is a structural failure, wired through loadRegistration", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-skilldir-overlap-"));
  mkdirSync(join(dir, "tasks"));
  const body = JSON.stringify({ id: "t", prompt: "p", verify: { type: "any", patterns: ["x"] } });
  writeFileSync(join(dir, "tasks", "t.json"), body);
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify({
    model: "sonnet", judge_model: "sonnet", reps: 4, skill_dir: "tasks",
    tasks: [{ id: "t", file: "tasks/t.json", sha256: sha(body), kind: "harm", predict: "no-effect" }],
  }));
  assert.throws(() => loadRegistration(dir), (e) => {
    assert.ok(e instanceof RegistrationError);
    assert.match(e.message, /tasks\/t\.json/);
    return true;
  });
  rmSync(dir, { recursive: true, force: true });
});

// N2 (fix round 2), wired through loadRegistration: a skill_dir living inside a
// declared fixture directory used to slip through with no drift raised at all --
// makeCwd copies the WHOLE fixture into every arm's sandbox, control included, so this
// would have put SKILL.md and every reference file into the control arm too.
test("skill_dir nested inside a declared fixture is a structural failure, wired through loadRegistration", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-skilldir-fxoverlap-"));
  mkdirSync(join(dir, "tasks"));
  mkdirSync(join(dir, "a-fixture", "sk"), { recursive: true });
  const body = JSON.stringify({
    id: "fx", prompt: "p", fixture: "a-fixture", verify: { type: "any", patterns: ["x"] },
  });
  writeFileSync(join(dir, "tasks", "fx.json"), body);
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify({
    model: "sonnet", judge_model: "sonnet", reps: 4, skill_dir: "a-fixture/sk",
    tasks: [{ id: "fx", file: "tasks/fx.json", sha256: sha(body), kind: "harm", predict: "no-effect" }],
  }));
  assert.throws(() => loadRegistration(dir), (e) => {
    assert.ok(e instanceof RegistrationError);
    assert.match(e.message, /a-fixture/);
    return true;
  });
  rmSync(dir, { recursive: true, force: true });
});

test("skill_dir equal to the registration directory itself is a structural failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-skilldir-dot-"));
  mkdirSync(join(dir, "tasks"));
  const body = JSON.stringify({ id: "t", prompt: "p", verify: { type: "any", patterns: ["x"] } });
  writeFileSync(join(dir, "tasks", "t.json"), body);
  writeFileSync(join(dir, "nullbench.json"), JSON.stringify({
    model: "sonnet", judge_model: "sonnet", reps: 4, skill_dir: ".",
    tasks: [{ id: "t", file: "tasks/t.json", sha256: sha(body), kind: "harm", predict: "no-effect" }],
  }));
  assert.throws(() => loadRegistration(dir), RegistrationError);
  rmSync(dir, { recursive: true, force: true });
});

test("patternDrift names the actual source (SKILL.md by default, or a caller-supplied label)", () => {
  const tasks = [{ id: "sig", kind: "signal", spec: { verify: { type: "any", patterns: ["denominator"] } } }];
  const defaultLabel = patternDrift(tasks, "text mentioning denominator somewhere");
  assert.match(defaultLabel[0].detail, /appears verbatim in SKILL\.md/);

  const skillDirLabel = patternDrift(tasks, "text mentioning denominator somewhere", "skill_dir");
  assert.match(skillDirLabel[0].detail, /appears verbatim in skill_dir/);
  assert.doesNotMatch(skillDirLabel[0].detail, /SKILL\.md/);
});

test("a malformed task entry is a RegistrationError, not a TypeError escaping as exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-badtask-"));
  writeFileSync(join(dir, "SKILL.md"), "# s\n");
  for (const bad of [null, "a string", 42, ["an", "array"]]) {
    writeFileSync(join(dir, "nullbench.json"), JSON.stringify({
      model: "sonnet", judge_model: "sonnet", reps: 4, tasks: [bad],
    }));
    assert.throws(
      () => loadRegistration(dir),
      (e) => {
        assert.ok(e instanceof RegistrationError, `${JSON.stringify(bad)} threw ${e.constructor.name}, not RegistrationError`);
        assert.match(e.message, /tasks\[0\] must be an object/);
        return true;
      },
    );
  }
  rmSync(dir, { recursive: true, force: true });
});
