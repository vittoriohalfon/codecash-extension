import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { CodecashPaths } from "./paths.js";

/**
 * Safe add/remove of the `[tui].status_line_command` key in ~/.codex/config.toml — the Codex analog of
 * lib/settings.ts. Same prime directive ("never break the user's CLI", PLAN §6), adapted for TOML:
 *   - parse-or-refuse: if config.toml isn't valid TOML, we DON'T touch it.
 *   - re-parse-or-refuse: we re-parse our edited candidate and write ONLY if it's still valid TOML, so a
 *     surgical insertion can never corrupt the user's config.
 *   - surgical + marked: we insert ONE marker-tagged line (instead of stringifying the whole document),
 *     so the user's other keys, comments, and formatting are preserved byte-for-byte.
 *   - capture + backup: a one-time capture (did we create the `[tui]` table?) + a full-file backup, so
 *     disable() restores cleanly and falls back to the exact original on any doubt.
 *
 * Unlike Claude Code, Codex re-runs the configured command on its own interval and reads the ad from
 * the local cache, so the ad text never lives in config.toml — enable() writes the command ONCE and
 * pushAd() only refreshes the cache (see adapters/codex-cli).
 */

/**
 * Ownership marker carried by the line we write, as a trailing TOML comment (`#` → inert to Codex).
 * Lets us recognize our own line for idempotent re-install + clean removal, and never capture it as the
 * user's own. Mirrors lib/settings.ts {@link STATUSLINE_MARKER} for the Claude surface.
 */
export const CODEX_STATUSLINE_MARKER = "codecash-statusline";

/** Matches our marked `status_line_command` line, including its trailing newline, for detect/remove. */
const OUR_LINE_RE =
  /^[ \t]*status_line_command[ \t]*=.*#.*codecash-statusline.*\r?\n?/m;
/** Matches the `[tui]` table header line (optionally followed by a comment). */
const TUI_HEADER_RE = /^[ \t]*\[tui\][ \t]*(?:#.*)?$/m;

export interface CodexInstallOptions {
  /** absolute path to the bundled codex render script (dist/renderCodex.mjs). */
  renderScriptPath: string;
  /** absolute node binary (process.execPath) — covers PATH-less shells. Defaults to "node". */
  nodePath?: string;
  /** seconds before Codex kills the command. Defaults to 5. */
  timeoutSec?: number;
  /** minimum seconds between Codex re-runs. Defaults to 10. */
  intervalSec?: number;
  /** segment placement relative to Codex's built-in items. Defaults to "end". */
  position?: "start" | "end";
  /** clock injection for tests. */
  now?: () => number;
}

export type CodexInstallResult =
  | { ok: true; created: boolean }
  | {
      ok: false;
      reason:
        | "config_unparseable"
        | "user_status_line_command"
        | "would_corrupt_config";
    };

export type CodexUninstallResult =
  | { ok: true; restored: boolean }
  | { ok: false; reason: "config_unparseable" };

interface CodexCapturedConfig {
  /** true when enable() appended a `[tui]` table (so disable() removes it if it's left empty). */
  createdTuiTable: boolean;
  installedAt: number;
}

/** Serialize a string as a TOML basic string (escape backslash/quote/control chars). */
function tomlBasicString(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f]/g, (c) => {
      switch (c) {
        case "\b":
          return "\\b";
        case "\t":
          return "\\t";
        case "\n":
          return "\\n";
        case "\f":
          return "\\f";
        case "\r":
          return "\\r";
        default:
          return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
      }
    });
  return `"${escaped}"`;
}

/** The full `status_line_command = { … } # marker` line we write under `[tui]`. */
function statusLineCommandLine(opts: CodexInstallOptions): string {
  const node = opts.nodePath ?? "node";
  const command = [node, opts.renderScriptPath].map(tomlBasicString).join(", ");
  const timeout = opts.timeoutSec ?? 5;
  const interval = opts.intervalSec ?? 10;
  const position = opts.position ?? "end";
  const value =
    `{ command = [${command}], timeout_sec = ${timeout}, ` +
    `interval_sec = ${interval}, position = ${tomlBasicString(position)} }`;
  return `status_line_command = ${value} # ${CODEX_STATUSLINE_MARKER}`;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path); // atomic on the same filesystem
}

function tuiStatusLineCommand(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const tui = (parsed as Record<string, unknown>).tui;
  if (typeof tui !== "object" || tui === null) return undefined;
  return (tui as Record<string, unknown>).status_line_command;
}

/**
 * Install the codex-cli adapter into config.toml. Idempotent: re-installing rewrites our own line in
 * place. Returns ok:false WITHOUT writing if the file is unparseable, if the user configures their own
 * `status_line_command`, or if the surgical edit would produce invalid TOML — we refuse to risk the CLI.
 */
