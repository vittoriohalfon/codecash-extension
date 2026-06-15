/**
 * Stable, short key for a workspace/project directory — used to name per-workspace ad caches
 * (`~/.codecash/ads/<key>.json`) so each parallel Claude Code session shows its OWN distinct ad.
 *
 * CRITICAL: this must compute the SAME key on both sides of the wire —
 *   - the extension host hashes its `vscode.workspace.workspaceFolders[0]` path when it writes, and
 *   - the render script hashes Claude Code's `workspace.project_dir` (from statusLine stdin) when it reads.
 * The render script is bundled standalone (zero deps), so it carries a byte-identical copy of this
 * function. If you change the algorithm, change it in BOTH places (see adapters/claude-cli/render.ts).
 *
 * FNV-1a (32-bit) → 8 hex chars. Not cryptographic — just a stable filename-safe fingerprint.
 */
export function workspaceKey(projectDir: string): string {
  const s = projectDir.replace(/[/\\]+$/, ""); // normalize: ignore trailing slashes
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
