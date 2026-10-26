#!/usr/bin/env node
// A fake `claude` binary. Replays scripted replies so the protocol layer can be tested
// with no network and no spend. Contract is documented in the v1 plan, Task 5.
//
// NULLBENCH_STUB_ECHO_CWD: when set (to any value), the stub appends a second line to
// stdout after the scripted reply:
//   <cwd-files>a,b,c</cwd-files>
// listing the sorted directory entries of its own process.cwd(). This exists to let a
// test observe which directory a run actually executed in -- the scripted outs are the
// same regardless of cwd, so without this a fixture copy could silently fail to land
// and every test would still pass against an empty sandbox. Default (env unset)
// behaviour is byte-identical to before this existed: no extra line, no readdirSync.
//
// NULLBENCH_STUB_WRITE_CWD_FILE: when set to a filename, the stub writes that file into
// its own process.cwd() -- a stand-in for a real subject run creating an artifact. It
// is written AFTER the cwd listing above is computed, so a run never observes its own
// marker; only a LATER run sharing the same directory can see it. That is exactly the
// cross-run visibility being pinned in test/runner.test.mjs. Default (env unset)
// behaviour is byte-identical to before this existed: nothing is written.
//
// NULLBENCH_STUB_LIMIT_AFTER: when set to N, the first N invocations (counted globally
// across every rule, as a real plan's session limit is) behave normally, and every
// invocation after that prints the CLI's session-limit message to stderr, nothing to
// stdout, and exits 1. This is the failure that voided skill-audit's
// uap-release-analyzer twice: the process stays alive, every remaining call dies fast,
// and the batch completes as VOID.
//
// NULLBENCH_STUB_KILL_PARENT_AFTER: when set to N, invocation N+1 SIGKILLs its parent
// (the nullbench process) before replying -- a laptop lid, an OOM kill, a closed
// terminal. Nothing in the parent's `finally` runs. Only meaningful when nullbench is
// spawned as its own process; in-process tests must not set it.
//
// NULLBENCH_STUB_ECHO_SYSTEM_PROMPT: when set, and the invocation carries
// --append-system-prompt-file <path>, the stub reads that file and appends:
//   <system-prompt>...its full text...</system-prompt>
// This is what lets a test confirm the Base-directory line actually reaches the CLI --
// runner.mjs builds that file and passes its path on the real invocation; without this,
// nothing outside runner.mjs's own process ever saw its contents, so the only thing a
// test could check was the pure renderSkillSystemPrompt string builder in isolation.
//
// NULLBENCH_STUB_ECHO_TMPDIR_SANDBOXES: when set, the stub lists every entry under
// os.tmpdir() whose name starts with "nullbench-run-" or "nullbench-fx-" (a SUBJECT
// sandbox, fixture-backed or not) and appends:
//   <tmp-sandboxes>a,b,c</tmp-sandboxes>
// This is what makes "the subject sandbox is gone before the judge is invoked, not just
// eventually" a fact a test can check from OUTSIDE the process under test: the judge is
// a separate stub invocation, in its own directory, with no other way to see what
// happened to the subject's. Run this at concurrency 1 and there is at most one subject
// sandbox in flight system-wide, so an empty list at the moment the JUDGE's own
// invocation runs proves this job's subject sandbox was already removed.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NULLBENCH_STUB_ECHO_SKILL_FILES: when set, the stub recursively walks its own
// process.cwd()/skill (if that directory exists at all) and appends a third line:
//   <skill-files>SKILL.md,references/foo.md</skill-files>
// sorted, POSIX-joined, relative to skill/. ECHO_CWD alone only shows "skill" as ONE
// top-level entry -- that would look identical whether the copy brought every file
// along or silently dropped everything below the top level. This walks the actual
// contents so a test can assert on what got copied, not just that a directory exists.
// No skill/ at all (the control arm, or a single-file skill) reports an empty list, not
// an absent line, so a test never has to special-case "line missing" vs "walked empty".
function walkSkillDirForEcho(dir, rel = "") {
  const abs = join(dir, rel);
  let out = [];
  for (const name of readdirSync(abs).sort()) {
    const childRel = rel ? `${rel}/${name}` : name;
    let isDir = false;
    try {
      isDir = statSync(join(abs, name)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out = out.concat(walkSkillDirForEcho(dir, childRel));
    else out.push(childRel);
  }
  return out;
}

const plan = JSON.parse(readFileSync(process.env.NULLBENCH_STUB_PLAN, "utf8"));
const statePath = process.env.NULLBENCH_STUB_STATE;
const lockPath = `${statePath}.lock`;

const argv = process.argv.slice(2);
const arm = argv.includes("--append-system-prompt-file") ? "treatment" : "control";
const prompt = argv[argv.length - 1] ?? "";

const rule =
  (plan.rules ?? []).find(
    (r) => prompt.includes(r.promptIncludes) && (r.arm === "any" || r.arm === arm)
  ) ?? plan.default;

const key = rule === plan.default ? "__default__" : `${rule.promptIncludes}:${rule.arm}`;

function sleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

// Cross-process mutex over the shared state file. The read-modify-write below is not
// atomic on its own -- two concurrent stubs can both read the same counter, both emit
// the same out, and clobber each other's write to a different key. openSync(path, "wx")
// fails if the file already exists, which is the atomic test-and-set that makes this a
// real lock, not just a courtesy check.
function acquireLock() {
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      return openSync(lockPath, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() >= deadline) {
        // A wrong count is a better failure than a stalled test suite -- break the
        // lock and proceed. stderr is not part of the replayed event stream, so this
        // surfaces in the runner's captured output rather than corrupting a result.
        process.stderr.write(`stub-claude: breaking stale lock at ${lockPath}\n`);
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone -- another waiter broke it first
        }
        try {
          return openSync(lockPath, "wx");
        } catch {
          return null; // proceed unlocked rather than hang
        }
      }
      sleepSync(5);
    }
  }
}

