/**
 * codecash Codex status-line renderer — the display half of the `[tui].status_line_command` script.
 *
 * PRIME DIRECTIVE: never break the user's CLI (PLAN §6). The per-app entry that calls this
 * (apps/extension/src/renderCodex.ts) wraps it so it NEVER throws and always exits 0; this module
 * swallows every error and returns "". It reads the local ad cache only — never a network call.
 *
 * Codex feeds the command a JSON object on stdin (keys: `cwd`, `session_id`, `model`, …) and renders
 * the FIRST stdout line as a status-line segment, stripping ANSI/OSC escapes. So — unlike the Claude
 * surface — we emit PLAIN text (`<brand> · <ad>`): no OSC 8 framing (Codex would strip it) and no
 * chaining (Codex composes its own built-in items; our line is just one extra segment).
 *
 * TODO(clickable): Codex's status line currently wires hyperlinks only for its PR-number item, so the
 * ad is visible/impression-credited but not yet clickable. Revisit if Codex exposes a per-segment link.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { workspaceKey, sessionKey } from "../../lib/workspaceKey.js";

const AD_CACHE_TTL_MS = 10 * 60 * 1000; // mirrors @codecash/shared AD_CACHE_TTL_MS
const ADS_SUBDIR = "ads"; // mirrors @codecash/shared CODECASH_ADS_SUBDIR
const SESSION_CACHE_PREFIX = "s-"; // mirrors @codecash/shared CODECASH_SESSION_CACHE_PREFIX
const AD_BRAND_SEP = " · "; // space + U+00B7 MIDDLE DOT — mirrors lib/adLabel.ts formatAdLabel()

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Read the stdin payload Codex pipes in. Returns "" on a TTY or any read error. */
export function readStatusLineStdin(): string {
  try {
    if (process.stdin.isTTY) return "";
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Codex passes a JSON object on stdin; pull the working directory (the per-workspace key source). */
export function cwdFromStdin(stdin: string): string | null {
  try {
    const j: unknown = JSON.parse(stdin);
    if (!isRecord(j)) return null;
    if (typeof j.cwd === "string" && j.cwd.length > 0) return j.cwd;
    return null;
  } catch {
    return null;
  }
}

/** The Codex `session_id` from the stdin payload — the per-SESSION key (two terminals, same repo). */
export function sessionIdFromStdin(stdin: string): string | null {
  try {
    const j: unknown = JSON.parse(stdin);
    if (!isRecord(j)) return null;
    if (typeof j.session_id === "string" && j.session_id.length > 0) return j.session_id;
    return null;
  } catch {
    return null;
  }
}

/** Read one fresh, valid ad-cache file → the plain `<brand> · <text>` line, or null. */
function adLineFromCache(file: string, now: number): string | null {
  try {
    if (!existsSync(file)) return null;
    const c: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(c)) return null;
    const { adText, brandName, ts } = c;
    if (typeof adText !== "string" || typeof ts !== "number") return null;
    if (now - ts >= AD_CACHE_TTL_MS) return null; // stale
    return typeof brandName === "string" && brandName.length > 0
      ? `${brandName}${AD_BRAND_SEP}${adText}`
      : adText;
  } catch {
    return null;
  }
}

/**
 * This terminal's ad line, resolved most-specific surface first (same precedence as the Claude
 * renderer): per-SESSION cache → per-WORKSPACE cache → legacy global `ad-cache.json`.
 */
function renderAdLine(
  dir: string,
  sessionId: string | null,
  projectDir: string | null,
  now: number,
): string | null {
  if (sessionId) {
    const s = adLineFromCache(
      join(dir, ADS_SUBDIR, `${SESSION_CACHE_PREFIX}${sessionKey(sessionId)}.json`),
      now,
    );
    if (s) return s;
  }
  if (projectDir) {
    const ws = adLineFromCache(join(dir, ADS_SUBDIR, `${workspaceKey(projectDir)}.json`), now);
    if (ws) return ws;
  }
  return adLineFromCache(join(dir, "ad-cache.json"), now);
}

export interface RenderCodexOptions {
  /** absolute path to the ~/.codecash dir holding the ad cache(s). */
  codecashDir: string;
  /** the raw stdin payload from Codex (used for the per-session / per-workspace ad). */
  stdin: string;
  /** clock (ms) for the cache-freshness check. */
  now: number;
}

/**
 * Build the Codex status-line segment: this terminal's fresh ad (per-session → per-workspace → global
 * cache). Returns the plain-text line, or "" when there's nothing fresh to show. Never throws — every
 * leg swallows its own errors — so the caller can write the result and exit 0 unconditionally.
 */
export function renderCodexStatusLine(opts: RenderCodexOptions): string {
  return (
    renderAdLine(
      opts.codecashDir,
      sessionIdFromStdin(opts.stdin),
      cwdFromStdin(opts.stdin),
      opts.now,
    ) ?? ""
  );
}
