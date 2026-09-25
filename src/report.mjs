// Aggregation and rendering.
//
// Two rules are enforced here rather than left to the author's judgement, because both
// have already failed in practice:
//
//   1. No delta is ever rendered without its interval.
//   2. No average is rendered over a suite where fewer than two signal tasks
//      discriminate. The published cobra figure of +26.7pp is (80 + 0 + 0) / 3, an
//      average across two tasks that were pinned at 100% in both arms and had no
//      headroom to show anything. See FAILURES.md entry 10.

import { wilson, newcombe, discriminates } from "./stats.mjs";

export function pp(proportion) {
  const v = proportion * 100;
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(1)}pp`;
}

const pct = (p) => Number.isNaN(p) ? "—" : `${(p * 100).toFixed(0)}%`;
const ci = (i) => `[${pp(i.lo)}, ${pp(i.hi)}]`;

export function aggregate(records, tasks) {
  return tasks.map((t) => {
    const arm = (cond) => {
      const rs = records.filter((r) => r.task === t.id && r.cond === cond && !r.failed);
      const k = rs.filter((r) => r.pass).length;
      const n = rs.length;
      return { k, n, rate: n ? k / n : NaN, ci: n ? wilson(k, n) : { lo: NaN, hi: NaN } };
    };
    const control = arm("control");
    const treatment = arm("treatment");
    // Guarded like the per-arm intervals above: newcombe calls wilson, which throws at
    // n < 1. Reachable whenever a task id is passed that produced no records.
    const interval = control.n && treatment.n
      ? newcombe(control.k, control.n, treatment.k, treatment.n)
      : { lo: NaN, hi: NaN };
    return {
      id: t.id, kind: t.kind, predict: t.predict, control, treatment,
      delta: treatment.rate - control.rate, ci: interval,
      discriminating: discriminates(interval),
    };
  });
}

export function averageDelta(rows) {
  const signal = rows.filter((r) => r.kind === "signal");
  const good = signal.filter((r) => r.discriminating);
  if (good.length < 2) {
    return {
      value: NaN, suppressed: true,
      why: `${good.length} of ${signal.length} signal tasks discriminate; an average over fewer than two is not a finding`,
    };
  }
  return { value: good.reduce((s, r) => s + r.delta, 0) / good.length, suppressed: false, why: "" };
}

const HEADERS = {
  CONFIRMATORY: "This run matches its registration exactly.",
  EXPLORATORY: "This run does not match its registration. Per-task figures are shown; the average is suppressed.",
  VOID: "Too few graded runs to report anything.",
};

export function renderReport({ rows, klass, reasons, warnings = [], requested, hash, canary, resume = null }) {
  const L = [];
  L.push(`# nullbench report — ${klass}`, "");
  L.push(HEADERS[klass], "");
  L.push(`Registration \`${hash.slice(0, 16)}\` · model \`${requested.model}\` · judge \`${requested.judgeModel}\` · reps ${requested.reps}`, "");

  // A resumed batch names every run that contributed records, before anything else, and
  // in a VOID report too -- a reader must be able to find every raw directory behind a
  // number, and tell a spliced batch from a single one. PROTOCOL.md §10.
  if (resume) {
    L.push("## Resumed batch", "");
    L.push(`This batch resumes \`${resume.of}\`. Only runs that produced no answer were re-attempted ` +
      `(${resume.reattempted} of them); every graded run, pass or fail, was carried forward unchanged. ` +
      `Records came from:`, "");
    const last = resume.contributions.length - 1;
    for (const [i, c] of resume.contributions.entries()) {
      const notes = [];
      if (i === last) notes.push("this run");
      if (c.stamp === resume.of && !resume.priorComplete) notes.push("never completed; it has no ledger entry of its own");
      L.push(`- \`${c.stamp}\` — ${c.graded} graded run(s)${notes.length ? ` (${notes.join("; ")})` : ""}`);
    }
    L.push("");
    if (canary?.carried) {
      const c = canary.carried;
      L.push(`Canaries were re-run in full on this resume` +
        (canary.total ? ` (${canary.graded - canary.misgrades.length}/${canary.graded} correct${canary.dead?.length ? `, ${canary.dead.length} never answered` : ""})` : "") +
        `, not carried forward. Earlier canary misgrades still count: ` +
        (c.misgrades.length ? c.misgrades.map((m) => `\`${m.stamp}\` ${m.id}`).join(", ") : "none") +
        (c.unverified ? `; no canary result was recorded for \`${c.stamp}\`, so its judged runs are unverified` : "") + ".", "");
    }
  }

  if (reasons.length) {
    L.push(`## Why this run is ${klass.toLowerCase()}`, "");
    for (const r of reasons) L.push(`- ${r}`);
    L.push("");
  }
  // Warnings are not reasons. A leakage suspicion under a heading reading "Why this run
  // is confirmatory" is nonsense, and the heuristic is too weak to change the class.
  if (warnings.length) {
    L.push("## Warnings", "");
    for (const w of warnings) L.push(`- ${w}`);
    L.push("");
  }
  if (klass === "VOID") return L.join("\n");

  const table = (kind, title) => {
    const rs = rows.filter((r) => r.kind === kind);
    if (!rs.length) return;
    L.push(`## ${title}`, "", "| Task | Predicted | Control | Treatment | Delta | 95% CI | |", "|---|---|---|---|---|---|---|");
    for (const r of rs) {
      const note = r.discriminating ? "" : "non-discriminating";
      L.push(`| \`${r.id}\` | ${r.predict} | ${pct(r.control.rate)} (${r.control.k}/${r.control.n}) | ${pct(r.treatment.rate)} (${r.treatment.k}/${r.treatment.n}) | ${pp(r.delta)} | ${ci(r.ci)} | ${note} |`);
    }
    L.push("");
  };
  table("signal", "Signal tasks — does the skill change the answer?");
  table("harm", "Harm tasks — does the skill stay quiet where it should?");

  const avg = averageDelta(rows);
  if (klass !== "CONFIRMATORY") {
    L.push(`**Average across signal tasks: suppressed** — this run is exploratory.`, "");
  } else if (avg.suppressed) {
    L.push(`**Average across signal tasks: suppressed** — ${avg.why}.`, "");
  } else {
    L.push(
      `**Average across discriminating signal tasks: ${pp(avg.value)}** ` +
      `(no interval — a mean of per-task deltas averages heterogeneous quantities and ` +
      `has no defined interval; read the per-task rows above)`, "");
  }

  if (canary) {
    L.push(canary.total === 0
      ? `Judge canaries: none found. An ungated judge is an unverified safeguard; judged tasks cannot be confirmed.`
      : `Judge canaries: ${canary.total - canary.misgrades.length}/${canary.total} graded correctly.`, "");
    // Spec 6 entry 3 is an OPEN failure mode and requires disclosure in every report
    // that used a judge. A blind spot shared by judge and subject cannot show up in a
    // canary, because canaries are hand-written to probe known failure modes.
    L.push(`**Known limitation:** the judge (\`${requested.judgeModel}\`) shares a model family with the ` +
      `subject (\`${requested.model}\`). A blind spot common to both would not be visible here, ` +
      `and the canaries cannot detect it. See FAILURES.md entry 3.`, "");
  }
  L.push("Predictions are recorded in `LEDGER.md` whether or not they were borne out.", "");
  return L.join("\n");
}