function releaseLock(fd) {
  if (fd == null) return;
  try {
    closeSync(fd);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone
    }
  }
}

const lockFd = acquireLock();
let i, calls;
try {
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  i = state[key] ?? 0;
  state[key] = i + 1;
  // Global invocation index, zero-based, for the session-limit and kill switches.
  calls = state.__calls__ ?? 0;
  state.__calls__ = calls + 1;
  // Write-then-rename. A partial write is read back as truncated JSON, the stub exits
  // non-zero, and the runner records a dead run. Measured at roughly 30% of runs
  // before this was made atomic. Still worth doing inside the lock: it protects a
  // concurrent reader (or a crash mid-write) from ever observing torn JSON.
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, statePath);
} finally {
  releaseLock(lockFd);
}

const killAfter = process.env.NULLBENCH_STUB_KILL_PARENT_AFTER;
if (killAfter !== undefined && calls >= Number(killAfter)) {
  process.kill(process.ppid, "SIGKILL");
  process.exit(1);
}
const limitAfter = process.env.NULLBENCH_STUB_LIMIT_AFTER;
if (limitAfter !== undefined && calls >= Number(limitAfter)) {
  process.stderr.write("You've hit your session limit · resets 11pm\n");
  process.exit(1);
}

const outs = rule.outs ?? [""];
let output = outs[i % outs.length];
if (process.env.NULLBENCH_STUB_ECHO_CWD) {
  output += `\n<cwd-files>${readdirSync(process.cwd()).sort().join(",")}</cwd-files>`;
}
if (process.env.NULLBENCH_STUB_ECHO_SKILL_FILES) {
  const skillDir = join(process.cwd(), "skill");
  const files = existsSync(skillDir) ? walkSkillDirForEcho(skillDir).sort() : [];
  output += `\n<skill-files>${files.join(",")}</skill-files>`;
}
// After the listing, deliberately -- see the header note.
if (process.env.NULLBENCH_STUB_WRITE_CWD_FILE) {
  writeFileSync(join(process.cwd(), process.env.NULLBENCH_STUB_WRITE_CWD_FILE), "written by a stub run\n");
}
if (process.env.NULLBENCH_STUB_ECHO_SYSTEM_PROMPT) {
  const flagIdx = argv.indexOf("--append-system-prompt-file");
  const promptFile = flagIdx !== -1 ? argv[flagIdx + 1] : null;
  const text = promptFile && existsSync(promptFile) ? readFileSync(promptFile, "utf8") : "";
  output += `\n<system-prompt>${text}</system-prompt>`;
}
if (process.env.NULLBENCH_STUB_ECHO_TMPDIR_SANDBOXES) {
  const sandboxes = readdirSync(tmpdir())
    .filter((f) => f.startsWith("nullbench-run-") || f.startsWith("nullbench-fx-"))
    .sort();
  output += `\n<tmp-sandboxes>${sandboxes.join(",")}</tmp-sandboxes>`;
}
process.stdout.write(output);
process.exit(rule.code ?? 0);
