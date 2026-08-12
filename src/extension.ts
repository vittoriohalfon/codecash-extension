import * as vscode from "vscode";
import { activateSunset } from "./sunset.js";

/**
 * Extension host — SUNSET BUILD.
 *
 * codecash has stopped serving ads. This entry point no longer wires the client money loop (sign-in,
 * ad fetch, view accrual, billable impressions, the earnings widget); it hands off to
 * `sunset.ts`, which restores the user's original Claude Code settings, registers the contributed
 * commands so none of them error, and explains once what happened.
 *
 * `host/service.ts` and everything under it is intentionally NOT imported, so esbuild tree-shakes the
 * serving path out of the shipped bundle entirely. The disable is structural, not a runtime flag:
 * there is no configuration, server response, or stale cache that can bring ad injection back in this
 * version. Reverting means shipping a release that imports the service again.
 *
 * The serving code remains in the repo (it is still the source of record for how the loop worked, and
 * what the E2E harness exercises) — it is simply unreachable from activation.
 */
export function activate(context: vscode.ExtensionContext): void {
  activateSunset(context);
}

export function deactivate(): void {
  // Nothing to tear down: this build never injects anything, and the restore already ran at
  // activation. The `vscode:uninstall` hook (src/uninstall.ts → dist/uninstall.mjs) still runs on a
  // genuine uninstall and re-runs the same idempotent restore, which covers a user who never opened a
  // window between updating to this build and removing the extension.
}
