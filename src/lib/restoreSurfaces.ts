/**
 * Undo every config injection codecash made, from the captures mirrored to `~/.codecash`.
 *
 * Deliberately vscode-free and dependency-light: it is called from BOTH the `vscode:uninstall` hook
 * (which runs as plain node, with no `vscode` API and no `globalState`) and the sunset build's
 * `activate()`. One implementation, so the two teardown paths can't drift — the uninstall path is the
 * one users hit rarely and can never be asked to re-run, so it must behave identically to the one we
 * exercise constantly.
 *
 * Reads captures off disk rather than `globalState` on purpose: disk is the only source both callers
 * share, and it's also what survives a host that never activated cleanly.
 *
 * Never throws. A restore that fails halfway must not wedge an uninstall or an activation, and the
 * user's originals remain in the `~/.codecash` backups for a manual fix either way.
 *
 * TWO DELIBERATE LIMITATIONS vs the in-process `codecash.disable`, recorded so neither reads as an
 * oversight later:
 *
 *  1. It does NOT un-shim the opt-in Codex CLI surface (`host/codexSurfaces.ts`). That restore needs
 *     the vscode-hosted manager, and no PUBLISHED build can have injected it: the surface is compiled
 *     out unless `CODECASH_CODEX_SURFACES=1` is set at build time, which no release path sets, on top
 *     of a separate per-user opt-in. So no shipped user carries a wrapped `codex` binary. Anyone who
 *     built with the flag locally must run `codecash.disable` BEFORE updating to the sunset build —
 *     after updating, nothing here will un-shim it.
 *  2. It restores the panel from the `~/.codecash` disk mirror, not `globalState`. `globalState` is
 *     authoritative and the mirror is best-effort, so a user whose mirror write once failed keeps a
 *     stale `claudeCode.spinnerVerbs` the panel reads. Rare (the mirror is rewritten on every enable),
 *     and the cost is one leftover editor setting they can clear by hand.
 */
import { join } from "node:path";
import { codecashPaths, reconcileTerminalUninstall } from "@codecash/client-core";
import { isEnabled, isDaemonLive, daemonLockPath } from "@codecash/client-core/daemon-lock";
import { writeUserSettingFile } from "./userSettings.js";
import { panelCapturePath, readPanelCapture } from "./panelCapture.js";

/** The flat, dotted settings.json key the Claude Code panel reads its spinner verbs from. */
const PANEL_SETTINGS_KEY = "claudeCode.spinnerVerbs";

/** Put the panel's `claudeCode.spinnerVerbs` back (or delete our key when the user had none). */
function restorePanel(codecashDir: string): void {
  const cap = readPanelCapture(panelCapturePath(codecashDir));
  if (!cap || !cap.userSettingsPath) return; // nothing of ours captured / no known path → leave it alone
  // Comment-preserving JSONC edit; `undefined` deletes our key when the user originally had none.
  writeUserSettingFile(cap.userSettingsPath, PANEL_SETTINGS_KEY, cap.original ?? undefined);
}

export interface RestoreResult {
  /** We put `~/.claude/settings.json` back (false when the CLI owns it — see below). */
  terminalRestored: boolean;
  /** We put the panel's `claudeCode.spinnerVerbs` back (or removed our key). */
  panelRestored: boolean;
}

/**
 * Restore both surfaces. Idempotent — safe to call on every activation, since each half no-ops once
 * there's nothing of ours left to undo.
 *
 * Coexistence with the standalone CLI: if the `codecash` CLI is still serving on this machine (its
 * enabled marker is present, or its daemon is live), the CLI OWNS the terminal surface and is actively
 * rewriting it. Restoring here would clobber a live injection we don't own, so we leave the terminal to
 * the CLI's own `preuninstall` and only restore the panel (which the CLI never touches).
 */
export function restoreAllSurfaces(home: string): RestoreResult {
  const result: RestoreResult = { terminalRestored: false, panelRestored: false };
  try {
    const paths = codecashPaths(home);
    // The CLI's enabled marker lives at `~/.codecash/enabled` (apps/cli cliPaths).
    const cliOwnsTerminal =
      isEnabled(join(paths.codecashDir, "enabled")) ||
      isDaemonLive(daemonLockPath(paths.codecashDir), Date.now());
    if (!cliOwnsTerminal) {
      reconcileTerminalUninstall(paths); // restore ~/.claude/settings.json if it's ours
      result.terminalRestored = true;
    }
    try {
      restorePanel(paths.codecashDir);
      result.panelRestored = true;
    } catch {
      /* panel restore is best-effort — never let it strand the terminal restore above */
    }
  } catch {
    /* swallow — teardown must never wedge on our own cleanup */
  }
  return result;
}
