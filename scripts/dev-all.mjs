/**
 * The whole local stack from one entry: the app, its backend, and the landing
 * page.
 *
 * Three launch entries meant three things to start and three to remember to
 * stop, and the one that got forgotten was always the backend -- which the app
 * needs and does not announce when it is missing: the map loads, then every
 * radar request quietly fails. One process that owns all three means they come
 * up together and, more to the point, go down together.
 *
 * No concurrently or npm-run-all. The part that matters here is teardown on
 * Windows, where killing a parent does not kill its children: uvicorn's reload
 * worker and vite's esbuild service would each keep their port and make the
 * next start fail with "address already in use". That needs taskkill /T, which
 * is easier to own than to hope a package gets right.
 *
 *   npm run dev:all
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const TTY = Boolean(process.stdout.isTTY);

const VITE = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const PYTHON = path.join(ROOT, "backend", ".venv", WIN ? "Scripts" : "bin", WIN ? "python.exe" : "python");

const SERVICES = [
  {
    name: "backend",
    port: 8787,
    color: 35,
    cmd: PYTHON,
    // --reload because merging the entries took away "restart just the
    // backend": a saved .py file is live on its own now. watchfiles is in the
    // venv, so this listens for filesystem events instead of polling the
    // thousands of files under .venv.
    //
    // --timeout-graceful-shutdown because a reload waits for the old worker to
    // finish its open requests, and without a limit it waited indefinitely: a
    // long model download or a client holding a connection kept the old code
    // serving for a quarter of an hour after the file had been saved.
    args: [
      "-m", "uvicorn", "main:app", "--app-dir", "backend", "--port", "8787",
      "--reload", "--reload-dir", "backend", "--timeout-graceful-shutdown", "3",
    ],
  },
  {
    name: "web",
    port: 1420,
    color: 36,
    cmd: process.execPath,
    // Port and strictPort already live in vite.config.ts; repeating them here
    // would make two places to change.
    args: [VITE],
  },
  {
    name: "landing",
    port: 4173,
    color: 33,
    cmd: process.execPath,
    // Its own config, for its own dependency cache: sharing node_modules/.vite
    // with the app made the two rewrite each other's cache on every start.
    // Root, port and strictPort live in that file.
    args: [VITE, "--config", path.join(ROOT, "scripts", "landing.vite.config.mjs")],
  },
];

const WIDTH = Math.max(...SERVICES.map((s) => s.name.length));

function tag(name, color) {
  const label = `[${name}]`.padEnd(WIDTH + 2);
  return TTY ? `\x1b[${color}m${label}\x1b[0m` : label;
}

const log = (msg) => process.stdout.write(`${tag("dev", 32)} ${msg}\n`);

/** Prefix every line a child prints, so three interleaved logs stay readable. */
function pipe(stream, prefix, sink) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      sink.write(`${prefix} ${buf.slice(0, i).replace(/\r$/, "")}\n`);
      buf = buf.slice(i + 1);
    }
  });
  stream.on("end", () => {
    if (buf) sink.write(`${prefix} ${buf}\n`);
  });
}

function listeningOn(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(400, () => done(false));
  });
}

/**
 * Whether something is already answering on a port, over either stack.
 *
 * Asking 127.0.0.1 alone is wrong here in a way that is easy to miss. A vite
 * started without --host binds "localhost", which Node on Windows resolves to
 * ::1 and nothing else: the landing page answered on [::1]:4173 and refused
 * 127.0.0.1. Checked on IPv4 only, it was never reported ready -- and a
 * leftover one from an earlier run would have walked straight past the
 * port-in-use check.
 */
async function listening(port) {
  const [v4, v6] = await Promise.all([listeningOn("127.0.0.1", port), listeningOn("::1", port)]);
  return v4 || v6;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

const running = [];
let stopping = false;

function kill(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (WIN) {
    // /T takes the tree: uvicorn's reload worker and vite's esbuild child go
    // with their parents instead of sitting on 8787 and 1420 afterwards.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM"); // the whole process group
    } catch {
      /* already gone */
    }
  }
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of running) kill(child);
  process.exit(code);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => stopAll(0));
process.on("exit", () => {
  if (stopping) return;
  stopping = true;
  for (const child of running) kill(child);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const missing = [];
if (!existsSync(VITE)) missing.push("node_modules/vite is missing -- run npm install");
if (!existsSync(PYTHON)) missing.push("backend/.venv is missing -- create the Python virtualenv first");
if (missing.length) {
  for (const m of missing) log(m);
  process.exit(1);
}

// uvicorn's own report of a taken port on Windows is "[WinError 10048]", which
// explains nothing. Checking first turns it into a sentence -- and the usual
// cause is a server left over from a run that did not shut down cleanly.
const taken = [];
for (const svc of SERVICES) if (await listening(svc.port)) taken.push(svc);
if (taken.length) {
  for (const svc of taken) log(`port ${svc.port} is already in use -- is a previous ${svc.name} still running?`);
  process.exit(1);
}

const t0 = Date.now();

for (const svc of SERVICES) {
  const child = spawn(svc.cmd, svc.args, {
    cwd: ROOT,
    // Piping costs a child its colours; hand them back when a person is
    // actually watching.
    env: { ...process.env, ...(TTY ? { FORCE_COLOR: "1" } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group on POSIX so teardown can signal the group. Never
    // on Windows, where detached means a separate console window per server.
    detached: !WIN,
    windowsHide: true,
  });
  running.push(child);

  const prefix = tag(svc.name, svc.color);
  pipe(child.stdout, prefix, process.stdout);
  pipe(child.stderr, prefix, process.stderr);

  child.on("error", (err) => {
    if (stopping) return;
    log(`${svc.name} could not start: ${err.message}`);
    stopAll(1);
  });

  child.on("exit", (code, signal) => {
    // Ctrl+C reaches the children too, and one of them may exit a moment
    // before our own handler runs. Waiting a beat keeps a normal stop from
    // being reported as a crash.
    setTimeout(() => {
      if (stopping) return;
      log(`${svc.name} stopped (${signal ?? `exit ${code}`}) -- taking the rest down with it`);
      // A half-running stack is worse than none: the app without its backend
      // looks fine until the first request.
      stopAll(code || 1);
    }, 200);
  });
}

const ready = SERVICES.map(async (svc) => {
  while (!stopping) {
    if (await listening(svc.port)) {
      log(`${svc.name} ready on http://localhost:${svc.port} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
});

await Promise.all(ready);
if (!stopping) log(`all three up in ${((Date.now() - t0) / 1000).toFixed(1)}s -- Ctrl+C stops everything`);
// rodar-web.cmd asks for this: nothing to open before the app can answer.
if (!stopping && WIN && process.argv.includes("--open")) {
  spawn("cmd", ["/c", "start", "", "http://localhost:1420/"], { stdio: "ignore", windowsHide: true });
}
