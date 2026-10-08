#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve("@playwright/cli/package.json")), "playwright-cli.js");
const temporary = await mkdtemp(path.join(tmpdir(), "between-browser-check-"));
const session = `between-check-${process.pid}`;
const env = {
  ...process.env, NODE_ENV: "production", PORT: "0", OPENAI_API_KEY: "",
  BETWEEN_SKIP_DOTENV: "1", NO_UPDATE_NOTIFIER: "1",
  PWTEST_DAEMON_SESSION_DIR: path.join(temporary, "sessions"),
};
const suites = ["browser-check.js", "x-browser-check.js", "x-regression-check.js", "x-reference-check.js", "performance-check.js", "onboarding-check.js"];
let server;
let serverOutput = "";
let browserOpened = false;
let currentProcess;
let stopping = false;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function command(args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, `-s=${session}`, "--raw", ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    currentProcess = child;
    let output = "";
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const capture = chunk => { output = (output + chunk.toString()).slice(-2_000_000); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => {
      clearTimeout(timeout);
      currentProcess = undefined;
      if (timedOut) return reject(new Error(`Browser command timed out: ${args[0]}`));
      if (code !== 0 || /^### Error/m.test(output) || /"ok"\s*:\s*false/.test(output))
        return reject(new Error(output.trim() || `Browser command failed (${code})`));
      resolve(output);
    });
  });
}

async function cleanup() {
  if (stopping) return;
  stopping = true;
  currentProcess?.kill();
  if (browserOpened) await command(["close"], 10_000).catch(() => {});
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([new Promise(resolve => server.once("exit", resolve)), delay(3000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await rm(temporary, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
});

try {
  await readFile(path.join(root, "dist", "index.html"));
  await mkdir(path.join(root, "output", "playwright"), { recursive: true });
  const config = path.join(temporary, "playwright.json");
  await writeFile(config, JSON.stringify({
    browser: { browserName: "chromium", isolated: true, launchOptions: { channel: "chromium", headless: true } },
  }));
  server = spawn(process.execPath, [path.join(root, "scripts", "browser-fixture-server.mjs")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  server.on("error", error => { serverOutput += `\n${error.message}`; });
  const capture = chunk => { serverOutput = (serverOutput + chunk.toString()).slice(-20_000); };
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);
  const deadline = Date.now() + 15_000;
  let base;
  while (Date.now() < deadline) {
    base = serverOutput.match(/Between is ready at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (base) break;
    if (server.exitCode !== null) throw new Error(`Fixture server exited before starting.\n${serverOutput}`);
    await delay(50);
  }
  if (!base) throw new Error(`Fixture server did not start.\n${serverOutput}`);
  const health = await fetch(`${base}/api/health`).then(response => response.json());
  if (health.configured !== false) throw new Error("Fixture server unexpectedly has an API key. Browser checks cancelled.");
  console.log(`Isolated production fixture: ${base} (no keys, no live API calls)`);
  browserOpened = true;
  await command(["open", base, `--config=${config}`], 45_000);
  for (const suite of suites) {
    console.log(`\nRunning ${suite}`);
    const output = await command(["run-code", `--filename=scripts/${suite}`]);
    if (!/"ok"\s*:\s*true/.test(output)) throw new Error(`The browser suite did not confirm success.\n${output}`);
    console.log(output.trim());
  }
  console.log("\nBrowser checks passed. Screenshots: output/playwright/");
} catch (error) {
  const message = /Browser .* is not installed|Executable doesn't exist/.test(error.message)
    ? "Install the test browser with npx --no-install playwright install chromium, then run npm run test:browser again."
    : error.code === "ENOENT" ? "Build the app first with npm run build. If Chromium is missing, run npx --no-install playwright install chromium." : error.message;
  console.error(message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
