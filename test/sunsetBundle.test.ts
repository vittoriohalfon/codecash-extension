import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Sunset tripwire. This build's promise to users is that it CANNOT serve an ad — that the disable is
 * structural (the money loop is never imported, so esbuild drops it) rather than a runtime flag that
 * a stale cache or a server response could flip back on. A promise like that is only worth anything if
 * something enforces it, because the way it breaks is silent: someone re-imports `host/service.ts` for
 * one helper, the whole serving path is pulled back into the bundle, and a "shutdown" release quietly
 * starts injecting ads again against a server that is winding down.
 *
 * So this asserts over the SHIPPED artifact, not the source — tree-shaking is a property of the
 * bundler's output, and source-level imports can look innocent while the bundle says otherwise.
 *
 * If this fails while you are legitimately reviving the product, the fix is to delete this file as part
 * of that release, not to loosen it.
 */
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "extension.cjs");

function bundle(): string {
  expect(
    existsSync(bundlePath),
    `built bundle missing at ${bundlePath} — run \`pnpm build\` first`,
  ).toBe(true);
  return readFileSync(bundlePath, "utf8");
}

describe("sunset build cannot serve", () => {
  it("bundles no money-loop endpoint", () => {
    const text = bundle();
    // The exact paths the serving client called. Any of these in the bundle means the loop came back.
    for (const endpoint of [
      "api/ads/next",
      "api/events/impression",
      "api/events/click",
      "api/events/telemetry",
      "api/devices/register",
      "api/devices/refresh",
      "api/me/earnings",
    ]) {
      expect(text, `sunset bundle must not contain ${endpoint}`).not.toContain(endpoint);
    }
  });

  it("bundles no network call at all", () => {
    // Stronger than the endpoint list and immune to a renamed route: with no fetch, the sunset build
    // has no way to reach any server, so it cannot be handed an ad by anything.
    expect(bundle()).not.toMatch(/\bfetch\s*\(/);
  });

  it("bundles no serving machinery", () => {
    const text = bundle();
    for (const symbol of ["ServeController", "ViewTracker", "TelemetryReporter", "ApiClient"]) {
      expect(text, `sunset bundle must not contain ${symbol}`).not.toContain(symbol);
    }
  });

  it("ships only the sunset origin as an outbound URL", () => {
    // The cash-out and explainer links are the ONLY places this build points a user, and they're
    // opened in a browser by explicit click — never fetched. Anything else is a leak.
    const urls = [...bundle().matchAll(/https?:\/\/[a-zA-Z0-9.:/_-]+/g)].map((m) => m[0]);
    const hosts = new Set(urls.map((u) => new URL(u).host));
    expect([...hosts]).toEqual(["www.codecash.dev"]);
  });

  it("still restores the user's settings on activation", () => {
    // The other half of the promise: not serving is table stakes, but the build's actual job is to
    // put ~/.claude/settings.json and the panel setting back. Both restore targets must survive
    // tree-shaking — they're reached only from activate(), so an over-eager refactor could drop them.
    const text = bundle();
    expect(text).toContain("claudeCode.spinnerVerbs"); // panel surface restore
    expect(text).toContain("statusLine"); // terminal surface restore
  });
});
