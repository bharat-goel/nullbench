// ============================================================================
// THIS FILE HAS NEVER BEEN RUN.
//
// Every assertion below is untested code, not a verified result. It was written
// under a scope reduction that forbids invoking the real `claude` binary, running
// a live bracket, or inventing/copying any measured delta, interval, or pass rate.
// No number anywhere in this repository claims to come from this file.
//
// This suite requires real API access and real money (see test/live/README.md for
// the cost estimate). It is deliberately excluded from `npm test` -- it is reached
// only through `npm run verify:live`, which a human runs deliberately, on purpose,
// with billing enabled. Do not treat a green `npm test` as having exercised this
// file in any way.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli.mjs";
import { aggregate } from "../../src/report.mjs";
import { discriminates } from "../../src/stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// 30 minutes was enough against a hosted model. A local model on one GPU serializes
// every call -- measured at roughly 2m15s per reply for gemma-4-12b-qat -- so a
// 40-invocation fixture needs about 90 minutes and the old ceiling aborted it mid-run.
// An aborted run is not a failed bracket; it is no measurement at all, and it would be
// reported as the former. Override with NULLBENCH_LIVE_TIMEOUT_MS.
const TEST_TIMEOUT = Number(process.env.NULLBENCH_LIVE_TIMEOUT_MS || 14_400_000);

const capture = () => { let b = ""; return { stdout: { write: (s) => (b += s, true) }, text: () => b }; };

function latestRecords(dir) {
  const results = join(dir, "results");
  const newest = readdirSync(results).sort().at(-1);
  return JSON.parse(readFileSync(join(results, newest, "records.json"), "utf8"));
}

test("PLACEBO: an irrelevant skill must produce a null", { timeout: TEST_TIMEOUT }, async () => {
  const dir = join(HERE, "fixtures", "placebo");
  await main([dir, "--yes"], capture());
  const { records } = latestRecords(dir);
  const rows = aggregate(records, [{ id: "reasoning", kind: "signal", predict: "no-effect" }]);
  // The loop below passes vacuously on an empty `rows` -- a renamed task id, or a batch
  // that graded nothing, would read as "the placebo produced a null" when in fact
  // nothing was measured at all. Assert we actually have the row before judging it.
  assert.equal(rows.length, 1, "expected exactly one aggregated row for the `reasoning` task; a placebo bracket that measured nothing must fail, not pass");
  for (const r of rows) {
    assert.equal(discriminates(r.ci), false,
      `a placebo skill produced a discriminating delta (${JSON.stringify(r.ci)}). ` +
      `The harness manufactures effects and nothing else it reports can be trusted.`);
  }
});

test("KNOWN POSITIVE: a trivially detectable effect must be detected", { timeout: TEST_TIMEOUT }, async () => {
  const dir = join(HERE, "fixtures", "positive");
  await main([dir, "--yes"], capture());
  const { records } = latestRecords(dir);
  const rows = aggregate(records, [{ id: "shape", kind: "signal", predict: "helps" }]);
  const row = rows[0];
  assert.equal(discriminates(row.ci), true,
    `a known-positive skill was not detected (${JSON.stringify(row.ci)}). ` +
    `A harness that reports null for everything passes the placebo test perfectly.`);
  assert.ok(row.delta > 0);
});