export function installCodexCliAdapter(
  paths: CodecashPaths,
  opts: CodexInstallOptions,
): CodexInstallResult {
  const now = opts.now ?? Date.now;

  const exists = existsSync(paths.codexSettings);
  let text = "";
  let parsed: unknown = {};
  if (exists) {
    text = readFileSync(paths.codexSettings, "utf8");
    try {
      parsed = parseToml(text);
    } catch {
      return { ok: false, reason: "config_unparseable" };
    }
  }

  const ours = OUR_LINE_RE.test(text);
  const existingCmd = tuiStatusLineCommand(parsed);
  if (existingCmd !== undefined && !ours) {
    // The user (or another tool) already drives the Codex status line — don't fight them.
    return { ok: false, reason: "user_status_line_command" };
  }

  const line = statusLineCommandLine(opts);
  let candidate: string;
  let created = false;
  if (ours) {
    candidate = text.replace(OUR_LINE_RE, `${line}\n`);
  } else if (TUI_HEADER_RE.test(text)) {
    candidate = text.replace(TUI_HEADER_RE, (header) => `${header}\n${line}`);
  } else {
    const sep = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    candidate = `${text}${sep}[tui]\n${line}\n`;
    created = true;
  }

  // Ultimate safety net: never write something that isn't valid TOML.
  try {
    parseToml(candidate);
  } catch {
    return { ok: false, reason: "would_corrupt_config" };
  }

  // Capture the user's original shape exactly once (first, non-ours install).
  if (!ours && !existsSync(paths.codexConfig)) {
    const captured: CodexCapturedConfig = { createdTuiTable: created, installedAt: now() };
    atomicWrite(paths.codexConfig, JSON.stringify(captured, null, 2) + "\n");
    if (exists && !existsSync(paths.codexSettingsBackup)) {
      copyFileSync(paths.codexSettings, paths.codexSettingsBackup);
    }
  }

  atomicWrite(paths.codexSettings, candidate);
  return { ok: true, created };
}

/**
 * Remove our `status_line_command` line, restoring the user's config: drop the marked line (and the
 * `[tui]` table if we created it and it's now empty), preserving every other key/comment the user has.
 * Falls back to the exact captured backup if surgical removal would somehow yield invalid TOML.
 */
export function uninstallCodexCliAdapter(paths: CodecashPaths): CodexUninstallResult {
  if (!existsSync(paths.codexSettings)) {
    cleanupCapture(paths);
    return { ok: true, restored: false };
  }

  const text = readFileSync(paths.codexSettings, "utf8");
  try {
    parseToml(text);
  } catch {
    return { ok: false, reason: "config_unparseable" };
  }

  if (!OUR_LINE_RE.test(text)) {
    cleanupCapture(paths);
    return { ok: true, restored: false };
  }

  let capture: CodexCapturedConfig | undefined;
  try {
    if (existsSync(paths.codexConfig)) {
      capture = JSON.parse(readFileSync(paths.codexConfig, "utf8")) as CodexCapturedConfig;
    }
  } catch {
    /* corrupt capture → still remove our marked line below */
  }

  let candidate = text.replace(OUR_LINE_RE, "");
  if (capture?.createdTuiTable) {
    candidate = removeEmptyTuiTable(candidate);
  }

  try {
    parseToml(candidate);
  } catch {
    // Surgical removal corrupted it (shouldn't happen) — restore the exact original.
    if (existsSync(paths.codexSettingsBackup)) {
      copyFileSync(paths.codexSettingsBackup, paths.codexSettings);
      cleanupCapture(paths);
      return { ok: true, restored: true };
    }
    return { ok: false, reason: "config_unparseable" };
  }

  atomicWrite(paths.codexSettings, candidate);
  cleanupCapture(paths);
  return { ok: true, restored: true };
}

/** Drop a `[tui]` table that we created if removing our line left it with no keys. */
function removeEmptyTuiTable(text: string): string {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => /^[ \t]*\[tui\][ \t]*(?:#.*)?$/.test(l));
  if (idx === -1) return text;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^[ \t]*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const body = lines.slice(idx + 1, end);
  const hasKey = body.some((l) => /^[ \t]*[A-Za-z0-9_.\-"]+[ \t]*=/.test(l));
  if (hasKey) return text;
  lines.splice(idx, end - idx);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function cleanupCapture(paths: CodecashPaths): void {
  for (const f of [paths.codexConfig, paths.codexSettingsBackup]) {
    try {
      unlinkSync(f);
    } catch {
      /* already gone / never written */
    }
  }
}
