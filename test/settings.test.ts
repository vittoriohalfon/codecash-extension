import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codecashPaths } from "../src/lib/paths.js";
import { installClaudeCliAdapter, uninstallClaudeCliAdapter } from "../src/lib/settings.js";

const RENDER = "/opt/codecash/dist/render.mjs";

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "codecash-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

function writeSettings(home: string, obj: unknown) {
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(obj, null, 2), "utf8");
}

function readSettings(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
}

let home: string;
beforeEach(() => {
  home = freshHome();
});

describe("claude-cli settings injection", () => {
  it("chain-captures an existing statusLine + spinnerVerbs, then restores them", () => {
    // Mirror the real machine: a pre-existing third-party statusLine + an ad spinner verb.
    const originalStatusLine = {
      type: "command",
      command: 'node "/Users/x/.some-tool/statusline.mjs"',
      padding: 0,
    };
    const originalSpinner = { mode: "replace", verbs: ["someone else's ad"] };
    writeSettings(home, {
      statusLine: originalStatusLine,
      spinnerVerbs: originalSpinner,
      permissions: { allow: ["Bash"] },
    });
    const paths = codecashPaths(home);

    const res = installClaudeCliAdapter(paths, { renderScriptPath: RENDER, adText: "codecash ad" });
    expect(res).toEqual({ ok: true, chained: true });

    const after = readSettings(home);
    // our render script is now the statusLine…
    expect((after.statusLine as { command: string }).command).toContain(RENDER);
    // …the spinner verb is our ad…
    expect(after.spinnerVerbs).toEqual({ mode: "replace", verbs: ["codecash ad"] });
    // …unrelated settings are untouched…
    expect(after.permissions).toEqual({ allow: ["Bash"] });
    // …originals are captured + backed up.
    const cfg = JSON.parse(readFileSync(paths.config, "utf8"));
    expect(cfg.capturedStatusLine).toEqual(originalStatusLine);
    expect(cfg.capturedSpinnerVerbs).toEqual(originalSpinner);
    expect(existsSync(paths.settingsBackup)).toBe(true);

    // Restore puts the user's world back exactly.
    const un = uninstallClaudeCliAdapter(paths);
    expect(un).toEqual({ ok: true, restored: true });
    const restored = readSettings(home);
    expect(restored.statusLine).toEqual(originalStatusLine);
    expect(restored.spinnerVerbs).toEqual(originalSpinner);
    expect(restored.permissions).toEqual({ allow: ["Bash"] });
  });

  it("on a clean machine (no statusLine), uninstall removes our keys entirely", () => {
    writeSettings(home, { permissions: { allow: [] } });
    const paths = codecashPaths(home);

    const res = installClaudeCliAdapter(paths, { renderScriptPath: RENDER, adText: "x" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.chained).toBe(false);

    uninstallClaudeCliAdapter(paths);
    const restored = readSettings(home);
    expect(restored.statusLine).toBeUndefined();
    expect(restored.spinnerVerbs).toBeUndefined();
    expect(restored.permissions).toEqual({ allow: [] });
  });

  it("re-install is idempotent: does not capture our own statusLine as the 'original'", () => {
    writeSettings(home, { statusLine: { type: "command", command: "node original.mjs" } });
    const paths = codecashPaths(home);

    installClaudeCliAdapter(paths, { renderScriptPath: RENDER, adText: "a" });
    installClaudeCliAdapter(paths, { renderScriptPath: RENDER, adText: "b" }); // second time

    const cfg = JSON.parse(readFileSync(paths.config, "utf8"));
    // still the TRUE original, not our render script
    expect(cfg.capturedStatusLine.command).toBe("node original.mjs");
    expect(readSettings(home).spinnerVerbs).toEqual({ mode: "replace", verbs: ["b"] });
  });

  it("REFUSES to touch unparseable settings (never breaks the CLI)", () => {
    const p = join(home, ".claude", "settings.json");
    writeFileSync(p, "{ this is not json", "utf8");
    const before = readFileSync(p, "utf8");

    const res = installClaudeCliAdapter(codecashPaths(home), { renderScriptPath: RENDER });
    expect(res).toEqual({ ok: false, reason: "settings_unparseable" });
    expect(readFileSync(p, "utf8")).toBe(before); // byte-for-byte untouched
  });

  it("refuses when there is no settings file at all", () => {
    const bareHome = mkdtempSync(join(tmpdir(), "codecash-bare-"));
    const res = installClaudeCliAdapter(codecashPaths(bareHome), { renderScriptPath: RENDER });
    expect(res).toEqual({ ok: false, reason: "no_settings" });
  });
});
