import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * R4 tripwire (extension side): "no unsigned out-of-band update path, ever" (CLAUDE.md). codecash
 * ships only through the signed Marketplace / Open VSX channel and never fetches executable code at
 * runtime. The networked allowlist + ApiClient half of this guard lives in
 * `packages/client-core/test/updateGuard.test.ts` (where the only network code, `ApiClient`, now
 * lives after the Phase-A extraction); here we keep the arbitrary-code-execution-sink scan over the
 * extension's remaining VS Code glue (host/service, panel surface, the render entry, activation).
 */

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
