import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CodecashPaths } from "./paths.js";

/**
 * Safe read/patch/restore of ~/.claude/settings.json. Every rule here exists to satisfy the
 * "never break the user's CLI" directive (PLAN §6):
 *   - parse-or-refuse: if settings.json isn't valid JSON, we DON'T touch it.
 *   - atomic writes: write a temp file then rename, so a crash can't leave a half-written file.
 *   - chain-capture: stash any pre-existing statusLine/spinnerVerbs and restore them on uninstall,
 *     instead of clobbering the user's config.
 */

export interface StatusLineSpec {
  type: string;
  command: string;
  padding?: number;
  [k: string]: unknown;
}

interface CapturedConfig {
  capturedStatusLine: StatusLineSpec | null;
  capturedSpinnerVerbs: unknown | null;
  installedAt: number;
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path); // atomic on the same filesystem
}

/**
 * True if a statusLine spec is our own render script at the CURRENT path (so we never chain-capture
 * ourselves, and so reassert (R1) can tell drift — incl. a stale path after an extension update —
 * from in-sync). Matching on the path means an old, post-update command no longer counts as "ours".
 */
export function isOurStatusLine(spec: unknown, renderScriptPath: string): boolean {
  return (
    !!spec &&
    typeof spec === "object" &&
    typeof (spec as StatusLineSpec).command === "string" &&
    (spec as StatusLineSpec).command.includes(renderScriptPath)
  );
}

export interface InstallOptions {
  /** absolute path to the bundled render script (dist/render.mjs). */
  renderScriptPath: string;
  /** current ad text to show as the spinner verb; omit to leave spinnerVerbs untouched. */
  adText?: string;
  /** clock injection for tests. */
  now?: () => number;
}

export type InstallResult =
  | { ok: true; chained: boolean }
  | { ok: false; reason: "settings_unparseable" | "no_settings" };

/**
 * Install the claude-cli adapter into settings.json. Idempotent: re-installing updates spinnerVerbs
 * but does not re-capture our own statusLine. Returns ok:false WITHOUT writing if settings are
 * missing/unparseable — we refuse to risk the user's CLI.
 */
export function installClaudeCliAdapter(paths: CodecashPaths, opts: InstallOptions): InstallResult {
  const now = opts.now ?? Date.now;

  let settings: Record<string, unknown>;
  try {
    const existing = readJson<Record<string, unknown>>(paths.claudeSettings);
    if (existing === undefined) return { ok: false, reason: "no_settings" };
    settings = existing;
  } catch {
    return { ok: false, reason: "settings_unparseable" };
  }

  const alreadyInstalled = isOurStatusLine(settings.statusLine, opts.renderScriptPath);

  // Capture the user's originals exactly once (don't overwrite an existing capture, and never
  // capture our own injected statusLine).
  if (!existsSync(paths.config) && !alreadyInstalled) {
    const captured: CapturedConfig = {
      capturedStatusLine: (settings.statusLine as StatusLineSpec | undefined) ?? null,
      capturedSpinnerVerbs: settings.spinnerVerbs ?? null,
      installedAt: now(),
    };
    writeJsonAtomic(paths.config, captured);
  }

  // Back up the whole original settings file once, for a belt-and-suspenders restore.
  if (!existsSync(paths.settingsBackup) && !alreadyInstalled) {
    copyFileSync(paths.claudeSettings, paths.settingsBackup);
  }

  const chained =
    !!settings.statusLine && !alreadyInstalled
      ? true
      : readJson<CapturedConfig>(paths.config)?.capturedStatusLine != null;

  settings.statusLine = {
    type: "command",
    command: `node "${opts.renderScriptPath}"`,
    padding: 0,
  } satisfies StatusLineSpec;

  if (opts.adText !== undefined) {
    settings.spinnerVerbs = { mode: "replace", verbs: [opts.adText] };
  }

  writeJsonAtomic(paths.claudeSettings, settings);
  return { ok: true, chained };
}

export type UninstallResult = { ok: true; restored: boolean } | { ok: false; reason: string };

/**
 * Restore the user's settings surgically: put back the captured statusLine/spinnerVerbs (or delete
 * ours if there was nothing to restore), preserving any unrelated edits the user made since install.
 */
export function uninstallClaudeCliAdapter(paths: CodecashPaths): UninstallResult {
  let settings: Record<string, unknown>;
  try {
    const existing = readJson<Record<string, unknown>>(paths.claudeSettings);
    if (existing === undefined) return { ok: false, reason: "no_settings" };
    settings = existing;
  } catch {
    return { ok: false, reason: "settings_unparseable" };
  }

  const captured = readJson<CapturedConfig>(paths.config);

  if (captured?.capturedStatusLine != null) {
    settings.statusLine = captured.capturedStatusLine;
  } else {
    delete settings.statusLine;
  }

  if (captured?.capturedSpinnerVerbs != null) {
    settings.spinnerVerbs = captured.capturedSpinnerVerbs;
  } else {
    delete settings.spinnerVerbs;
  }

  writeJsonAtomic(paths.claudeSettings, settings);
  return { ok: true, restored: captured != null };
}
