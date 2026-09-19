import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER = fileURLToPath(new URL("../tools/local-claude.mjs", import.meta.url));

// Stands in for LM Studio. `reply` shapes the response; the request it received is
// captured so the tests can assert what the adapter actually sent.
function server(handler) {
  return new Promise((res) => {
    const s = createServer((req, resp) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => handler(JSON.parse(body), resp));
    });
    // close() stops new connections but leaves established keep-alive sockets open, and
    // the adapter's fetch keeps one. Without closeAllConnections the server holds the
    // event loop and the whole test file hangs after the last assertion passes.
    const stop = () => { s.closeAllConnections?.(); s.close(); };
    s.listen(0, "127.0.0.1", () =>
      res({ s, stop, url: `http://127.0.0.1:${s.address().port}/v1/chat/completions` }));
  });
}

// MUST be async. The stub server runs in this same process, so spawnSync would block the
// event loop that has to answer the adapter's request -- the adapter then waits out its
// full timeout and the test hangs for three minutes before failing.
const run = (url, args, env = {}) =>
  new Promise((res) => {
    const p = spawn(process.execPath, [ADAPTER, ...args], {
      env: { ...process.env, NULLBENCH_LOCAL_URL: url, ...env },
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => res({ status, stdout, stderr }));
  });

const ARGS = (prompt, extra = []) =>
  ["-p", "--setting-sources", "project", "--model", "sonnet", ...extra, prompt];

test("sends the task prompt, returns the completion on stdout, exits 0", async () => {
  let seen = null;
  const { stop, url } = await server((body, resp) => {
    seen = body;
    resp.writeHead(200, { "content-type": "application/json" });
    resp.end(JSON.stringify({ choices: [{ message: { content: "the reply" } }] }));
  });
  const r = await run(url, ARGS("is three caught enough"));
  stop();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "the reply");
  assert.equal(seen.messages.length, 1, "no skill file means no system message");
  assert.equal(seen.messages[0].role, "user");
  assert.equal(seen.messages[0].content, "is three caught enough");
});

test("the skill file becomes the system message — the only difference between the arms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-adapter-"));
  const skill = join(dir, "SKILL.md");
  writeFileSync(skill, "# a skill\nDo the thing.");
  let seen = null;
  const { stop, url } = await server((body, resp) => {
    seen = body;
    resp.writeHead(200, { "content-type": "application/json" });
    resp.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const r = await run(url, ARGS("a prompt", ["--append-system-prompt-file", skill]));
  stop();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(seen.messages[0].role, "system");
  assert.match(seen.messages[0].content, /Do the thing\./);
  assert.equal(seen.messages[1].content, "a prompt", "the prompt must survive the flags before it");
});

test("--disallowedTools is accepted and does not swallow the prompt", async () => {
  let seen = null;
  const { stop, url } = await server((body, resp) => {
    seen = body;
    resp.writeHead(200, { "content-type": "application/json" });
    resp.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const r = await run(url, ARGS("the real prompt", ["--disallowedTools", "Write,Edit,Bash"]));
  stop();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(seen.messages[0].content, "the real prompt");
});

// Every one of these must be a DEAD RUN -- excluded from the denominator -- not a
// wrong answer. A quiet zero-exit here would score a broken endpoint as a failed reply
// and drive both arms toward 0% with a tight, confident, meaningless interval.
test("a non-200 exits non-zero", async () => {
  const { stop, url } = await server((_b, resp) => { resp.writeHead(500); resp.end("nope"); });
  const r = await run(url, ARGS("p"));
  stop();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /500/);
});

test("an empty completion exits non-zero rather than returning an empty reply", async () => {
  const { stop, url } = await server((_b, resp) => {
    resp.writeHead(200, { "content-type": "application/json" });
    resp.end(JSON.stringify({ choices: [{ message: { content: "   " } }] }));
  });
  const r = await run(url, ARGS("p"));
  stop();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty completion/);
});

test("an unreachable server exits non-zero", async () => {
  const r = await run("http://127.0.0.1:1/v1/chat/completions", ARGS("p"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /failed/);
});
