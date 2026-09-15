// Deterministic verifiers. Every decision is a substring test over the raw reply, and
// the raw reply is written to disk by the runner, so any verdict can be re-checked by
// hand later.
//
// Substring verifiers are dangerous and this module cannot fix that -- see FAILURES.md
// entries 1 and 2, where "weaken" and "miss" produced a +70.0pp artefact and a 40pp
// understatement respectively. Behaviours with many valid phrasings belong in the
// rubric judge, not here.

// A reply that says "don't investigate yet, stabilise first" mentions diagnosis before
// rollback while advocating the opposite. Naive ordering marks the better answer wrong.
const NEGATIONS = [
  // "not " is word-anchored with a leading space: without it, "you cannot roll back"
  // reads as a negated rollback because "cannot " contains "not ".
  "don't", "do not", " not ", "never", "avoid", "rather than", "instead of",
  "without", "no need to", "before you", "premature", "resist", "skip",
  "hold off", "defer", "later", "only once", "only after", "after you",
];

// Index of the earliest occurrence of any pattern that is not preceded by a negation
// cue within `window` characters. -1 when every occurrence is negated or absent.
function firstUnnegated(hay, pats, window = 45) {
  let best = -1;
  for (const p of pats) {
    const needle = p.toLowerCase();
    let from = 0;
    for (;;) {
      const i = hay.indexOf(needle, from);
      if (i === -1) break;
      // Look back only as far as the current sentence. Without this, "Don't
      // investigate yet. Roll back, then investigate." has its rollback treated as
      // negated by the "don't" in the previous sentence, and the reply scores as
      // proposing no stabilising action at all.
      let ctx = hay.slice(Math.max(0, i - window), i);
      const bound = Math.max(ctx.lastIndexOf("."), ctx.lastIndexOf("!"), ctx.lastIndexOf("?"), ctx.lastIndexOf("\n"));
      if (bound !== -1) ctx = ctx.slice(bound + 1);
      if (!NEGATIONS.some((n) => ctx.includes(n))) {
        if (best === -1 || i < best) best = i;
        break;
      }
      from = i + needle.length;
    }
  }
  return best;
}

export function verify(spec, output) {
  const hay = output.toLowerCase();
  const words = output.trim().split(/\s+/).filter(Boolean).length;

  if (spec.maxWords && words > spec.maxWords) {
    return { pass: false, why: `over length: ${words} > ${spec.maxWords} words` };
  }

  switch (spec.type) {
    case "any": {
      const hit = spec.patterns.find((p) => hay.includes(p.toLowerCase()));
      return hit ? { pass: true, why: `matched "${hit}"` }
                 : { pass: false, why: "no required pattern present" };
    }
    case "none": {
      const hit = spec.patterns.find((p) => hay.includes(p.toLowerCase()));
      return hit ? { pass: false, why: `leaked "${hit}"` }
                 : { pass: true, why: `clean (${words} words)` };
    }
    case "ordered": {
      const b = firstUnnegated(hay, spec.before);
      const a = firstUnnegated(hay, spec.after);
      if (b === -1) return { pass: false, why: "no stabilising action proposed" };
      if (a !== -1 && a < b) return { pass: false, why: "diagnosis proposed before stabilising" };
      return { pass: true, why: "stabilise precedes diagnose" };
    }
    case "judge":
      throw new Error("judge specs are graded asynchronously, not through verify()");
    default:
      throw new Error(`unknown verifier type: ${spec.type}`);
  }
}
