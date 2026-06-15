/**
 * codecash status-line renderer. Runs as `node render.mjs` from ~/.claude/settings.json `statusLine`.
 *
 * PRIME DIRECTIVE: never break the user's CLI (PLAN §6). Therefore this script:
 *   - has ZERO dependencies (bundled standalone) so it can't fail on a missing module,
 *   - is fully synchronous and wrapped so it NEVER throws and always exits 0,
 *   - reads the local ad cache only — it never makes a network call,
 *   - bounds the chained status-line child with a hard timeout,
 *   - prints nothing (or just the chained output) rather than ever erroring.
 *
 * It is a clean-room reimplementation of the documented interface (ad-cache JSON shape, OSC 8
 * framing, statusLine chaining, the statusLine stdin payload), not a copy of any existing renderer.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const AD_CACHE_TTL_MS = 10 * 60 * 1000; // mirrors @codecash/shared AD_CACHE_TTL_MS
const ADS_SUBDIR = "ads"; // mirrors @codecash/shared CODECASH_ADS_SUBDIR
const CHILD_TIMEOUT_MS = 1500; // hard cap on the chained status-line command
const AD_SEP = "∿"; // U+223F SINE WAVE — separates the ad text from the advertiser domain
const OSC = "\x1b]8;;";
const ST = "\x1b\\";

function osc8(url: string, text: string): string {
  return `${OSC}${url}${ST}${text}${OSC}${ST}`;
}

/**
 * Byte-identical mirror of apps/extension/src/lib/workspaceKey.ts (FNV-1a → 8 hex). The host writes
 * `ads/<key>.json` keyed by the VS Code workspace path; here we recompute the key from Claude Code's
 * `workspace.project_dir` so each session reads its OWN ad. KEEP THE TWO COPIES IN SYNC.
 */
function workspaceKey(projectDir: string): string {
  const s = projectDir.replace(/[/\\]+$/, "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function readStdin(): string {
  try {
    if (process.stdin.isTTY) return "";
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Claude Code passes a JSON object on stdin; pull the stable project dir (fallback to cwd). */
function projectDirFromStdin(stdin: string): string | null {
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

/** Read one fresh, valid ad-cache file → the clickable `ad· <text> ∿ <domain>` line, or null. */
function adLineFromCache(file: string, now: number): string | null {
  try {
    if (!existsSync(file)) return null;
    const c: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(c)) return null;
    const { adText, clickUrl, displayDomain, ts } = c;
    if (typeof adText !== "string" || typeof clickUrl !== "string" || typeof ts !== "number") {
      return null;
    }
    if (now - ts >= AD_CACHE_TTL_MS) return null; // stale
    // Append the advertiser's domain as a visible CTA (`∿`-separated) when the serve carried one;
    // omit it cleanly for older serves so the line stays `ad· <text>`.
    const label =
      typeof displayDomain === "string" && displayDomain.length > 0
        ? `ad· ${adText} ${AD_SEP} ${displayDomain}`
        : `ad· ${adText}`;
    return osc8(clickUrl, label);
  } catch {
    return null;
  }
}

/** This session's per-workspace ad if present + fresh; otherwise the legacy global cache. */
function renderAdLine(dir: string, projectDir: string | null, now: number): string | null {
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

function main(): void {
  const dir = join(homedir(), ".codecash");
  const stdin = readStdin();
  const lines: string[] = [];
  const ad = renderAdLine(dir, projectDirFromStdin(stdin), Date.now());
  if (ad) lines.push(ad);
  const chained = renderChained(dir, stdin);
  if (chained) lines.push(chained);
  if (lines.length > 0) process.stdout.write(lines.join("\n") + "\n");
}

try {
  main();
} catch {
  // swallow — never break the CLI
}
