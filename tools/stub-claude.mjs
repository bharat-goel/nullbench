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

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

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
let i;
try {
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  i = state[key] ?? 0;
  state[key] = i + 1;
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

const outs = rule.outs ?? [""];
let output = outs[i % outs.length];
if (process.env.NULLBENCH_STUB_ECHO_CWD) {
  output += `\n<cwd-files>${readdirSync(process.cwd()).sort().join(",")}</cwd-files>`;
}
// After the listing, deliberately -- see the header note.
if (process.env.NULLBENCH_STUB_WRITE_CWD_FILE) {
  writeFileSync(join(process.cwd(), process.env.NULLBENCH_STUB_WRITE_CWD_FILE), "written by a stub run\n");
}
process.stdout.write(output);
process.exit(rule.code ?? 0);
