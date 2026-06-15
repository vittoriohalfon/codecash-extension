import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCliAdapter } from "../src/adapters/claude-cli/index.js";
import { codecashPaths } from "../src/lib/paths.js";
import type { AdServeResponse } from "@codecash/shared";

/**
 * The last seam the network E2E harness stubbed: the REAL ClaudeCliAdapter writing an ad cache that
 * the REAL bundled render script (dist/render.mjs) can read and turn into the clickable status line.
 * Proves "an ad fetched by the loop actually shows in Claude Code". Requires `pnpm build` first.
 */

const RENDER_MJS = fileURLToPath(new URL("../dist/render.mjs", import.meta.url));

const SERVE: AdServeResponse = {
  creative: {
    creativeId: "22222222-2222-2222-2222-222222222222",
    adText: "righthand.ai — your AI chief of staff",
    clickUrl: "https://teams.righthand.ai/signup",
  },
  token: "header.payload.sig",
  viewThresholdSeconds: 5,
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codecash-render-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: [] } }), "utf8");
});

describe("adapter → cache → render pipeline", () => {
  it("pushAd writes a cache the render script renders as a clickable ad line", async () => {
    const paths = codecashPaths(home);
    const adapter = new ClaudeCliAdapter(RENDER_MJS, paths);

    await adapter.pushAd(SERVE);

    // Cache the render script reads.
    expect(existsSync(paths.adCache)).toBe(true);
    const cache = JSON.parse(readFileSync(paths.adCache, "utf8"));
    expect(cache).toMatchObject({
      adText: SERVE.creative.adText,
      clickUrl: SERVE.creative.clickUrl,
      token: SERVE.token,
    });

    // Spinner verb is the ad; status line points at our render script.
    const settings = JSON.parse(readFileSync(paths.claudeSettings, "utf8"));
    expect(settings.spinnerVerbs).toEqual({ mode: "replace", verbs: [SERVE.creative.adText] });
    expect(settings.statusLine.command).toContain(RENDER_MJS);

    // The real render script, run with HOME=temp, prints the OSC 8 clickable ad line.
    const res = spawnSync("node", [RENDER_MJS], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
      input: "{}",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`ad· ${SERVE.creative.adText}`);
    expect(res.stdout).toContain(SERVE.creative.clickUrl); // OSC 8 hyperlink target
  });

  it("a stale cache renders nothing (never breaks the CLI)", async () => {
    const paths = codecashPaths(home);
    const adapter = new ClaudeCliAdapter(RENDER_MJS, paths);
    await adapter.pushAd(SERVE);

    // Backdate the cache beyond the 10-min freshness window.
    const cache = JSON.parse(readFileSync(paths.adCache, "utf8"));
    cache.ts = Date.now() - 11 * 60 * 1000;
    writeFileSync(paths.adCache, JSON.stringify(cache), "utf8");

    const res = spawnSync("node", [RENDER_MJS], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
      input: "{}",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("ad·");
  });
});
