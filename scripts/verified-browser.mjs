import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);

// Chrome's 2026-10-27 stable security release; bundled Chromium is not approved.
// https://chromereleases.googleblog.com/2026/10/stable-channel-update-for-desktop_0562499947.html
export function verifyChromeVersion(output, platform = process.platform) {
  const match = output.trim().match(/^Google Chrome (\d+)\.(\d+)\.(\d+)\.(\d+)\s*$/);
  if (!match) throw new Error("Expected a stable Google Chrome executable and a complete version.");
  const version = match.slice(1).map(Number);
  const minimum = [156, 0, 8078, platform === "linux" ? 73 : 74];
  const difference = version.findIndex((part, index) => part !== minimum[index]);
  if (difference !== -1 && version[difference] < minimum[difference]) {
    throw new Error(`Chrome ${version.join(".")} is below the security minimum ${minimum.join(".")}. Update stable Google Chrome before running browser checks.`);
  }
  return version.join(".");
}

export async function verifiedBrowser() {
  let executablePath;
  if (process.platform === "darwin") {
    const application = "/Applications/Google Chrome.app";
    await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", application], { timeout: 60_000 });
    executablePath = path.join(application, "Contents/MacOS/Google Chrome");
  } else if (process.platform === "linux") {
    executablePath = "/opt/google/chrome/chrome";
  } else if (process.platform === "win32") {
    if (!process.env.PROGRAMFILES) throw new Error("PROGRAMFILES is required to locate stable Google Chrome.");
    executablePath = path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe");
  } else {
    throw new Error(`Unsupported browser-check platform: ${process.platform}`);
  }
  await access(executablePath);
  const { stdout } = await execute(executablePath, ["--version"], { timeout: 15_000 });
  const version = verifyChromeVersion(stdout);
  console.log(`Verified stable Google Chrome ${version}; Chromium sandbox required.`);
  return { executablePath, channel: "chrome", headless: true, chromiumSandbox: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifiedBrowser();
}
