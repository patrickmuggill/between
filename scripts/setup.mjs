#!/usr/bin/env node
import { createInterface, emitKeypressEvents } from "node:readline";
import { randomUUID } from "node:crypto";
import { lstat, readFile, open, link, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const keyLine = /^\s*(?:export\s+)?OPENAI_API_KEY\s*=/;

export class SetupCancelled extends Error {
  constructor() { super("Setup cancelled. No configuration was changed."); }
}

export function isApiKey(value) {
  return typeof value === "string" && /^sk-[A-Za-z0-9_-]{17,1021}$/.test(value);
}

// dotenv receives a single, quoted token. No shell parsing or interpolation is used.
export function withApiKey(contents, key) {
  if (!isApiKey(key)) throw new Error("Enter a valid OpenAI API key beginning with sk-.");
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);
  for (const line of lines.filter(value => keyLine.test(value))) {
    const value = line.slice(line.indexOf("=") + 1).trim();
    const quote = value[0];
    if (["\"", "'", "`"].includes(quote) &&
        !new RegExp(`^${quote}[^${quote}]*${quote}\\s*(?:#.*)?$`).test(value))
      throw new Error("The existing key uses multi-line syntax. Edit .env.local privately; setup made no changes.");
  }
  let replaced = false;
  const next = lines.filter(line => {
    if (!keyLine.test(line)) return true;
    if (replaced) return false;
    replaced = true;
    return true;
  }).map(line => keyLine.test(line) ? `OPENAI_API_KEY="${key}"` : line);
  if (!replaced) {
    if (next.at(-1) === "") next.pop();
    next.push(`OPENAI_API_KEY="${key}"`, "");
  }
  return next.join(newline);
}

