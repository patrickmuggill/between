import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { askSecret, isApiKey, runSetup, saveApiKey, SetupCancelled, withApiKey } from "../scripts/setup.mjs";

// Deliberately synthetic values; no tests use a real credential or project .env.local.
const first = "sk-" + "fixtureA".repeat(6);
const second = "sk-" + "fixtureB".repeat(6);
async function directory(t) {
  const value = await mkdtemp(path.join(tmpdir(), "between-setup-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}
const capture = () => {
  let text = "";
  return { output: { write: value => { text += value; } }, value: () => text };
};

test("key validation rejects whitespace, line injection, shell text, and enormous input", () => {
  assert.ok(isApiKey(first));
  for (const value of ["", "abc", "sk-tiny", `${first}\nPORT=1234`, `${first} hi`, `${first}\"`, "sk-" + "a".repeat(1022), null])
    assert.equal(isApiKey(value), false);
});

test("updating a key preserves other settings and CRLF, while removing duplicate key assignments", () => {
  const input = `# existing config\r\nPORT=4321\r\nexport OPENAI_API_KEY='${first}' # previous\r\nOPENAI_API_KEY=${first}\r\nOPENAI_GENERATION_MODEL=example-model\r\n`;
  const actual = withApiKey(input, second);
  assert.equal(actual, `# existing config\r\nPORT=4321\r\nOPENAI_API_KEY="${second}"\r\nOPENAI_GENERATION_MODEL=example-model\r\n`);
  assert.ok(!actual.includes(first));
});

test("setup refuses a multiline key instead of leaving part of the old secret behind", () => {
  assert.throws(() => withApiKey('OPENAI_API_KEY="old\nkey"\nPORT=4173\n', second), /multi-line/);
});

test("new key file is complete and private and no temporary files remain", async t => {
  const root = await directory(t);
  const file = await saveApiKey(root, first);
  assert.ok((await readFile(file, "utf8")).includes(`OPENAI_API_KEY="${first}"`));
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), [".env.local"]);
});

test("existing configuration requires explicit overwrite and preserves unrelated settings after it", async t => {
  const root = await directory(t);
  await writeFile(path.join(root, ".env.local"), `PORT=4321\nOPENAI_API_KEY=${first}\n`, { mode: 0o644 });
  await assert.rejects(saveApiKey(root, second), /preserved/);
  assert.equal(await readFile(path.join(root, ".env.local"), "utf8"), `PORT=4321\nOPENAI_API_KEY=${first}\n`);
  await saveApiKey(root, second, { overwrite: true });
  assert.equal(await readFile(path.join(root, ".env.local"), "utf8"), `PORT=4321\nOPENAI_API_KEY="${second}"\n`);
  if (process.platform !== "win32") assert.equal((await stat(path.join(root, ".env.local"))).mode & 0o777, 0o600);
});

test("concurrent initial setup cannot silently overwrite another key", async t => {
  const root = await directory(t);
  const results = await Promise.allSettled([saveApiKey(root, first), saveApiKey(root, second)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const contents = await readFile(path.join(root, ".env.local"), "utf8");
  assert.ok(contents.includes(first) !== contents.includes(second));
  assert.deepEqual(await readdir(root), [".env.local"]);
});

test("a symbolic link is never followed or overwritten", { skip: process.platform === "win32" }, async t => {
  const root = await directory(t);
  const destination = path.join(root, "private-file");
  await writeFile(destination, "untouched");
  await symlink(destination, path.join(root, ".env.local"));
  await assert.rejects(saveApiKey(root, first, { overwrite: true }), /regular file/);
  assert.equal(await readFile(destination, "utf8"), "untouched");
});

test("keeping an existing file never asks for or prints its key", async t => {
  const root = await directory(t);
  await saveApiKey(root, first);
  const log = capture();
  const result = await runSetup({ directory: root, env: {}, output: log.output, readLine: async () => "", readSecret: async () => { throw new Error("Should not prompt"); } });
  assert.equal(result.status, "kept");
  assert.ok(!log.value().includes(first));
  assert.ok((await readFile(path.join(root, ".env.local"), "utf8")).includes(first));
});

test("an existing environment key can be used without creating any file", async t => {
  const root = await directory(t);
  const log = capture();
  const result = await runSetup({ directory: root, env: { OPENAI_API_KEY: first }, output: log.output, readSecret: async () => "" });
  assert.equal(result.status, "environment");
  assert.deepEqual(await readdir(root), []);
  assert.ok(!log.value().includes(first));
});

test("invalid and valid pasted key values are never echoed in setup messages", async t => {
  const root = await directory(t);
  const values = ["sensitive invalid key", first];
  const log = capture();
  const result = await runSetup({ directory: root, env: {}, output: log.output, readSecret: async () => values.shift() });
  assert.equal(result.status, "saved");
  assert.ok(!log.value().includes("sensitive invalid key"));
  assert.ok(!log.value().includes(first));
});

test("cancelling before saving leaves no key file", async t => {
  const root = await directory(t);
  const log = capture();
  await assert.rejects(runSetup({ directory: root, env: {}, output: log.output, readSecret: async () => { throw new SetupCancelled(); } }), SetupCancelled);
  assert.deepEqual(await readdir(root), []);
});

function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  return input;
}

test("hidden input supports backspace, does not echo, and restores the terminal", async () => {
  const input = terminal();
  const log = capture();
  const result = askSecret("Key: ", { input, output: log.output });
  input.emit("keypress", first + "x", {});
  input.emit("keypress", "", { name: "backspace" });
  input.emit("keypress", "\r", { name: "return" });
  assert.equal(await result, first);
  assert.equal(log.value(), "Key: \n");
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("keypress"), 0);
});

test("hidden input cancellation restores the terminal without leaking any input", async () => {
  const input = terminal();
  const log = capture();
  const result = askSecret("Key: ", { input, output: log.output });
  input.emit("keypress", first, {});
  input.emit("keypress", "\u0003", { name: "c", ctrl: true });
  await assert.rejects(result, SetupCancelled);
  assert.equal(log.value(), "Key: \n");
  assert.equal(input.isRaw, false);
});

test("hidden input rejects oversized paste rather than silently truncating it", async () => {
  const input = terminal();
  const log = capture();
  const result = askSecret("Key: ", { input, output: log.output });
  input.emit("keypress", first, {});
  input.emit("keypress", "a".repeat(1025), {});
  input.emit("keypress", "\r", { name: "return" });
  await assert.rejects(result, /exceeds 1024/);
  assert.equal(log.value(), "Key: \n");
  assert.equal(input.isRaw, false);
});

test("hidden input refuses a noninteractive pipe", async () => {
  const log = capture();
  await assert.rejects(askSecret("Key: ", { input: new PassThrough(), output: log.output }), /interactive terminal/);
  assert.equal(log.value(), "");
});
