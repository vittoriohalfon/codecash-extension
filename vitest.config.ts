import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror the esbuild alias (keep in lockstep). Subpaths are listed BEFORE the bare specifier so
    // vite's first-match resolution can't rewrite `@codecash/client-core/render` via the bare alias.
    alias: {
      "@codecash/shared": fileURLToPath(new URL("./vendor/shared/index.ts", import.meta.url)),
      "@codecash/client-core/render": fileURLToPath(
        new URL("./vendor/client-core/adapters/claude-cli/render.ts", import.meta.url),
      ),
      "@codecash/client-core/render-codex": fileURLToPath(
        new URL("./vendor/client-core/adapters/codex-cli/render.ts", import.meta.url),
      ),
      "@codecash/client-core/daemon-lock": fileURLToPath(
        new URL("./vendor/client-core/lib/daemonControl.ts", import.meta.url),
      ),
      "@codecash/client-core": fileURLToPath(new URL("./vendor/client-core/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
