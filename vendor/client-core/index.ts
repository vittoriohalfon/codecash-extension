/**
 * @codecash/client-core — the vscode-free client money loop, shared by BOTH the VS Code extension
 * (apps/extension) and the standalone CLI + daemon (apps/cli). It owns the cadence/presence/UI glue
 * around the already-built, server-trusted money logic: fetch → render → accrue → credit → rotate,
 * plus the claude-cli injection adapter, settings backup/restore, presence, and the local ad cache.
 *
 * It re-hosts — never reimplements — the money path: the server signs every billable token and
 * verifies sig + idempotency + budget + killswitch, so neither client can fabricate money.
 *
 * The status-line render display logic is also exported here (and via the `./render` subpath, which
 * esbuild bundles into a zero-dependency `render.mjs`).
 */

// ── core money loop ──────────────────────────────────────────────────────────────────────────
export * from "./lib/apiClient.js";
export * from "./lib/serveController.js";
export * from "./lib/viewTracker.js";
export * from "./lib/presence.js";
export * from "./lib/spinnerCoalesce.js";
export * from "./lib/spinnerRegistry.js";
export * from "./lib/telemetry.js";
export * from "./lib/rotation.js";
export * from "./lib/auth.js";
export * from "./lib/signalCache.js";
export * from "./lib/idempotency.js";
export * from "./lib/tokenClaims.js";
export * from "./lib/clientReporter.js";
export * from "./lib/updateNotice.js";

// ── claude-cli terminal adapter + its support ──────────────────────────────────────────────────
export * from "./lib/paths.js";
export * from "./lib/settings.js";
export * from "./lib/adCache.js";
export * from "./lib/osc8.js";
export * from "./lib/workspaceKey.js";
export * from "./lib/context.js";
export * from "./lib/preflight.js";
export * from "./lib/reassert.js";
export * from "./lib/adLabel.js";
export * from "./adapters/types.js";
export * from "./adapters/claude-cli/index.js";
export * from "./adapters/claude-cli/render.js";

// ── codex-cli terminal adapter + its support ─────────────────────────────────────────────────────
export * from "./lib/codexSettings.js";
export * from "./adapters/codex-cli/index.js";
// The PATH-shim banner — the released-Codex fallback the host prefers until a Codex ships the clean
// status_line_command hook (see adapters/codex-cli/index.ts CODEX_MIN_VERSION).
export * from "./adapters/codex-cli-wrapper/index.js";

// ── codex surface gate (shared; opt-in, off by default, gated at the host) ─────────────────────────
export * from "./lib/codexGate.js";
