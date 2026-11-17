// Life of this process, from boot to exit.
//
// The forge itself lives in app.ts; this file only handles the handshake
// with the trial environment that drives it:
//
//   - read MAKEFUN_ENV_URL, the env's base URL (missing means there is
//     nothing to talk to, so stop right away);
//   - start the forge on a kernel-chosen port (never 8080, which the env
//     already owns);
//   - tell the env that port with one POST to /register, retrying while
//     the env is still coming up;
//   - poll GET /done until the env reports the trial finished, then shut
//     the server down and exit 0.
//
// Nothing here serves traffic: the suite dials the registered port and
// drives the forge directly. Every request this file makes goes to the env,
// and every retry waits a short exponential backoff first.

import { createApp } from "./app.ts";

// The env's base URL, trailing slashes trimmed. An empty value means this
// process has no env to talk to, so it stops right away.
const ENV_BASE = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (ENV_BASE === "") {
  process.stderr.write("[entry] no MAKEFUN_ENV_URL set, so there is no env to register with\n");
  process.exit(1);
}

// One env request may take this long before it is abandoned and retried.
const REQUEST_LIMIT_MS = 30_000;
// Retries start this far apart and never wait longer than the cap.
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

// Prefix marking an error that is a contract failure, not a transient one.
const CONTRACT_PREFIX = "register answered HTTP ";

const pause = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

// How long to wait after `failures` failed attempts: doubling from the
// first wait, capped, and never growing past eight doublings.
function backoffMs(failures: number): number {
  const doublings = Math.min(failures, 8);
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** doublings);
}

// One attempt to tell the env our port. Returns true when the env has the
// port (a 200), or when a first registration already won (a 409, which is
// another entry's to own, not ours to fix). Throws on a 400 or 405, which
// mean the request itself breaks the contract; anything else is a false
// return, and the caller retries.
async function tryRegister(port: number): Promise<boolean> {
  const res = await fetch(`${ENV_BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
  });
  if (res.status === 200 || res.status === 409) return true;
  if (res.status === 400 || res.status === 405) {
    throw new Error(`${CONTRACT_PREFIX}${res.status}: ${await res.text()}`);
  }
  return false;
}

// Keep POSTing the bound port until the env accepts it. A contract error
// ends the program; a network error or any other status just waits and
// tries again, since the env may still be starting.
async function registerPort(port: number): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      if (await tryRegister(port)) return;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(CONTRACT_PREFIX)) throw err;
      // Anything else is transient: fall through to the wait and retry.
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

// One poll of GET /done. Returns true only when the env answers
// {"done": true}; any other answer, or a request that fails, means the
// trial is still running.
async function tryDone(): Promise<boolean> {
  const res = await fetch(`${ENV_BASE}/done`, {
    signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { done?: unknown };
  return body.done === true;
}

// Poll /done until the env says the trial is over. A failed or slow poll
// is not a failure: it just means "not done yet", so wait and ask again.
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      if (await tryDone()) return;
    } catch {
      // The env is not answering yet, or the poll timed out: still not done.
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

// Start the forge and bind a kernel-chosen port. A string address (a Unix
// socket) or no address at all means the bind did not produce the TCP port
// the env needs, so that is a fatal error.
async function bindForge(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the forge did not bind a TCP port for the env to dial");
  }
  return { server, port: bound.port };
}

// The whole life of the process: bind, register, wait, shut down.
async function run(): Promise<void> {
  const { server, port } = await bindForge();
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await registerPort(port);
  process.stdout.write("[entry] registered; waiting for the trial to finish\n");

  await waitUntilDone();
  server.close();
  process.stdout.write("[entry] trial done, shutting down\n");
}

try {
  await run();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}
