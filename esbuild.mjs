import esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const watch = process.argv.includes("--watch");

/**
 * `@codecash/shared` is vendored into this repo (the non-secret subset only — constants, zod
 * schemas, pricing; never the server-side token signing). Alias the bare specifier to the vendored
 * entry so the source can keep importing `@codecash/shared` unchanged.
 */
const alias = {
  "@codecash/shared": fileURLToPath(new URL("./vendor/shared/index.ts", import.meta.url)),
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
  entryPoints: ["src/adapters/claude-cli/render.ts"],
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

if (watch) {
  const ctxs = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(renderConfig),
  ]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("esbuild: watching…");
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(renderConfig),
  ]);
}
