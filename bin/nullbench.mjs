#!/usr/bin/env node
import { main } from "../src/cli.mjs";

// main() throws whenever the reporting stage does (a bad skill file, a renderReport
// bug, appendEntry itself failing) -- cli.mjs deliberately does not swallow that in its
// try/finally, since the finally's only job is to guarantee the ledger append is
// attempted, not to absorb the error. Without a catch here, that exception reaches
// Node as an unhandled rejection: a raw stack trace and a Node-chosen exit code instead
// of the process cleanly reporting failure. Exit 1 here means "something broke", kept
// out of RegistrationError's reserved 2 and out of VOID's reserved 1-for-a-different-
// reason -- CI still can't read this as success either way.
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
