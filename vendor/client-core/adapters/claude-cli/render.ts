/**
 * codecash status-line renderer — the display half of the `statusLine` script.
 *
 * PRIME DIRECTIVE: never break the user's CLI (PLAN §6). The per-app entry that calls this
 * (apps/extension/src/render.ts, apps/cli/src/render.ts) wraps it so it NEVER throws and always
 * exits 0; this module itself swallows every error and returns "". It reads the local ad cache only —
 * it never makes a network call — and bounds the chained status-line child with a hard timeout.
 *
 * It is a clean-room reimplementation of the documented interface (ad-cache JSON shape, OSC 8
 * framing, statusLine chaining, the statusLine stdin payload), not a copy of any existing renderer.
 *
 * D7: `workspaceKey` is imported from the shared client core (no longer a byte-copied twin). esbuild
 * INLINES it into the standalone `render.mjs`, so the bundle stays zero-runtime-dependency while the
 * algorithm has exactly one definition (lib/workspaceKey.ts) the host and renderer both use — a
 * structural guarantee they can never drift, replacing the old "keep the two copies in sync" comment.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { workspaceKey, sessionKey } from "../../lib/workspaceKey.js";

const AD_CACHE_TTL_MS = 10 * 60 * 1000; // mirrors @codecash/shared AD_CACHE_TTL_MS
const ADS_SUBDIR = "ads"; // mirrors @codecash/shared CODECASH_ADS_SUBDIR
const SESSION_CACHE_PREFIX = "s-"; // mirrors @codecash/shared CODECASH_SESSION_CACHE_PREFIX
const CHILD_TIMEOUT_MS = 1500; // hard cap on the chained status-line command
const AD_BRAND_SEP = " · "; // space + U+00B7 MIDDLE DOT — mirrors lib/adLabel.ts formatAdLabel()
const AD_SEP = "∿"; // U+223F SINE WAVE — LEGACY: separated the ad text from the advertiser domain
const OSC = "\x1b]8;;";
const ST = "\x1b\\";

function osc8(url: string, text: string): string {
  return `${OSC}${url}${ST}${text}${OSC}${ST}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Read the statusLine stdin payload Claude Code pipes in. Returns "" on a TTY or any read error. */
export function readStatusLineStdin(): string {
  try {
    if (process.stdin.isTTY) return "";
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Claude Code passes a JSON object on stdin; pull the stable project dir (fallback to cwd). */
export function projectDirFromStdin(stdin: string): string | null {
  try {
    const j: unknown = JSON.parse(stdin);
    if (!isRecord(j)) return null;
    const ws = j.workspace;
    if (isRecord(ws) && typeof ws.project_dir === "string") return ws.project_dir;
    if (typeof j.cwd === "string") return j.cwd;
    return null;
  } catch {
    return null;
  }
}

/**
 * The Claude Code session id from the statusLine stdin payload — the per-SESSION key the CLI daemon
 * uses so two terminals in the SAME repo each accrue (D11). Claude Code includes `session_id` in the
 * payload; we fall back to null when it's absent so the caller can degrade to a per-terminal id.
 */
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

/** Read one fresh, valid ad-cache file → the clickable `<brand> · <text>` line, or null. */
function adLineFromCache(file: string, now: number): string | null {
  try {
    if (!existsSync(file)) return null;
    const c: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(c)) return null;
    const { adText, clickUrl, brandName, displayDomain, ts } = c;
    if (typeof adText !== "string" || typeof clickUrl !== "string" || typeof ts !== "number") {
      return null;
    }
    if (now - ts >= AD_CACHE_TTL_MS) return null; // stale
    // Prefer the brand-prefixed line `<brand> · <ad>` (e.g. "Ramp · save time and money"). Fall back to
    // the LEGACY `ad· <ad> ∿ <domain>` form only for caches written before brand support (e.g. a stale
    // cache mid-upgrade), so a developer never sees a flash of the old shape once a fresh ad lands.
    const label =
      typeof brandName === "string" && brandName.length > 0
        ? `${brandName}${AD_BRAND_SEP}${adText}`
        : typeof displayDomain === "string" && displayDomain.length > 0
          ? `ad· ${adText} ${AD_SEP} ${displayDomain}`
          : `ad· ${adText}`;
    return osc8(clickUrl, label);
  } catch {
    return null;
  }
}

/**
 * This terminal's ad line, resolved most-specific surface first:
 *   1. per-SESSION cache (`ads/s-<sessionKey>.json`) — the confirmed per-session surface the CLI daemon
 *      writes, so two terminals in the SAME repo each show the creative THEIR own serve is crediting;
 *   2. per-WORKSPACE cache (`ads/<workspaceKey>.json`) — the extension's per-window surface (and the
 *      fallback when Claude Code didn't pass a `session_id`);
 *   3. the legacy global `ad-cache.json`.
 */
function renderAdLine(dir: string, sessionId: string | null, projectDir: string | null, now: number): string | null {
  if (sessionId) {
    const s = adLineFromCache(join(dir, ADS_SUBDIR, `${SESSION_CACHE_PREFIX}${sessionKey(sessionId)}.json`), now);
    if (s) return s;
  }
  if (projectDir) {
    const ws = adLineFromCache(join(dir, ADS_SUBDIR, `${workspaceKey(projectDir)}.json`), now);
    if (ws) return ws;
  }
  return adLineFromCache(join(dir, "ad-cache.json"), now);
}

/** Output of the user's pre-existing statusLine, captured at install — stacked below the ad. */
function renderChained(dir: string, stdin: string): string | null {
  try {
    const cfgPath = join(dir, "config.json");
    if (!existsSync(cfgPath)) return null;
    const cfg: unknown = JSON.parse(readFileSync(cfgPath, "utf8"));
    if (!isRecord(cfg)) return null;
    const sl = cfg.capturedStatusLine;
    if (!isRecord(sl) || sl.type !== "command" || typeof sl.command !== "string") return null;
    const res = spawnSync(sl.command, {
      shell: true,
      input: stdin,
      timeout: CHILD_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 1 << 20,
    });
    if (res.status !== 0 || typeof res.stdout !== "string" || res.stdout.length === 0) return null;
    return res.stdout.replace(/\n+$/, "");
  } catch {
    return null;
  }
}

export interface RenderOptions {
  /** absolute path to the ~/.codecash dir holding the ad cache(s) + captured statusLine config. */
  codecashDir: string;
  /** the raw statusLine stdin payload from Claude Code (used for the per-workspace ad + chaining). */
  stdin: string;
  /** clock (ms) for the cache-freshness check. */
  now: number;
}

/**
 * Build the status line: this terminal's fresh ad (per-session → per-workspace → global cache, see
 * {@link renderAdLine}) stacked above any captured pre-existing statusLine output. Returns the joined
 * string WITHOUT a trailing newline, or "" when there's nothing to show. Never throws — every leg
 * swallows its own errors — so the caller can write the result and exit 0 unconditionally.
 */
export function renderStatusLine(opts: RenderOptions): string {
  const lines: string[] = [];
  const ad = renderAdLine(
    opts.codecashDir,
    sessionIdFromStdin(opts.stdin),
    projectDirFromStdin(opts.stdin),
    opts.now,
  );
  if (ad) lines.push(ad);
  const chained = renderChained(opts.codecashDir, opts.stdin);
  if (chained) lines.push(chained);
  return lines.join("\n");
}
