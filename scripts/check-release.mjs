#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean))];
const errors = [];
const required = ["README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", ".env.example", ".gitignore", "package-lock.json", ".github/workflows/ci.yml"];
for (const file of required) if (!files.includes(file)) errors.push(`${file}: missing from release candidates`);
const rules = [
  ["possible OpenAI credential", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/],
  ["possible GitHub credential", /\bgh[pousr]_[A-Za-z0-9]{25,}/],
  ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["machine-specific home path", /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
];
let checked = 0;
for (const file of files) {
  if (/(^|\/)(?:node_modules|dist|output|\.playwright-cli|\.aws|\.ssh)(?:\/|$)/.test(file) ||
      /(^|\/)\.env(?!\.example$)/.test(file) || /\.(?:pem|p12|pfx|key|log)$/i.test(file)) {
    errors.push(`${file}: private or generated file would be published`);
    continue;
  }
  const full = path.join(root, file);
  if (!existsSync(full)) continue;
  const info = lstatSync(full);
  if (info.isSymbolicLink()) { errors.push(`${file}: release candidates must not be symlinks`); continue; }
  if (!info.isFile() || /\.(?:png|webp|jpg|jpeg|gif|woff2?)$/i.test(file)) continue;
  if (info.size > 2_000_000) { errors.push(`${file}: unexpectedly large text file`); continue; }
  const contents = readFileSync(full, "utf8");
  for (const [label, pattern] of rules) if (pattern.test(contents)) errors.push(`${file}: ${label}`);
  checked += 1;
}
const example = readFileSync(path.join(root, ".env.example"), "utf8");
if (!/^OPENAI_API_KEY=\s*$/m.test(example)) errors.push(".env.example: API key must be empty");
const readme = readFileSync(path.join(root, "README.md"), "utf8");
for (const [, imagePath] of readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
  if (!/^https?:/.test(imagePath) && !existsSync(path.join(root, imagePath))) errors.push("README.md: missing image " + imagePath);
}
if (!readme.includes("Kasper Marx Andersen") || !readme.includes("https://x.com/KaAnDK/status/2107754495132184653")) errors.push("README.md: preserve credit to Kasper Marx Andersen and his original post");
try { execFileSync("git", ["check-ignore", "--no-index", "--quiet", ".env.local"], { cwd: root }); }
catch { errors.push(".env.local must be ignored by Git"); }
if (errors.length) {
  console.error("Release check failed (file paths only; secret values are never printed):\n" + errors.map(error => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else console.log(`Release check passed: ${checked} text files scanned; secrets excluded; attribution present.`);
