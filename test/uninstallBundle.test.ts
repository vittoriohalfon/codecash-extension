import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Guard for the `vscode:uninstall` hook's shipped artifact. The hook is wired in package.json as
 * `node ./dist/uninstall.mjs`, but that bundle is only produced if the build's esbuild config declares
 * the entry — and this repo's esbuild config is HAND-MAINTAINED in the public mirror (it's not synced
 * from the monorepo; see codecash-extension/esbuild.mjs). So a forgotten entry there would silently
 * ship an extension whose uninstall hook points at a missing file — defeating the settings restore with
 * no error. This test (which IS synced to the mirror, under test/) fails the build/sync-verify step in
 * that case.
 *
 * It only checks the artifact EXISTS and bundled the right code — it must NEVER execute it: running
 * `uninstall.mjs` performs a real restore against the current user's `~/.claude/settings.json`.
 */
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "uninstall.mjs");

describe("vscode:uninstall bundle", () => {
  it("is built (run `pnpm build` first) and bundled the panel-restore code", () => {
    expect(
      existsSync(bundlePath),
      `built bundle missing at ${bundlePath} — esbuild must declare the uninstall entry (\`pnpm build\`)`,
    ).toBe(true);
    expect(statSync(bundlePath).size).toBeGreaterThan(1000); // a real bundle, not an empty stub
    // String literals survive minification, so this confirms our uninstall source (not some other
    // entry) is what got bundled — the panel surface key we restore.
    expect(readFileSync(bundlePath, "utf8")).toContain("claudeCode.spinnerVerbs");
  });
});
