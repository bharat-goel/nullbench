#!/usr/bin/env node
// A fake `claude` binary. Replays scripted replies so the protocol layer can be tested
// with no network and no spend. Contract is documented in the v1 plan, Task 5.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const plan = JSON.parse(readFileSync(process.env.NULLBENCH_STUB_PLAN, "utf8"));
const statePath = process.env.NULLBENCH_STUB_STATE;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

const argv = process.argv.slice(2);
const arm = argv.includes("--append-system-prompt-file") ? "treatment" : "control";
const prompt = argv[argv.length - 1] ?? "";

const rule =
  (plan.rules ?? []).find(
    (r) => prompt.includes(r.promptIncludes) && (r.arm === "any" || r.arm === arm)
  ) ?? plan.default;

const key = rule === plan.default ? "__default__" : `${rule.promptIncludes}:${rule.arm}`;
const i = state[key] ?? 0;
state[key] = i + 1;
// Write-then-rename. Workers run concurrently against one state file; a partial write
// is read back as truncated JSON, the stub exits non-zero, and the runner records a
// dead run. Measured at roughly 30% of runs before this was made atomic.
const tmp = `${statePath}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify(state));
renameSync(tmp, statePath);

const outs = rule.outs ?? [""];
process.stdout.write(outs[i % outs.length]);
process.exit(rule.code ?? 0);
