import * as vscode from "vscode";
import { versionGte } from "@codecash/client-core";
import { resolveUserSettingsPath, writeUserSettingFile } from "../lib/userSettings.js";
import {
  isSpinnerVerbsValue,
  PanelSpinnerBridge,
  type SpinnerConfigStore,
  type CaptureStore,
  type CapturedSpinner,
  type SpinnerVerbsValue,
} from "../lib/panelBridge.js";

/**
 * VS Code-side glue for the claude-code (extension panel) surface: detect the installed Claude Code
 * extension, and back {@link PanelSpinnerBridge}'s two stores with the real `claudeCode.spinnerVerbs`
 * setting + `context.globalState`. The bridge logic itself stays vscode-free (lib/panelBridge.ts);
 * this is the thin, untestable-without-vscode shell.
 */

/** Publisher-qualified id of the official Claude Code VS Code extension (same id in VS Code + Cursor). */
const CLAUDE_CODE_EXTENSION_ID = "anthropic.claude-code";

/**
 * Lowest Claude Code extension version we treat as panel-capable. The panel's spinner reads the verb
 * list from `claudeCode.spinnerVerbs` (verified by inspecting the installed 2.1.138 and 2.1.177
 * bundles); the setting's schema first shipped in 2.1.23. This floor is best-effort: writing the
 * setting on an older build is harmless (the panel ignores an unknown key) and crediting stays
 * focus-confirmed (the same basis as the terminal surface); the panel spinner is a shared display
 * line, never a separate billable impression.
 */
export const MIN_CLAUDE_CODE_PANEL_VERSION = "2.1.23";

/** globalState key for the user's captured original `claudeCode.spinnerVerbs` (durable across reloads). */
const PANEL_CAPTURE_KEY = "codecash.panelSpinnerCapture";

export interface PanelDetection {
  /** the extension id we matched (e.g. anthropic.claude-code). */
  id: string;
  /** its version, or null if unreadable. */
  version: string | null;
  /** version ≥ the panel floor (true when the version is unreadable — presence alone is enough). */
  compatible: boolean;
}

/**
 * Detect the installed Claude Code VS Code extension (the panel surface). Returns null when absent or
 * disabled. Matches the canonical id first, then falls back to scanning for an `anthropic*.claude-code`
 * id so editor forks that re-publish under a tweaked id are still found.
 */
export function detectClaudeCodePanel(): PanelDetection | null {
  const ext =
    vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID) ??
    vscode.extensions.all.find((e) => /(^|\.)claude-code$/i.test(e.id) && /anthropic/i.test(e.id));
  if (!ext) return null;
  const raw = (ext.packageJSON as { version?: unknown } | undefined)?.version;
  const version = typeof raw === "string" ? raw : null;
  const compatible = version == null ? true : versionGte(version, MIN_CLAUDE_CODE_PANEL_VERSION);
  return { id: ext.id, version, compatible };
}

/** The flat, dotted settings.json key the Claude Code panel reads its spinner verbs from. */
const SETTINGS_KEY = "claudeCode.spinnerVerbs";

/**
 * Read/write the user-scope `claudeCode.spinnerVerbs`. Reads via `inspect().globalValue` (which DOES
 * work for an unregistered key present in settings.json) so a workspace-scoped value the user set is
 * never captured or clobbered. Writes go through a direct, comment-preserving JSONC settings.json edit
 * ({@link writeUserSettingFile}) — the config API's `update()` rejects this unregistered key. The
 * `settingsPath` is null when the file couldn't be located, in which case a write throws and the host
 * treats the panel surface as unavailable (the CLI surface is unaffected).
 */
export class VsCodeSpinnerConfigStore implements SpinnerConfigStore {
  constructor(private readonly settingsPath: string | null) {}
  readGlobal(): SpinnerVerbsValue | undefined {
    const v = vscode.workspace.getConfiguration("claudeCode").inspect("spinnerVerbs")?.globalValue;
    return isSpinnerVerbsValue(v) ? v : undefined;
  }
  async writeGlobal(value: SpinnerVerbsValue | undefined): Promise<void> {
    if (!this.settingsPath) {
      throw new Error("could not locate VS Code user settings.json — panel surface unavailable");
    }
    writeUserSettingFile(this.settingsPath, SETTINGS_KEY, value);
  }
}

/** Durable capture of the user's original, in `context.globalState` (survives window reloads). */
export class MementoCaptureStore implements CaptureStore {
  constructor(private readonly memento: vscode.Memento) {}
  read(): CapturedSpinner | undefined {
    return this.memento.get<CapturedSpinner>(PANEL_CAPTURE_KEY);
  }
  async write(v: CapturedSpinner | undefined): Promise<void> {
    await this.memento.update(PANEL_CAPTURE_KEY, v);
  }
}

/**
 * Build a panel bridge wired to the live user settings.json + durable capture store. `globalStoragePath`
 * (from `context.globalStorageUri.fsPath`) locates the editor's user settings.json.
 */
export function createPanelBridge(memento: vscode.Memento, globalStoragePath: string): PanelSpinnerBridge {
  const settingsPath = resolveUserSettingsPath(globalStoragePath);
  return new PanelSpinnerBridge(new VsCodeSpinnerConfigStore(settingsPath), new MementoCaptureStore(memento));
}
