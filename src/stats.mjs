// Interval estimation for paired pass-rate comparisons.
//
// Point estimates are the reason this project exists. A delta of +80pp from ten runs
// per arm and a delta of +80pp from a hundred are the same number and different
// evidence, and reporting them identically is how a small-sample artefact becomes a
// published finding -- see FAILURES.md entry 7, where an effect measured -25.0pp at
// n=8 settled at -5.0pp by n=20. Every consumer of this module reports the interval.

const Z95 = 1.96;

// Wilson score interval. Preferred over the normal approximation because it stays
// inside [0,1] and remains sane at k=0 and k=n, which are exactly the cells a ceiling
// task produces and the cells that matter most here.
export function wilson(k, n, z = Z95) {
  if (!Number.isFinite(k) || !Number.isFinite(n)) throw new RangeError("k and n must be finite");
  if (n < 1) throw new RangeError(`n must be at least 1, got ${n}`);
  if (k < 0 || k > n) throw new RangeError(`k must be within [0, ${n}], got ${k}`);
  const z2 = z * z;
  const d = n + z2;
  const centre = (k + z2 / 2) / d;
  const half = (z / d) * Math.sqrt((k * (n - k)) / n + z2 / 4);
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// Newcombe's method 10 for the difference of two independent proportions: take each
// arm's Wilson interval and square-and-add the distances to the relevant bounds. Chosen
// over a Wald interval on the difference for the same reason as above -- it does not
// collapse to zero width when an arm sits at 0% or 100%.
export function newcombe(kC, nC, kT, nT, z = Z95) {
  const pC = kC / nC;
  const pT = kT / nT;
  const c = wilson(kC, nC, z);
  const t = wilson(kT, nT, z);
  const delta = pT - pC;
  return {
    lo: delta - Math.sqrt((pT - t.lo) ** 2 + (c.hi - pC) ** 2),
    hi: delta + Math.sqrt((t.hi - pT) ** 2 + (pC - c.lo) ** 2),
  };
}

// An interval that touches zero does not discriminate. Zero itself counts as touching:
// a bound of exactly 0.0 is not evidence of an effect.
export function discriminates({ lo, hi }) {
  return lo > 0 || hi < 0;
}
