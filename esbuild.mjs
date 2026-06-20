import esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const watch = process.argv.includes("--watch");

/**
 * `@codecash/shared` and `@codecash/client-core` are vendored into this repo (the non-secret subsets
 * only — constants, zod schemas, pricing; the vscode-free client money loop + claude-cli adapter; never
 * the server-side token signing). Alias the bare specifiers to the vendored entries so the source can
 * keep importing them unchanged. Keep these in lockstep with tsconfig.json paths + vitest.config.ts.
 */
const alias = {
  "@codecash/shared": fileURLToPath(new URL("./vendor/shared/index.ts", import.meta.url)),
  "@codecash/client-core": fileURLToPath(new URL("./vendor/client-core/index.ts", import.meta.url)),
  "@codecash/client-core/render": fileURLToPath(
    new URL("./vendor/client-core/adapters/claude-cli/render.ts", import.meta.url),
  ),
  "@codecash/client-core/render-codex": fileURLToPath(
    new URL("./vendor/client-core/adapters/codex-cli/render.ts", import.meta.url),
  ),
  "@codecash/client-core/daemon-lock": fileURLToPath(
    new URL("./vendor/client-core/lib/daemonControl.ts", import.meta.url),
  ),
};

/**
 * The extension host bundle — `vscode` is provided by the runtime, never bundled. VS Code loads
 * the entry via CommonJS `require`, so it's emitted as `.cjs`: the package is `"type": "module"`,
 * which would otherwise make a `.js` file ESM and break the CJS `module.exports` output.
 */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  outfile: "dist/extension.cjs",
  external: ["vscode"],
  alias,
  // Prefer each dependency's ESM entry (`module`) over its legacy `main`. esbuild's node default is
  // ["main","module"], which selects jsonc-parser's UMD build — its dynamic `require("./impl/format")`
  // calls can't be statically inlined, so they leak into the bundle as runtime requires and the
  // extension dies on activation with "Cannot find module './impl/format'". The ESM build uses static
  // imports esbuild fully inlines. (jsonc-parser has no `exports` map, so this is the right lever.)
  // NOTE: this build config is hand-maintained here, NOT synced from the monorepo — keep it in step
  // with apps/extension/esbuild.mjs. The bundle-activation guard (test/, synced) enforces it.
  mainFields: ["module", "main"],
  sourcemap: true,
  logLevel: "info",
  // Bake the default server URL for published builds: `CODECASH_DEFAULT_API_BASE_URL=https://… pnpm build`.
  // Unset in local dev → empty string → service.ts falls back to http://localhost:3000.
  define: {
    "process.env.CODECASH_DEFAULT_API_BASE_URL": JSON.stringify(
      process.env.CODECASH_DEFAULT_API_BASE_URL ?? "",
    ),
  },
};

/**
 * The render-only status-line script. Bundled to a SINGLE dependency-free file so it starts
 * fast and can never fail on a missing module — the "never break the CLI" prime directive.
 */
const renderConfig = {
  entryPoints: ["src/render.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  outfile: "dist/render.mjs",
  alias,
  minify: true,
  sourcemap: false,
  logLevel: "info",
};

/**
 * The codex-cli render-only status-line script — the Codex counterpart to renderConfig, same
 * dependency-free / single-file / never-throw contract. Hand-maintained in step with
 * apps/extension/esbuild.mjs; the vendored `@codecash/client-core/render-codex` import resolves
 * via `alias`. Mirrors the codex adapter synced from packages/client-core.
 */
const renderCodexConfig = {
  entryPoints: ["src/renderCodex.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  outfile: "dist/renderCodex.mjs",
  alias,
  minify: true,
  sourcemap: false,
  logLevel: "info",
};

/**
 * The `vscode:uninstall` hook (wired in package.json) — VS Code runs it as a plain node script on
 * uninstall to restore the user's original `~/.claude/settings.json` + panel `claudeCode.spinnerVerbs`.
 * Bundled standalone like the render script (client-core + jsonc-parser inlined, no `vscode`).
 * Hand-maintained in step with apps/extension/esbuild.mjs in the monorepo; test/uninstallBundle.test.ts
 * (synced) fails the build if this entry is dropped.
 */
const uninstallConfig = {
  entryPoints: ["src/uninstall.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  outfile: "dist/uninstall.mjs",
  alias,
  mainFields: ["module", "main"],
  minify: true,
  sourcemap: false,
  logLevel: "info",
};

if (watch) {
  const ctxs = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(renderConfig),
    esbuild.context(renderCodexConfig),
    esbuild.context(uninstallConfig),
  ]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("esbuild: watching…");
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(renderConfig),
    esbuild.build(renderCodexConfig),
    esbuild.build(uninstallConfig),
  ]);
}
