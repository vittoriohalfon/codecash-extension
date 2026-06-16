import { homedir } from "node:os";
import { join } from "node:path";
import {
  CODECASH_DIR,
  AD_CACHE_FILE,
  SETTINGS_BACKUP_FILE,
  CODECASH_ADS_SUBDIR,
  CODECASH_SESSION_CACHE_PREFIX,
} from "@codecash/shared";

/** Resolve all the on-disk locations the claude-cli adapter touches. */
export function codecashPaths(home: string = homedir()) {
  const claudeSettings = join(home, ".claude", "settings.json");
  const codecashDir = join(home, CODECASH_DIR);
  return {
    home,
    claudeSettings,
    codecashDir,
    adCache: join(codecashDir, AD_CACHE_FILE),
    /** dir of per-workspace ad caches (`ads/<workspaceKey>.json`) — distinct ad per parallel session. */
    adsDir: join(codecashDir, CODECASH_ADS_SUBDIR),
    /** cross-instance presence heartbeat (multi-instance concurrent crediting). */
    presence: join(codecashDir, "presence.json"),
    /** where we persist a captured pre-existing statusLine so the render script can chain it. */
    config: join(codecashDir, "config.json"),
    /** backup of the user's original settings.json for clean restore. */
    settingsBackup: join(codecashDir, SETTINGS_BACKUP_FILE),
  };
}

export type CodecashPaths = ReturnType<typeof codecashPaths>;

/** Per-workspace ad-cache file path for a given workspace key (see lib/workspaceKey.ts). */
export function workspaceAdCachePath(paths: CodecashPaths, key: string): string {
  return join(paths.adsDir, `${key}.json`);
}

/**
 * Per-SESSION ad-cache file path for a given session key (see lib/workspaceKey.ts `sessionKey`). The
 * `s-` prefix keeps session and workspace caches in separate namespaces within `ads/` (so their 8-hex
 * keys can't collide). The render script computes this same path from `session_id` — keep them mirrored.
 */
export function sessionAdCachePath(paths: CodecashPaths, key: string): string {
  return join(paths.adsDir, `${CODECASH_SESSION_CACHE_PREFIX}${key}.json`);
}
