import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codecashPaths } from "../src/lib/paths.js";
import { installClaudeCliAdapter } from "../src/lib/settings.js";
import { reassertInjection } from "../src/lib/reassert.js";
import { writeAdCache } from "../src/lib/adCache.js";
import { ClaudeCliAdapter } from "../src/adapters/claude-cli/index.js";

const RENDER = "/opt/codecash/v1/dist/render.mjs";

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "codecash-reassert-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}
function writeSettings(home: string, obj: unknown) {
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(obj, null, 2), "utf8");
}
function readSettings(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
}
/** Put the machine into the "codecash already enabled" state (original captured, our statusLine in place). */
function enable(home: string, adText = "first ad") {
  writeSettings(home, { statusLine: { type: "command", command: 'node "/user/their-statusline.mjs"' } });
  installClaudeCliAdapter(codecashPaths(home), { renderScriptPath: RENDER, adText });
}

let home: string;
beforeEach(() => {
  home = freshHome();
});

describe("reassertInjection (R1 self-healing)", () => {
  it("is a no-op when our statusLine is already in place", () => {
    enable(home);
    const res = reassertInjection(codecashPaths(home), { renderScriptPath: RENDER });
    expect(res).toEqual({ reasserted: false, reason: "in_sync" });
  });

  it("re-installs when an external write wiped our statusLine", () => {
    enable(home);
    // Simulate Claude Code / another tool overwriting settings.json without our statusLine.
    writeSettings(home, { permissions: { allow: ["Bash"] }, theme: "dark" });

    const res = reassertInjection(codecashPaths(home), { renderScriptPath: RENDER });
    expect(res).toEqual({ reasserted: true });

    const after = readSettings(home);
    expect((after.statusLine as { command: string }).command).toContain(RENDER);
    expect(after.theme).toBe("dark"); // unrelated external edits preserved
    // The user's TRUE original (captured at enable) is still intact — drift didn't re-capture garbage.
    const cfg = JSON.parse(readFileSync(codecashPaths(home).config, "utf8"));
    expect(cfg.capturedStatusLine.command).toBe('node "/user/their-statusline.mjs"');
  });

  it("re-installs when our render-script path went stale (post-update)", () => {
    enable(home);
    const NEW_RENDER = "/opt/codecash/v2/dist/render.mjs"; // an extension update moved the script
    const res = reassertInjection(codecashPaths(home), { renderScriptPath: NEW_RENDER });
    expect(res).toEqual({ reasserted: true });
    expect((readSettings(home).statusLine as { command: string }).command).toContain(NEW_RENDER);
  });

  it("converges in one step — a second reassert is in_sync (no write loop)", () => {
    enable(home);
    writeSettings(home, {}); // drift
    expect(reassertInjection(codecashPaths(home), { renderScriptPath: RENDER })).toEqual({ reasserted: true });
    // The reassert write itself would re-trigger a watcher; the next pass must NOT write again.
    expect(reassertInjection(codecashPaths(home), { renderScriptPath: RENDER })).toEqual({
      reasserted: false,
      reason: "in_sync",
    });
  });

  it("restores the current fresh ad as the spinner verb on re-install", () => {
    enable(home);
    writeSettings(home, {}); // drift wipes statusLine + spinnerVerbs
    const res = reassertInjection(codecashPaths(home), { renderScriptPath: RENDER, adText: "live ad" });
    expect(res).toEqual({ reasserted: true });
    expect(readSettings(home).spinnerVerbs).toEqual({ mode: "replace", verbs: ["live ad"] });
  });

  it("never touches an unparseable settings file (never break the CLI)", () => {
    const p = join(home, ".claude", "settings.json");
    writeFileSync(p, "{ not json", "utf8");
    const before = readFileSync(p, "utf8");
    const res = reassertInjection(codecashPaths(home), { renderScriptPath: RENDER });
    expect(res).toEqual({ reasserted: false, reason: "unparseable" });
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("reports no_settings when the file is absent (we only ever patch, never create)", () => {
    const bare = mkdtempSync(join(tmpdir(), "codecash-bare-"));
    const res = reassertInjection(codecashPaths(bare), { renderScriptPath: RENDER });
    expect(res).toEqual({ reasserted: false, reason: "no_settings" });
  });
});

describe("ClaudeCliAdapter.reassert", () => {
  it("pulls the fresh ad from the cache and restores the verb on drift", () => {
    enable(home);
    const paths = codecashPaths(home);
    writeAdCache(paths, {
      adText: "cached ad",
      clickUrl: "https://example.com",
      creativeId: "11111111-1111-1111-1111-111111111111",
      token: "t",
      ts: Date.now(),
    });
    writeSettings(home, {}); // drift

    const adapter = new ClaudeCliAdapter(RENDER, paths, null);
    const res = adapter.reassert();
    expect(res).toEqual({ reasserted: true });
    expect((readSettings(home).statusLine as { command: string }).command).toContain(RENDER);
    expect(readSettings(home).spinnerVerbs).toEqual({ mode: "replace", verbs: ["cached ad"] });
  });

  it("leaves the verb untouched when no fresh ad is cached", () => {
    enable(home, "stale-but-present");
    const paths = codecashPaths(home);
    writeAdCache(paths, {
      adText: "old ad",
      clickUrl: "https://example.com",
      creativeId: "11111111-1111-1111-1111-111111111111",
      token: "t",
      ts: Date.now() - 60 * 60 * 1000, // an hour old → not fresh
    });
    // Drift the statusLine but keep an existing spinnerVerbs to prove reassert doesn't clobber it.
    writeSettings(home, { spinnerVerbs: { mode: "replace", verbs: ["kept"] } });

    const adapter = new ClaudeCliAdapter(RENDER, paths, null);
    expect(adapter.reassert()).toEqual({ reasserted: true });
    expect(readSettings(home).spinnerVerbs).toEqual({ mode: "replace", verbs: ["kept"] });
  });
});
