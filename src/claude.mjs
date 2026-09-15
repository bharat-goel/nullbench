// The only module in this project that spawns a process.
//
// Isolating it is what makes the protocol layer testable for free: tests point
// NULLBENCH_CLAUDE_BIN at a stub that replays recorded output, and every test outside
// test/live/ runs with no network and no API key.

import { spawn } from "node:child_process";

export function binaryPath() {
  return process.env.NULLBENCH_CLAUDE_BIN || "claude";
}

export function invoke({ prompt, systemPromptFile = null, cwd, model, streamJson = false }) {
  const args = ["-p", "--setting-sources", "project", "--model", model];
  if (streamJson) args.push("--output-format", "stream-json", "--verbose");
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
