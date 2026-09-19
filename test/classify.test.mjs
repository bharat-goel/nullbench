import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, minGraded } from "../src/classify.mjs";

const registration = {
  config: { model: "sonnet", judge_model: "sonnet", reps: 10 },
  tasks: [
    { id: "harm", kind: "harm", predict: "no-effect" },
    { id: "sig", kind: "signal", predict: "helps" },
  ],
  hash: "a".repeat(64),
  drift: [],
};
const requested = { reps: 10, model: "sonnet", judgeModel: "sonnet", taskIds: ["harm", "sig"] };
const full = { harm: { control: 10, treatment: 10 }, sig: { control: 10, treatment: 10 } };

test("minGraded floors at 3 and otherwise takes 80% of reps", () => {
  assert.equal(minGraded(1), 3);
  assert.equal(minGraded(3), 3);
  assert.equal(minGraded(10), 8);
  assert.equal(minGraded(20), 16);
});

test("a clean run is confirmatory", () => {
  const r = classify({ registration, requested, gradedCounts: full, canaryOk: null });
  assert.equal(r.klass, "CONFIRMATORY");
  assert.deepEqual(r.reasons, []);
});

test("a thin cell voids the batch, and void beats exploratory", () => {
  const thin = { harm: { control: 10, treatment: 10 }, sig: { control: 2, treatment: 10 } };
  const r = classify({
    registration: { ...registration, drift: [{ code: "HASH_MISMATCH", detail: "sig" }] },
    requested, gradedCounts: thin, canaryOk: null,
  });
  assert.equal(r.klass, "VOID");
  assert.ok(r.reasons.some((x) => /sig/.test(x) && /graded/.test(x)));
});

test("registration drift downgrades to exploratory", () => {
  const r = classify({
    registration: { ...registration, drift: [{ code: "HASH_MISMATCH", detail: "task \"sig\" changed" }] },
    requested, gradedCounts: full, canaryOk: null,
  });
  assert.equal(r.klass, "EXPLORATORY");
  assert.ok(r.reasons.some((x) => /changed/.test(x)));
});

test("running a subset of the registered tasks is exploratory", () => {
  const r = classify({
    registration, requested: { ...requested, taskIds: ["sig"] },
    gradedCounts: { sig: { control: 10, treatment: 10 } }, canaryOk: null,
  });
  assert.equal(r.klass, "EXPLORATORY");
  assert.ok(r.reasons.some((x) => /task set/.test(x)));
});

test("changing reps, model or judge model is exploratory", () => {
  for (const override of [{ reps: 3 }, { model: "opus" }, { judgeModel: "opus" }]) {
    const counts = { harm: { control: 3, treatment: 3 }, sig: { control: 3, treatment: 3 } };
    const r = classify({
      registration, requested: { ...requested, ...override },
      gradedCounts: override.reps ? counts : full, canaryOk: null,
    });
    assert.equal(r.klass, "EXPLORATORY", JSON.stringify(override));
  }
});

test("a failed canary is exploratory, not confirmatory", () => {
  const r = classify({ registration, requested, gradedCounts: full, canaryOk: false });
  assert.equal(r.klass, "EXPLORATORY");
  assert.ok(r.reasons.some((x) => /canar/i.test(x)));
});

test("a missing harm task blocks confirmation", () => {
  const noHarm = {
    ...registration,
    tasks: [{ id: "sig", kind: "signal", predict: "helps" }],
    drift: [{ code: "NO_HARM_TASK", detail: "no harm task; a suite with no negative control cannot be confirmatory" }],
  };
  const r = classify({
    registration: noHarm, requested: { ...requested, taskIds: ["sig"] },
    gradedCounts: { sig: { control: 10, treatment: 10 } }, canaryOk: null,
  });
  assert.equal(r.klass, "EXPLORATORY");
  assert.ok(r.reasons.some((x) => /negative control/.test(x)));
});

test("task-set comparison is order-insensitive (registration not alphabetical)", () => {
  const nonAlphabetical = {
    config: { model: "sonnet", judge_model: "sonnet", reps: 10 },
    tasks: [
      { id: "sig", kind: "signal", predict: "helps" },
      { id: "harm", kind: "harm", predict: "no-effect" },
    ],
    hash: "b".repeat(64),
    drift: [],
  };
  const r = classify({
    registration: nonAlphabetical,
    requested: { reps: 10, model: "sonnet", judgeModel: "sonnet", taskIds: ["harm", "sig"] },
    gradedCounts: { harm: { control: 10, treatment: 10 }, sig: { control: 10, treatment: 10 } },
    canaryOk: null,
  });
  assert.equal(r.klass, "CONFIRMATORY");
  assert.deepEqual(r.reasons, []);
});

test("a cell with exactly minGraded(reps) graded runs does not void", () => {
  const floor = minGraded(10);  // 8
  const borderline = { harm: { control: floor, treatment: 10 }, sig: { control: 10, treatment: 10 } };
  const r = classify({ registration, requested, gradedCounts: borderline, canaryOk: null });
  assert.equal(r.klass, "CONFIRMATORY");
  assert.deepEqual(r.reasons, []);
});

test("a cell with exactly minGraded(reps) - 1 graded runs voids", () => {
  const floor = minGraded(10);  // 8
  const tooThin = { harm: { control: floor - 1, treatment: 10 }, sig: { control: 10, treatment: 10 } };
  const r = classify({ registration, requested, gradedCounts: tooThin, canaryOk: null });
  assert.equal(r.klass, "VOID");
  assert.ok(r.reasons.some((x) => /harm/.test(x) && /graded/.test(x)));
});

test("changing reps, model or judge model adds reason matching the field", () => {
  for (const [override, field] of [[{ reps: 3 }, "reps"], [{ model: "opus" }, "model"], [{ judgeModel: "opus" }, "judge model"]]) {
    const counts = { harm: { control: 3, treatment: 3 }, sig: { control: 3, treatment: 3 } };
    const r = classify({
      registration, requested: { ...requested, ...override },
      gradedCounts: override.reps ? counts : full, canaryOk: null,
    });
    assert.equal(r.klass, "EXPLORATORY", JSON.stringify(override));
    assert.ok(r.reasons.some((x) => x.includes(field)), `reason must mention "${field}": got ${r.reasons}`);
  }
});
