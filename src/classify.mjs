// The protocol's decision procedure.
//
// Three outcomes, and the difference between the last two is the point of the project:
//
//   CONFIRMATORY -- what ran is exactly what was registered, and enough of it graded.
//   EXPLORATORY  -- the registration did not hold. Legitimate and expected; finding a
//                   discriminating task requires iteration. The numbers still print;
//                   the average does not.
//   VOID         -- too few graded runs for the numbers to mean anything. A data
//                   problem, not a registration problem, so it is not merely
//                   "exploratory" -- nothing is reported at all.
//
// VOID takes precedence. A batch that is both drifted and 83% dead is void: the
// registration question is moot when there is no data to classify.

export function minGraded(reps) {
  return Math.max(3, Math.ceil(reps * 0.8));
}

export function classify({ registration, requested, gradedCounts, canaryOk }) {
  const floor = minGraded(requested.reps);

  const thin = [];
  for (const id of requested.taskIds) {
    const c = gradedCounts[id] ?? { control: 0, treatment: 0 };
    for (const arm of ["control", "treatment"]) {
      if (c[arm] < floor) thin.push(`task "${id}" ${arm}: ${c[arm]} graded runs, ${floor} required`);
    }
  }
  if (thin.length) return { klass: "VOID", reasons: thin };

  const reasons = [];
  for (const d of registration.drift) reasons.push(d.detail);

  const registered = [...registration.tasks.map((t) => t.id)].sort().join(",");
  const ran = [...requested.taskIds].sort().join(",");
  if (registered !== ran) {
    reasons.push(`task set differs from the registration: registered [${registered}], ran [${ran}]`);
  }
  if (requested.reps !== registration.config.reps) {
    reasons.push(`reps differ: registered ${registration.config.reps}, ran ${requested.reps}`);
  }
  if (requested.model !== registration.config.model) {
    reasons.push(`model differs: registered ${registration.config.model}, ran ${requested.model}`);
  }
  if (requested.judgeModel !== registration.config.judge_model) {
    reasons.push(`judge model differs: registered ${registration.config.judge_model}, ran ${requested.judgeModel}`);
  }
  if (requested.skillOverride) {
    reasons.push(`skill differs: registered SKILL.md in the suite directory, ran ${requested.skillOverride}`);
  }
  if (canaryOk === false) reasons.push("judge canaries misgraded; judged tasks cannot be confirmed");

  return { klass: reasons.length ? "EXPLORATORY" : "CONFIRMATORY", reasons };
}
