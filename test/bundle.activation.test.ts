import { describe, it, expect } from "vitest";
import { Module, createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Activation smoke test for the SHIPPED bundle — the guardrail for the 0.1.11 incident, where esbuild
 * bundled jsonc-parser's UMD build and its dynamic `require("./impl/format")` leaked into
 * `dist/extension.cjs` as an unresolved runtime require. With `vsce package --no-dependencies` there is
 * no node_modules fallback, so the module threw "Cannot find module './impl/format'" the instant
 * VS Code loaded it → `activate()` never ran → every `codecash.*` command was "command not found".
 *
 * Unit tests import `src/**` and never exercise the bundler, so they sailed past it. This loads the
 * actual built artifact the way the extension host does — provide an external `vscode`, then
 * `require()` the CJS output — and asserts it evaluates and exports `activate`/`deactivate`. Any
 * bundling defect that breaks module load (a missing module, a top-level throw, a syntax error) fails
 * here instead of shipping. `pnpm build` runs before `pnpm test` in CI and in the mirror's verify
 * step, so the bundle is present; the existence check turns a "forgot to build" run into a clear error.
 */
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "extension.cjs");

describe("packaged extension bundle", () => {
  it("loads under a stubbed vscode and exports activate()/deactivate()", () => {
    expect(
      existsSync(bundlePath),
      `built bundle missing at ${bundlePath} — run \`pnpm build\` (or \`node esbuild.mjs\`) first`,
    ).toBe(true);

    // `vscode` is marked external (the runtime provides it), so the bundle does a real
    // `require("vscode")`. Intercept that one specifier with an inert proxy — nothing in this module
    // touches vscode at load time (all usage is inside activate()), so a no-op stub is enough to let
    // it evaluate. Every other specifier resolves normally, so a genuinely missing internal module
    // still throws — which is exactly the regression we want to catch.
    const vscodeStub: unknown = new Proxy(() => undefined, {
      get: () => vscodeStub,
      apply: () => undefined,
      construct: () => ({}),
    });
    const loader = Module as unknown as {
      _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };
    const origLoad = loader._load;
    loader._load = (request, parent, isMain) =>
      request === "vscode" ? vscodeStub : origLoad(request, parent, isMain);
    try {
      const mod = createRequire(import.meta.url)(bundlePath) as {
        activate?: unknown;
        deactivate?: unknown;
      };
      expect(typeof mod.activate).toBe("function");
      expect(typeof mod.deactivate).toBe("function");
    } finally {
      loader._load = origLoad;
    }
  });
});
