import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ApiClient } from "../src/lib/apiClient.js";

/**
 * R4 tripwire: "no unsigned out-of-band update path, ever" (CLAUDE.md). codecash deliberately has NO
 * self-updater — it ships only through the VS Code Marketplace / Open VSX (a signed, VS Code-verified
 * channel) and never fetches executable code at runtime; the render script ships inside the bundle.
 * An unsigned, out-of-band ~90s auto-update is the kind of supply-chain hole these guard against.
 *
 * These are a TRIPWIRE, not a proof: they fail if a change adds a network endpoint that isn't a known
 * JSON money-loop route, or introduces an arbitrary-code-execution sink. Defeating them (e.g. writing
 * a downloaded file then importing it) takes deliberate effort — which is exactly the friction we
 * want, so the decision to ride the Marketplace channel can't be silently undone.
 */

// Every endpoint the client is allowed to call. A code/manifest download would have to be added here
// FIRST — a deliberate, reviewed change — which is the friction we want.
const ALLOWED_PATHS = [
  "/api/health",
  "/api/ads/next",
  "/api/events/impression",
  "/api/events/click",
  "/api/events/telemetry",
  "/api/me/earnings",
  "/api/devices/refresh",
  "/api/devices/revoke",
];

describe("R4: the client only talks to known JSON endpoints (no code-fetch / self-update)", () => {
  it("never requests a path outside the money-loop allowlist", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Request | string | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/api/ads/next") {
        return new Response(null, { status: 204, headers: { "x-codecash-reason": "no-inventory" } });
      }
      return new Response(
        JSON.stringify({ deduped: false, creditedMicros: 0, deviceToken: "a.b.c", todayMicros: 0, lifetimeMicros: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const api = new ApiClient({ baseUrl: "http://test.local", getToken: () => "tok.tok.tok", fetchImpl });

    // Exercise every networked method the client exposes.
    await api.ping();
    await api.fetchNextAd();
    await api.postImpression({ token: "t", idempotencyKey: "imp_aaaaaaaa", viewMs: 6000, occurredAt: 1 });
    await api.postClick({ token: "t", impressionIdempotencyKey: "imp_aaaaaaaa", idempotencyKey: "clk_aaaaaaaa", occurredAt: 1 });
    await api.postTelemetry([{ type: "view_threshold_met", adapter: "claude-cli", occurredAt: 1 }]);
    await api.fetchEarnings();
    await api.refreshToken();
    await api.revokeToken();

    expect(calls.length).toBeGreaterThan(0);
    for (const p of calls) expect(ALLOWED_PATHS).toContain(p);
  });

  it("has no update/manifest/download-shaped route in the allowlist", () => {
    for (const p of ALLOWED_PATHS) {
      expect(p).not.toMatch(/update|manifest|download|version|\.m?js(\?|$)/i);
    }
  });
});

describe("R4: no arbitrary-code-execution sinks in the extension source", () => {
  it("contains no eval() or new Function() anywhere in src/", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        if (/\beval\s*\(/.test(text) || /\bnew\s+Function\s*\(/.test(text)) offenders.push(full);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
