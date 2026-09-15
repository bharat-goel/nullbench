import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "../src/verify.mjs";

test("any: passes on a required pattern, fails without one", () => {
  const spec = { type: "any", patterns: ["denominator", "how many slipped"] };
  assert.equal(verify(spec, "What is the denominator here?").pass, true);
  assert.equal(verify(spec, "Sounds good, ship it.").pass, false);
});

test("none: a leaked pattern fails", () => {
  const spec = { type: "none", patterns: ["goodhart", "cobra"] };
  assert.equal(verify(spec, "A B-tree index orders keys.").pass, true);
  const bad = verify(spec, "This is a classic Goodhart situation.");
  assert.equal(bad.pass, false);
  assert.match(bad.why, /leaked/);
});

test("maxWords is enforced before the pattern check", () => {
  const spec = { type: "none", patterns: ["nope"], maxWords: 5 };
  const r = verify(spec, "one two three four five six");
  assert.equal(r.pass, false);
  assert.match(r.why, /over length/);
});

test("ordered: stabilise must precede diagnose", () => {
  const spec = { type: "ordered", before: ["roll back", "revert"], after: ["investigate", "root cause"] };
  assert.equal(verify(spec, "Roll back first, then investigate.").pass, true);
  assert.equal(verify(spec, "Investigate the root cause, then roll back.").pass, false);
});

test("ordered: a negated mention is not the real one", () => {
  // The bug this guards: "don't investigate yet" counts as diagnosing first unless
  // negation context is checked, which scored the better answer at -100pp.
  const spec = { type: "ordered", before: ["roll back"], after: ["investigate"] };
  const reply = "Don't investigate yet. Roll back to the last good build, then investigate.";
  assert.equal(verify(spec, reply).pass, true);
});

test("ordered: no stabilising action at all is a failure", () => {
  const spec = { type: "ordered", before: ["roll back"], after: ["investigate"] };
  assert.equal(verify(spec, "Just investigate it.").pass, false);
});

test("judge specs and unknown types throw rather than silently pass", () => {
  assert.throws(() => verify({ type: "judge", rubric: "x" }, "reply"), /judge/);
  assert.throws(() => verify({ type: "banana" }, "reply"), /unknown verifier/);
});
