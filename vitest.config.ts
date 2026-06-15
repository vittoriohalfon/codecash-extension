import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the esbuild alias: `@codecash/shared` → the vendored non-secret subset.
      "@codecash/shared": fileURLToPath(new URL("./vendor/shared/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
