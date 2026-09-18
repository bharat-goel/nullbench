#!/usr/bin/env node
// An adapter that makes a local OpenAI-compatible server (LM Studio, llama.cpp, Ollama's
// compat endpoint) usable wherever nullbench expects the `claude` CLI. Point
// NULLBENCH_CLAUDE_BIN at this file.
//
// WHY THIS RATHER THAN ANTHROPIC_BASE_URL. Claude Code can be pointed at a local endpoint,
// but it sends a very large system prompt of its own -- tens of thousands of tokens before
// your skill is even appended. That prompt sits in BOTH arms, so it does not bias the
// delta, but it dwarfs the injected skill and leaves a small model very little attention
// for it. This adapter sends the task prompt and the skill, and nothing else, which is
// what the experiment actually intends to compare.
//
// WHAT IT SUPPORTS: the exact argv shape src/claude.mjs constructs, and nothing more.
//   -p, --setting-sources <v>   accepted and ignored (no ambient config to source)
//   --model <m>                 used unless NULLBENCH_LOCAL_MODEL overrides it
//   --output-format stream-json, --verbose   accepted; see the note below
//   --disallowedTools <list>    accepted and IGNORED -- this adapter exposes no tools at
//                               all, so the restriction is satisfied vacuously
//   --append-system-prompt-file <path>   read and sent as the system message
//   <prompt>                    the final positional
//
// ENV:
//   NULLBENCH_LOCAL_URL     default http://localhost:1234/v1/chat/completions
//   NULLBENCH_LOCAL_MODEL   override the model name sent to the server
//   NULLBENCH_LOCAL_TIMEOUT_MS  default 180000
//
// SAMPLING IS DELIBERATELY LEFT TO THE SERVER. Setting temperature 0 would make every
// repetition identical, and a Wilson interval over ten identical outcomes is a lie about
// how much was learned. The reps exist to sample real variance, so the server's own
// default sampling is what they must see.
//
// FAILURE IS LOUD. Any transport error, non-200, or empty completion exits non-zero with
// the reason on stderr, so the runner records a DEAD RUN and excludes it from the
// denominator rather than scoring it as a wrong answer.

import { readFileSync } from "node:fs";

const URL_ = process.env.NULLBENCH_LOCAL_URL || "http://localhost:1234/v1/chat/completions";
const TIMEOUT = Number(process.env.NULLBENCH_LOCAL_TIMEOUT_MS || 180000);

const argv = process.argv.slice(2);
let model = null, systemFile = null, streamJson = false;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--model") model = argv[++i];
  else if (a === "--append-system-prompt-file") systemFile = argv[++i];
  else if (a === "--setting-sources" || a === "--disallowedTools" || a === "--output-format") {
    if (a === "--output-format" && argv[i + 1] === "stream-json") streamJson = true;
    i++;
  } else if (a === "-p" || a === "--verbose") { /* no-op */ }
  else positional.push(a);
}
const prompt = positional[positional.length - 1];

function die(msg) {
  process.stderr.write(`local-claude: ${msg}\n`);
  process.exit(1);
}
if (!prompt) die("no prompt argument");

const messages = [];
if (systemFile) {
  try {
    messages.push({ role: "system", content: readFileSync(systemFile, "utf8") });
  } catch (e) {
    die(`cannot read --append-system-prompt-file ${systemFile}: ${e.message}`);
  }
}
messages.push({ role: "user", content: prompt });

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), TIMEOUT);
let res;
try {
  res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.NULLBENCH_LOCAL_MODEL || model || "local-model",
      messages,
      stream: false,
    }),
    signal: ac.signal,
  });
} catch (e) {
  die(`request to ${URL_} failed: ${e.name === "AbortError" ? `timed out after ${TIMEOUT}ms` : e.message}`);
} finally {
  clearTimeout(timer);
}

if (!res.ok) die(`${URL_} returned ${res.status} ${res.statusText}`);

let body;
try {
  body = await res.json();
} catch (e) {
  die(`response was not JSON: ${e.message}`);
}

const text = body?.choices?.[0]?.message?.content ?? "";
if (!text.trim()) die("server returned an empty completion");

// The runner only asks for stream-json when it wants to detect a Skill tool_use event,
// which a plain completions endpoint cannot produce. Emitting one assistant-message event
// keeps the shape parseable; it will never report a skill activation, and nothing in the
// content path of this project depends on that.
if (streamJson) {
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n");
} else {
  process.stdout.write(text);
}
