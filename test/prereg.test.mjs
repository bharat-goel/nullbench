import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistration, RegistrationError } from "../src/prereg.mjs";
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
