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
 * Explicit, stable ownership marker carried by BOTH the extension and CLI statusLine commands (T23).
 * Appended as a trailing shell comment so it's inert at runtime (POSIX shells drop everything after
 * `#`; on cmd.exe it's harmless trailing args the render script ignores) yet always present in the
 * STORED command string for matching. This is what makes ownership detection variant-agnostic: the
 * extension can recognize the CLI's statusLine and vice-versa, without either knowing the other's path
 * — load-bearing for coexistence (one owner of the terminal surface) and for never capturing the
 * other variant's command as the user's original.
 */
export const STATUSLINE_MARKER = "codecash-statusline";

/** Which codecash client wrote the statusLine — the command shape differs (see buildStatusLineCommand). */
export type StatusLineVariant = "extension" | "cli";

export interface StatusLineCommandOptions {
  /** absolute path to the bundled render script (dist/render.mjs). */
  renderScriptPath: string;
  /** "extension" (`node "<path>"`) or "cli" (the D15 hybrid with a `|| codecash render` fallback). */
  variant?: StatusLineVariant;
  /** for the CLI variant: the absolute node binary (process.execPath) — covers PATH-less shells. */
  nodePath?: string;
}

/**
 * Build the `statusLine` command string for a render script. Both variants end with the
 * {@link STATUSLINE_MARKER} comment so ownership is detectable across variants.
 *   - extension: `node "<path>" # codecash-statusline`
 *   - cli (D15 hybrid): `"<nodePath>" "<path>" || codecash render # codecash-statusline` — the
 *     absolute node+script path covers PATH-less / nvm non-interactive shells, and the
 *     `|| codecash render` fallback recovers if the absolute path drifts after an
 *     `npm i -g codecash@latest` (the global `codecash` bin re-resolves the current render script).
 */
export function buildStatusLineCommand(opts: StatusLineCommandOptions): string {
  const marker = ` # ${STATUSLINE_MARKER}`;
  if (opts.variant === "cli") {
    const node = opts.nodePath ?? "node";
    return `"${node}" "${opts.renderScriptPath}" || codecash render${marker}`;
  }
  return `node "${opts.renderScriptPath}"${marker}`;
}

/**
 * Variant-agnostic ownership: is this spec ANY codecash statusLine? Matches the explicit marker (which
 * both variants carry) OR — for migration — an already-installed extension's marker-LESS legacy
 * `node "<renderScriptPath>"` command when that path is known. Used so we never chain-capture our own
 * (or the other variant's) statusLine as the user's original, and for coexistence ownership checks.
 */
export function isOurStatusLine(spec: unknown, renderScriptPath?: string): boolean {
  if (!spec || typeof spec !== "object") return false;
  const cmd = (spec as StatusLineSpec).command;
  if (typeof cmd !== "string") return false;
  if (cmd.includes(STATUSLINE_MARKER)) return true; // any codecash variant (marker era)
  // Migration: an extension installed before the marker existed wrote `node "<path>"` with no marker.
  if (renderScriptPath && cmd.includes(renderScriptPath)) return true;
  return false;
}

/**
 * Exact-current check for R1 reassert: is the live statusLine byte-for-byte the command we'd write
 * now? Distinct from {@link isOurStatusLine} (ownership) — it's how reassert tells a drifted/stale-path
 * codecash command (rewrite it) from in-sync (leave it), without rewriting every refresh.
 */
export function isCurrentStatusLine(spec: unknown, expectedCommand: string): boolean {
  return (
    !!spec &&
    typeof spec === "object" &&
    (spec as StatusLineSpec).command === expectedCommand
  );
}

export interface InstallOptions {
  /** absolute path to the bundled render script (dist/render.mjs). */
  renderScriptPath: string;
  /** which client is installing — selects the statusLine command shape. Defaults to "extension". */
  variant?: StatusLineVariant;
  /** for the CLI variant: the absolute node binary (process.execPath). */
  nodePath?: string;
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
    command: buildStatusLineCommand({
      renderScriptPath: opts.renderScriptPath,
      variant: opts.variant,
      nodePath: opts.nodePath,
    }),
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
