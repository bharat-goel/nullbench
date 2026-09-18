// The only module in this project that spawns a process.
//
// Isolating it is what makes the protocol layer testable for free: tests point
// NULLBENCH_CLAUDE_BIN at a stub that replays recorded output, and every test outside
// test/live/ runs with no network and no API key.

import { spawn } from "node:child_process";

export function binaryPath() {
  return process.env.NULLBENCH_CLAUDE_BIN || "claude";
}

// Tools the SUBJECT is denied. Nothing in the protocol requires the subject to mutate
// its cwd: every verifier (any, ordered, none, judge) reads stdout and nothing else. A
// subject that can write leaves artifacts behind, and an artifact is only ever a
// contamination vector -- it can never improve a measurement. Belt to the per-run
// sandbox's braces in src/runner.mjs.
export const SUBJECT_DISALLOWED_TOOLS = ["Write", "Edit", "Bash"];

export function invoke({ prompt, systemPromptFile = null, cwd, model, streamJson = false, disallowedTools = null }) {
  const args = ["-p", "--setting-sources", "project", "--model", model];
  if (streamJson) args.push("--output-format", "stream-json", "--verbose");
  // Comma-separated, one argv entry, not `--disallowedTools Write Edit Bash`. The flag
  // is variadic and the prompt is pushed last as a positional, so a space-separated list
  // would let the flag swallow the prompt itself. UNVERIFIED against the real CLI: every
  // test here runs against the stub with no network, so these tests pin the argv shape
  // we construct, never that the CLI accepts it or honours it. The first live run must
  // confirm it -- see test/live/README.md.
  if (disallowedTools?.length) args.push("--disallowedTools", disallowedTools.join(","));
  if (systemPromptFile) args.push("--append-system-prompt-file", systemPromptFile);
  args.push(prompt);

  return new Promise((resolve) => {
    // cwd is always a fresh temp directory outside the repository. Running in the repo
    // lets the control arm read the skills off disk and inherit the parent CLAUDE.md,
    // which collapses every measured delta toward zero -- FAILURES.md entry 5.
    const p = spawn(binaryPath(), args, { cwd });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ out: out.trim(), err: err.trim(), code }));
    p.on("error", (e) => resolve({ out: "", err: String(e), code: -1 }));
  });
}
