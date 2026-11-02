import test from "node:test";
import assert from "node:assert/strict";
import { verifyChromeVersion } from "../scripts/verified-browser.mjs";

test("Chrome security floor includes the platform-specific patch", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.equal(verifyChromeVersion("Google Chrome 156.0.8078.79\n", platform), "156.0.8078.79");
    assert.equal(verifyChromeVersion("Google Chrome 157.0.8103.1", platform), "157.0.8103.1");
    for (const version of ["155.0.9999.999", "156.0.8078.4", "156.0.8078.72"]) {
      assert.throws(() => verifyChromeVersion(`Google Chrome ${version}`, platform), /security minimum/);
    }
  }
  assert.equal(verifyChromeVersion("Google Chrome 156.0.8078.73", "linux"), "156.0.8078.73");
  assert.throws(() => verifyChromeVersion("Google Chrome 156.0.8078.73", "darwin"), /security minimum/);
  assert.equal(verifyChromeVersion("Google Chrome 156.0.8078.74", "darwin"), "156.0.8078.74");
});

test("ambiguous, bundled, and non-stable version output fails closed", () => {
  for (const output of ["", "156", "Google Chrome 156", "Chromium 156.0.8078.79", "Google Chrome for Testing 156.0.8078.79", "Google Chrome 156.0.8078.79 beta", "warning\nGoogle Chrome 156.0.8078.79"]) {
    assert.throws(() => verifyChromeVersion(output), /stable Google Chrome/);
  }
});
