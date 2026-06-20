import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panelCapturePath, readPanelCapture, writePanelCapture } from "../src/lib/panelCapture.js";

/**
 * The on-disk mirror of the panel's captured original `claudeCode.spinnerVerbs`. It's the only way the
 * vscode-free `vscode:uninstall` script can restore the panel (globalState is unreadable there), so the
 * write/read/forget roundtrip — and behaving as "no capture" on corruption rather than throwing — is
 * load-bearing.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codecash-panelcap-"));
});

describe("panel capture mirror", () => {
  it("roundtrips a captured original + settings path", () => {
    const path = panelCapturePath(dir);
    const cap = { original: { mode: "replace", verbs: ["mine"] }, userSettingsPath: "/u/settings.json" };
    writePanelCapture(path, cap);
    expect(readPanelCapture(path)).toEqual(cap);
  });

  it("records original:null when the user had nothing set", () => {
    const path = panelCapturePath(dir);
    writePanelCapture(path, { original: null, userSettingsPath: "/u/settings.json" });
    expect(readPanelCapture(path)).toEqual({ original: null, userSettingsPath: "/u/settings.json" });
  });

  it("forgets the capture (deletes the file) on undefined", () => {
    const path = panelCapturePath(dir);
    writePanelCapture(path, { original: null, userSettingsPath: "/u/settings.json" });
    expect(existsSync(path)).toBe(true);
    writePanelCapture(path, undefined);
    expect(existsSync(path)).toBe(false);
    expect(readPanelCapture(path)).toBeUndefined();
  });

  it("returns undefined for a missing or corrupt file instead of throwing", () => {
    const path = panelCapturePath(dir);
    expect(readPanelCapture(path)).toBeUndefined(); // missing
    writeFileSync(path, "{ not json", "utf8"); // corrupt
    expect(readPanelCapture(path)).toBeUndefined();
  });

  it("forgetting an already-absent capture is a no-op", () => {
    expect(() => writePanelCapture(panelCapturePath(dir), undefined)).not.toThrow();
  });
});
