// The only module in this project that spawns a process.
//
// Isolating it is what makes the protocol layer testable for free: tests point
// NULLBENCH_CLAUDE_BIN at a stub that replays recorded output, and every test outside
// test/live/ runs with no network and no API key.

import { spawn } from "node:child_process";
import { resolve } from "node:path";

// Resolved against the directory nullbench was STARTED in, captured at import time.
// Every invocation is spawned with cwd set to a fresh sandbox, so a relative
// NULLBENCH_CLAUDE_BIN -- the natural thing to type, e.g. `tools/local-claude.mjs` --
// resolves against the sandbox and fails with ENOENT on every single call. That is a
// 100%-dead batch whose only symptom is a VOID report, and it cost a real run here to
// diagnose. A bare command name with no separator (`claude`) is left alone so PATH
// lookup still works.
const STARTED_IN = process.cwd();
export function binaryPath() {
  const bin = process.env.NULLBENCH_CLAUDE_BIN;
  if (!bin) return "claude";
  return bin.includes("/") ? resolve(STARTED_IN, bin) : bin;
}

// NOT USED for subject invocations, deliberately -- kept because the plumbing is correct
// and a caller may want it. The final review recommended denying the subject Write/Edit/
// Bash on the premise that "nothing in the protocol needs the subject to mutate its cwd".
// That premise is false. cobra's ic-agent-under-pressure hands the model a real failing
// test suite in a fixture and grades whether it finds the truncation bug; denying those
// tools changes the task. A live run produced treatment replies reading "this session has
// no file-write or shell-execution tool at all". cobra's own published numbers were
// measured with no tool restriction, so restricting here would also make the worked
// example non-comparable to the figures it exists to reproduce. Contamination is closed by
// the per-run sandbox in src/runner.mjs, which is destroyed after every single call.
export const SUBJECT_DISALLOWED_TOOLS = ["Write", "Edit", "Bash"];

export function invoke({ prompt, systemPromptFile = null, cwd, model, streamJson = false, disallowedTools = null }) {
  const args = ["-p", "--setting-sources", "project", "--model", model];
  if (streamJson) args.push("--output-format", "stream-json", "--verbose");
  // `--disallowedTools=a,b,c` as ONE token. The flag is variadic, so passing the value as
  // a separate argv entry lets it keep consuming -- including the trailing positional
  // prompt. VERIFIED against the real CLI, after the separate-entry form silently ate the
  // prompt and turned every word of it into a bogus deny rule:
  //   Permission deny rule "Our" matches no known tool -- check for typos.
  // 97 of 100 runs produced no reply and the batch correctly came back VOID. The earlier
  // comment here asserted the CLI accepted either form; it does not.
  if (disallowedTools?.length) args.push(`--disallowedTools=${disallowedTools.join(",")}`);
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
