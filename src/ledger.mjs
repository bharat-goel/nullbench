// The append-only run ledger.
//
// Every run lands here: confirmatory, exploratory, void, and flat. There is no code
// path that runs an evaluation and does not append, which is the point -- three of the
// four batches behind cobra's published table were discarded, and nothing recorded
// that they had happened. A published delta means something when a reader can see the
// runs that did not make the README.

import { appendFileSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { pp, averageDelta } from "./report.mjs";

const HEADING = `# Run ledger

Every nullbench run in this repository, in order, including runs that were voided,
exploratory, or showed nothing. Appended automatically; do not edit by hand.
`;

// A prediction is a HIT when the observed interval agrees with what was declared:
// "helps" needs an interval entirely above zero, "harms" entirely below, "no-effect"
// needs an interval that spans zero.
function score(row) {
  const above = row.ci.lo > 0;
  const below = row.ci.hi < 0;
  if (row.predict === "helps") return above ? "HIT" : "MISS";
  if (row.predict === "harms") return below ? "HIT" : "MISS";
  return !above && !below ? "HIT" : "MISS";
}

export function appendEntry(path, { stamp, klass, hash, requested, rows, reasons, resume = null }) {
  if (!existsSync(path)) {
    writeFileSync(path, HEADING);
  } else {
    const content = readFileSync(path, "utf8");
    if (!content.includes("# Run ledger")) {
      writeFileSync(path, HEADING + content);
    }
  }

  const L = [];
  L.push("");
  // A resume is its own entry, never an edit to the one it resumes: the earlier entry
  // (usually VOID) stays exactly as it was, and this one links back to it.
  L.push(`## ${stamp} · ${klass} · H=${hash.slice(0, 16)}${resume ? ` · resumes ${resume.of}` : ""}`);
  L.push("```");
  L.push(`model=${requested.model} judge=${requested.judgeModel} reps=${requested.reps}`);
  if (resume) {
    L.push(`resume: of=${resume.of} origin=${resume.origin} reattempted=${resume.reattempted} canaries=re-run`);
    L.push(`contributing: ${resume.contributions.map((c) => `${c.stamp} (${c.graded} graded)`).join(", ")}`);
    if (!resume.priorComplete) L.push(`note: ${resume.of} never completed and has no ledger entry of its own; its graded runs are counted here`);
  }
  for (const r of rows) {
    const note = r.discriminating ? "" : "  (non-discriminating)";
    L.push(
      `${r.id.padEnd(24)} ${r.kind.padEnd(6)} predict=${r.predict.padEnd(9)} ` +
      `${String(r.control.k).padStart(3)}/${r.control.n} -> ${String(r.treatment.k).padStart(3)}/${r.treatment.n}  ` +
      `${pp(r.delta).padStart(8)} [${pp(r.ci.lo)}, ${pp(r.ci.hi)}]  ${score(r)}${note}`
    );
  }
  if (rows.length) {
    const avg = averageDelta(rows);
    L.push(avg.suppressed || klass !== "CONFIRMATORY"
      ? `average across signal tasks: suppressed — ${klass !== "CONFIRMATORY" ? `run is ${klass.toLowerCase()}` : avg.why}`
      : `average across discriminating signal tasks: ${pp(avg.value)} (no interval — see per-task rows)`);
  }
  for (const r of reasons) L.push(`note: ${r}`);
  L.push("```");
  L.push("");

  const text = L.join("\n");
  appendFileSync(path, text);
  return text;
}
