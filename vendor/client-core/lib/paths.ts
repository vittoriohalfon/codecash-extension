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
  // Codex honours CODEX_HOME (falls back to ~/.codex) — mirror it so we target the real config.toml.
  const codexHome =
    process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
      ? process.env.CODEX_HOME
      : join(home, ".codex");
  const codecashDir = join(home, CODECASH_DIR);
  return {
    home,
    claudeSettings,
    /** the Codex TUI config we add `[tui].status_line_command` to (TOML). */
    codexSettings: join(codexHome, "config.toml"),
    codecashDir,
    adCache: join(codecashDir, AD_CACHE_FILE),
    /** dir of per-workspace ad caches (`ads/<workspaceKey>.json`) — distinct ad per parallel session. */
    adsDir: join(codecashDir, CODECASH_ADS_SUBDIR),
    /** cross-instance presence heartbeat (multi-instance concurrent crediting). */
    presence: join(codecashDir, "presence.json"),
    /** cross-window registry of each window's current ad → coalesce the one global spinner verb. */
    spinnerRegistry: join(codecashDir, "spinner.json"),
    /** where we persist a captured pre-existing statusLine so the render script can chain it. */
    config: join(codecashDir, "config.json"),
    /** backup of the user's original settings.json for clean restore. */
    settingsBackup: join(codecashDir, SETTINGS_BACKUP_FILE),
    /** capture of whether we created the Codex `[tui]` table, for a clean codex-cli restore. */
    codexConfig: join(codecashDir, "codex-config.json"),
    /** belt-and-suspenders backup of the user's original ~/.codex/config.toml. */
    codexSettingsBackup: join(codecashDir, "codex-config-backup.toml"),
    /** pre-rendered one-line ad banner the codex-cli PATH-shim wrapper prints at launch. */
    codexCliBanner: join(codecashDir, "codex-cli-banner.txt"),
    /** records how we shimmed the codex binary (symlink vs regular file) for a clean restore. */
    codexCliShimMeta: join(codecashDir, "codex-cli-shim.json"),
    /** backup copy of the pristine codex shim, used only when it was a regular file (not a symlink). */
    codexCliShimBackup: join(codecashDir, "codex-cli-shim.orig"),
    /** opt-in marker: presence enables the experimental, off-by-default Codex ad surfaces. */
    codexOptIn: join(codecashDir, "codex.enabled"),
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
