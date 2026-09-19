import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJSON } from "../src/canonical.mjs";

test("key order does not change the serialization", () => {
  const a = { model: "sonnet", reps: 10, judge_model: "sonnet" };
  const b = { reps: 10, judge_model: "sonnet", model: "sonnet" };
  assert.equal(canonicalJSON(a), canonicalJSON(b));
  assert.equal(canonicalJSON(a), '{"judge_model":"sonnet","model":"sonnet","reps":10}');
});

test("whitespace and indentation do not survive a round trip", () => {
  const pretty = JSON.parse('{\n  "b": 1,\n  "a": [ 2, 3 ]\n}');
  assert.equal(canonicalJSON(pretty), '{"a":[2,3],"b":1}');
});

test("array order is preserved because it is meaningful", () => {
  assert.equal(canonicalJSON({ t: ["b", "a"] }), '{"t":["b","a"]}');
});

test("nested objects are sorted at every level", () => {
  const v = { z: { d: 1, c: 2 }, a: 3 };
  assert.equal(canonicalJSON(v), '{"a":3,"z":{"c":2,"d":1}}');
});

test("values with no canonical form are rejected, not silently dropped", () => {
  assert.throws(() => canonicalJSON({ a: NaN }), TypeError);
  assert.throws(() => canonicalJSON({ a: Infinity }), TypeError);
  assert.throws(() => canonicalJSON({ a: undefined }), TypeError);
  assert.throws(() => canonicalJSON({ a: () => {} }), TypeError);
});

test("null is a legitimate value and survives", () => {
  assert.equal(canonicalJSON({ a: null }), '{"a":null}');
});
