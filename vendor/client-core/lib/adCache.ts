import { unlinkSync } from "node:fs";
import { AD_CACHE_TTL_MS, AdCacheSchema, type AdCache } from "@codecash/shared";
import { readTextFileTolerant, writeFileAtomic } from "./atomicFile.js";
import { workspaceAdCachePath, sessionAdCachePath, type CodecashPaths } from "./paths.js";

/**
 * Atomic JSON write so a crash can't leave the render script a half-written file. Goes through the
 * hardened {@link writeFileAtomic} (unique temp name + Windows-lock retry + orphan cleanup) so two
 * sessions writing per-session caches in the same dir can't race a shared temp.
 */
function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value));
}

/**
 * The local ad cache the render script reads. The HOST writes it (after fetching an ad); the
 * render script only ever reads it and never phones home (PLAN §2).
 */
export function writeAdCache(paths: CodecashPaths, cache: AdCache): void {
  writeJsonAtomic(paths.adCache, cache);
}

/**
 * Per-workspace ad cache so each parallel Claude Code session shows its OWN distinct ad. The render
 * script resolves the same key from Claude Code's `workspace.project_dir` and reads this file; it
 * falls back to the legacy global cache when no per-workspace file matches (see render.ts).
 */
export function writeWorkspaceAdCache(paths: CodecashPaths, key: string, cache: AdCache): void {
  writeJsonAtomic(workspaceAdCachePath(paths, key), cache);
}

/**
 * Per-SESSION ad cache (the confirmed per-session status-line surface). The CLI daemon writes one per
 * adopted `session_id` so two terminals in the SAME repo each render+credit their OWN creative — the
 * render script resolves the same key from the statusLine `session_id` and reads it FIRST, ahead of the
 * per-workspace + global fallbacks (see render.ts). Keyed by `sessionKey(sessionId)`.
 */
export function writeSessionAdCache(paths: CodecashPaths, key: string, cache: AdCache): void {
  writeJsonAtomic(sessionAdCachePath(paths, key), cache);
}

/** Remove a per-session ad cache (best-effort) when its session is reaped — TTL is the backstop. */
export function clearSessionAdCache(paths: CodecashPaths, key: string): void {
  try {
    unlinkSync(sessionAdCachePath(paths, key));
  } catch {
    /* already gone / never written */
  }
}

export function readAdCache(paths: CodecashPaths): AdCache | null {
  try {
    const text = readTextFileTolerant(paths.adCache);
    if (text === undefined) return null;
    return AdCacheSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

export function isAdFresh(cache: AdCache, now: number = Date.now(), ttlMs: number = AD_CACHE_TTL_MS): boolean {
  return now - cache.ts < ttlMs;
}
