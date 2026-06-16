/**
 * FNV-1a (32-bit) → 8 hex chars. Not cryptographic — just a stable, filename-safe fingerprint.
 * The single hash definition behind both {@link workspaceKey} and {@link sessionKey}; esbuild INLINES
 * it into the standalone zero-dep `render.mjs`, so the host and renderer can never drift (D7).
 */
function fnv1a8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Stable, short key for a workspace/project directory — used to name per-workspace ad caches
 * (`~/.codecash/ads/<key>.json`) so each parallel Claude Code session shows its OWN distinct ad.
 *
 * CRITICAL: this must compute the SAME key on both sides of the wire —
 *   - the extension host hashes its `vscode.workspace.workspaceFolders[0]` path when it writes, and
 *   - the render script hashes Claude Code's `workspace.project_dir` (from statusLine stdin) when it reads.
 * Both sides import this one definition (esbuild inlines it into render.mjs), so they can't drift.
 */
export function workspaceKey(projectDir: string): string {
  return fnv1a8(projectDir.replace(/[/\\]+$/, "")); // normalize: ignore trailing slashes
}

/**
 * Stable, short key for a Claude Code SESSION id — used to name per-session ad caches
 * (`~/.codecash/ads/s-<key>.json`). This is the confirmed per-session status-line surface: two terminals
 * in the SAME repo share a `project_dir` (so `workspaceKey` collides) but have DISTINCT `session_id`s, so
 * keying the cache by session is what lets each render+credit its OWN creative (the visibility rule).
 * The CLI daemon hashes the session it adopted (write); the render script hashes `session_id` from the
 * statusLine stdin (read) — same definition, so the keys agree. `session_id` is opaque → hashed as-is.
 */
export function sessionKey(sessionId: string): string {
  return fnv1a8(sessionId);
}