async function inspect(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Refusing to change .env.local because it is not a regular file.");
    if (stat.size > 64 * 1024) throw new Error("The existing .env.local is too large for setup to edit safely.");
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function sameFile(left, right) {
  return left && right && left.ino === right.ino && left.dev === right.dev &&
    left.mtimeMs === right.mtimeMs && left.size === right.size;
}

export async function saveApiKey(directory, key, { overwrite = false } = {}) {
  if (!isApiKey(key)) throw new Error("Enter a valid OpenAI API key beginning with sk-.");
  const file = path.join(directory, ".env.local");
  const original = await inspect(file);
  if (original && !overwrite) throw new Error("An existing .env.local was preserved. Overwrite confirmation is required.");
  const contents = original ? await readFile(file, "utf8") : "# Between — keep this file private.\n";
  const next = withApiKey(contents, key);
  const temporary = path.join(directory, `.env.local.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(next, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (original) {
      if (!sameFile(original, await inspect(file)))
        throw new Error("The configuration changed during setup. Nothing was overwritten; try again.");
      await rename(temporary, file);
    } else {
      // Hard-linking a complete temporary file makes creation atomic and exclusive.
      // Unlike rename, link fails if another process created the destination first.
      await link(temporary, file);
    }
    return file;
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export function askLine(message, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    const terminal = createInterface({ input, output });
    let settled = false;
    terminal.on("SIGINT", () => { settled = true; terminal.close(); reject(new SetupCancelled()); });
    terminal.on("close", () => { if (!settled) reject(new SetupCancelled()); });
    terminal.question(message, answer => { settled = true; terminal.close(); resolve(answer); });
  });
}

export function askSecret(message, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function")
    return Promise.reject(new Error("Setup needs an interactive terminal to hide your key. Use .env.example for manual setup."));
  output.write(message);
  return new Promise((resolve, reject) => {
    let secret = "";
    let tooLong = false;
    const wasRaw = Boolean(input.isRaw);
    const cleanup = () => {
      input.off("keypress", onKey);
      input.off("end", onEnd);
      input.off("error", onError);
      input.setRawMode(wasRaw);
      // Raw stdin was resumed for this prompt; stop it so a finished CLI exits.
      // A later prompt explicitly resumes it again.
      input.pause();
      output.write("\n");
    };
    const cancel = () => { cleanup(); reject(new SetupCancelled()); };
    const onEnd = () => cancel();
    const onError = () => { cleanup(); reject(new Error("The terminal closed before setup finished.")); };
    const onKey = (text, key = {}) => {
      if (key.ctrl && ["c", "d"].includes(key.name)) return cancel();
      if (key.name === "escape") return cancel();
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        if (tooLong) reject(new Error("The key exceeds 1024 characters. Setup made no changes."));
        else resolve(secret);
        secret = "";
        return;
      }
      if (key.name === "backspace") secret = secret.slice(0, -1);
      else if (key.ctrl && key.name === "u") { secret = ""; tooLong = false; }
      else if (!key.ctrl && !key.meta && typeof text === "string" && !/[\x00-\x1f\x7f]/.test(text)) {
        // A length cap keeps accidental huge pastes bounded. It is never echoed.
        if (secret.length + text.length <= 1024) secret += text;
        else tooLong = true;
      }
    };
    emitKeypressEvents(input);
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("error", onError);
    input.setRawMode(true);
    input.resume();
  });
}

export async function runSetup({
  directory = projectRoot, env = process.env, input = process.stdin, output = process.stdout,
  readLine = message => askLine(message, { input, output }),
  readSecret = message => askSecret(message, { input, output }),
} = {}) {
  output.write("\nBetween setup\nYour key stays on this computer, in the server's ignored .env.local file.\nGet a key: https://platform.openai.com/api-keys\nAPI usage is billed to your OpenAI account.\n\n");
  const existing = await inspect(path.join(directory, ".env.local"));
  if (existing) {
    output.write("An .env.local file already exists. Other settings will be preserved.\n");
    const choice = await readLine('Type "replace" to update its OpenAI key, or press Enter to keep it: ');
    if (choice.trim().toLowerCase() !== "replace") {
      output.write("Existing configuration kept. Run npm run dev to open Between.\n");
      return { status: "kept" };
    }
  }
  const shellKey = isApiKey(env.OPENAI_API_KEY);
  if (shellKey) output.write("OPENAI_API_KEY is already set in this terminal. Press Enter to use it without saving a key.\n");
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = (await readSecret("OpenAI API key (hidden; Esc cancels): ")).trim();
    if (!key && shellKey) {
      output.write("Using the environment key. No file was changed. Run npm run dev from this terminal.\n");
      return { status: "environment" };
    }
    if (!key) throw new SetupCancelled();
    if (!isApiKey(key)) {
      output.write("That does not look like an OpenAI API key. Paste the complete key beginning with sk-.\n");
      continue;
    }
    await saveApiKey(directory, key, { overwrite: Boolean(existing) });
    output.write(process.platform === "win32"
      ? "Saved .env.local. Keep this file private; it inherits your Windows folder permissions.\n"
      : "Saved .env.local with owner-only file permissions.\n");
    output.write("Your key was not sent anywhere.\nNext: npm run dev\nOpen: http://127.0.0.1:4173\n");
    if (shellKey) output.write("Your shell's OPENAI_API_KEY takes precedence until you unset it.\n");
    return { status: "saved" };
  }
  throw new Error("No valid key was provided. No configuration was changed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error("Setup does not accept arguments. Run npm run setup, then paste the key at the hidden prompt.");
    if (!process.stdin.isTTY) throw new Error("Run npm run setup in an interactive terminal, or copy .env.example to .env.local and edit it privately.");
    await runSetup();
  } catch (error) {
    // Do not dump exception objects: terminal input and file contents stay private.
    const expected = error instanceof SetupCancelled || !error.code;
    console.error(expected ? error.message : `Could not save configuration (${error.code}). No key was printed.`);
    process.exitCode = error instanceof SetupCancelled ? 0 : 1;
  }
}
