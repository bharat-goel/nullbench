import { test } from "node:test";
import assert from "node:assert/strict";
import { wilson, newcombe, discriminates } from "../src/stats.mjs";

const near = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);

test("wilson matches reference values at 95%", () => {
  const cases = [
    [0, 10, 0.0, 0.277540],
    [10, 10, 0.722460, 1.0],
    [1, 10, 0.017876, 0.404156],
    [9, 10, 0.595844, 0.982124],
    [19, 20, 0.763864, 0.991119],
    [18, 20, 0.698962, 0.972134],
  ];
  for (const [k, n, lo, hi] of cases) {
    const w = wilson(k, n);
    near(w.lo, lo);
    near(w.hi, hi);
  }
});

test("wilson clamps to [0,1] rather than emitting impossible proportions", () => {
  const a = wilson(0, 10);
  const b = wilson(10, 10);
  assert.equal(a.lo, 0);
  assert.equal(b.hi, 1);
});

test("wilson rejects impossible inputs instead of returning NaN", () => {
  assert.throws(() => wilson(0, 0), RangeError);
  assert.throws(() => wilson(-1, 10), RangeError);
  assert.throws(() => wilson(11, 10), RangeError);
});

test("newcombe reproduces the three cobra cells from spec 5.4", () => {
  // ic-smoke-denominator: the one task that carries the published average.
  const smoke = newcombe(1, 10, 9, 10);
  near(smoke.lo, 0.369858);
  near(smoke.hi, 0.916141);
  assert.equal(discriminates(smoke), true);

  // A ceiling task: both arms perfect, delta zero, interval wide.
  const ceiling = newcombe(10, 10, 10, 10);
  near(ceiling.lo, -0.277540);
  near(ceiling.hi, 0.277540);
  assert.equal(discriminates(ceiling), false);

  // ic-sound-measure, the negative control: -5pp, published as not significant.
  const sound = newcombe(19, 20, 18, 20);
  near(sound.lo, -0.255200);
  near(sound.hi, 0.149624);
  assert.equal(discriminates(sound), false);
});

test("discriminates is false for any interval touching zero", () => {
  assert.equal(discriminates({ lo: -0.1, hi: 0.3 }), false);
  assert.equal(discriminates({ lo: 0, hi: 0.3 }), false);
  assert.equal(discriminates({ lo: 0.1, hi: 0.3 }), true);
  assert.equal(discriminates({ lo: -0.3, hi: -0.1 }), true);
});
