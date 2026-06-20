/**
 * `vscode:uninstall` hook — VS Code runs this as PLAIN node (`node ./dist/uninstall.mjs`; no `vscode`
 * API, no `globalState`) when the user uninstalls the extension, while `dist/` still exists. VS Code
 * has no in-process uninstall callback — `deactivate()` runs on every shutdown/disable, NOT on
 * uninstall — so this is the one deterministic moment to undo what we injected. Without it, an
 * uninstall strands our `statusLine` (now pointing at the about-to-be-deleted `dist/render.mjs`) and a
 * frozen spinner ad. (VS Code does NOT run this on an extension UPDATE, only a real uninstall — so
 * updating the extension never turns ads off.)
 *
 * It restores BOTH surfaces the way `codecash.disable` does, from the captures we mirrored to
 * `~/.codecash` while running: the terminal surface via client-core's config.json, the panel surface
 * via panel-capture.json (globalState is unreadable here, which is why we mirror it to disk). Never
 * throws; always exits 0 so a hiccup can't wedge the uninstall — and the originals also remain in the
 * `~/.codecash` backups for a manual restore.
 *
 * Coexistence with the standalone CLI: if the `codecash` CLI is still serving on this machine (its
 * enabled marker is present or its daemon is live), the CLI now OWNS the terminal surface — restoring
 * here would clobber the CLI's injection, so we leave the terminal to the CLI's own `preuninstall` and
 * only restore the panel (which the CLI never touches).
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { codecashPaths, reconcileTerminalUninstall } from "@codecash/client-core";
import { isEnabled, isDaemonLive, daemonLockPath } from "@codecash/client-core/daemon-lock";
import { writeUserSettingFile } from "./lib/userSettings.js";
import { panelCapturePath, readPanelCapture } from "./lib/panelCapture.js";

/** The flat, dotted settings.json key the Claude Code panel reads its spinner verbs from. */
const PANEL_SETTINGS_KEY = "claudeCode.spinnerVerbs";

/** Put the panel's `claudeCode.spinnerVerbs` back (or delete our key when the user had none). */
function restorePanel(codecashDir: string): void {
  const cap = readPanelCapture(panelCapturePath(codecashDir));
  if (!cap || !cap.userSettingsPath) return; // nothing of ours captured / no known path → leave it alone
  // Comment-preserving JSONC edit; `undefined` deletes our key when the user originally had none.
  writeUserSettingFile(cap.userSettingsPath, PANEL_SETTINGS_KEY, cap.original ?? undefined);
}

try {
  const paths = codecashPaths(homedir());
  // The CLI's enabled marker lives at `~/.codecash/enabled` (apps/cli cliPaths). If the CLI owns the
  // terminal surface, leave it — its own `npm rm` preuninstall restores it.
  const cliOwnsTerminal =
    isEnabled(join(paths.codecashDir, "enabled")) ||
    isDaemonLive(daemonLockPath(paths.codecashDir), Date.now());
  if (!cliOwnsTerminal) reconcileTerminalUninstall(paths); // restore ~/.claude/settings.json if it's ours
  try {
    restorePanel(paths.codecashDir);
  } catch {
    /* panel restore is best-effort — never let it strand the terminal restore above */
  }
} catch {
  /* swallow — uninstall must never wedge on our cleanup */
}
process.exit(0);
