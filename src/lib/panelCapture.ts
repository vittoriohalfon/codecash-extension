import { rmSync } from "node:fs";
import { join } from "node:path";
import { readTextFileTolerant, writeFileAtomic } from "@codecash/client-core";

/**
 * On-disk mirror of the panel surface's captured original `claudeCode.spinnerVerbs`. The host keeps
 * `context.globalState` as its live source of truth (see panelSurface.ts), but the `vscode:uninstall`
 * node script runs as PLAIN node — no `vscode`, no `globalState` — so it can't read that capture. This
 * file is the bridge: every capture write is mirrored here, and the uninstall hook reads it to put the
 * panel setting back exactly the way `codecash.disable` does.
 *
 * Kept as its OWN file under `~/.codecash` (not `config.json`, the terminal capture) so it never
 * disturbs the terminal install's create-once bookkeeping, and so a panel-only user — who has no
 * terminal surface — still gets a clean restore. Same parse-or-refuse + atomic-write discipline as the
 * rest of our settings handling; every helper is total (never throws) so the best-effort host mirror
 * and the must-not-wedge uninstall hook can call it freely.
 */

const PANEL_CAPTURE_FILE = "panel-capture.json";

export interface PanelCapture {
  /** the user's original `claudeCode.spinnerVerbs` before we injected (null = they had none). */
  original: unknown | null;
  /** absolute path to the editor's user settings.json, so the uninstall hook can restore the key. */
  userSettingsPath: string | null;
}

export function panelCapturePath(codecashDir: string): string {
  return join(codecashDir, PANEL_CAPTURE_FILE);
}

export function readPanelCapture(path: string): PanelCapture | undefined {
  try {
    const text = readTextFileTolerant(path);
    if (text === undefined) return undefined;
    const j: unknown = JSON.parse(text);
    return j && typeof j === "object" ? (j as PanelCapture) : undefined;
  } catch {
    return undefined; // unreadable/corrupt → behave as "no capture" rather than throw
  }
}

/**
 * Persist the capture, or FORGET it when `value === undefined` (mirrors the host clearing its
 * globalState capture on disable, so a later uninstall doesn't restore a stale value). Atomic write;
 * the delete is best-effort. Never throws — callers treat this as best-effort.
 */
export function writePanelCapture(path: string, value: PanelCapture | undefined): void {
  if (value === undefined) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* already gone */
    }
    return;
  }
  writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n");
}
