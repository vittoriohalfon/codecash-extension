import { spawnSync } from "node:child_process";

/**
 * Minimum Claude Code version that supports `spinnerVerbs`. Verified, not a guess:
 *   - Introduced in CC 2.1.23 ("Added customizable spinner verbs setting (`spinnerVerbs`)",
 *     anthropics/claude-code CHANGELOG.md). Earlier builds silently ignore the unknown key —
 *     the setting's zod schema didn't exist — so a lower floor would pass preflight while the
 *     spinner-verb ad never renders (only the statusLine surface would).
 *   - The 2.1.177 binary on this machine embeds `spinnerVerbs: object({ mode: enum(["append",
 *     "replace"]), verbs: array(string) })`, matching exactly what the adapter writes.
 * 2.1.144 hardened it (custom verbs no longer leak into the post-turn "Worked for 5s" message);
 * raise the floor there if that polish becomes a requirement.
 */
export const MIN_CLAUDE_CODE_VERSION = "2.1.23";

/** Read `claude --version` → "2.1.177". Returns null if the CLI isn't found. */
export function detectClaudeCodeVersion(run = defaultRun): string | null {
  const out = run();
  if (out == null) return null;
  const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function defaultRun(): string | null {
  try {
    const res = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 3000 });
    if (res.status !== 0 || typeof res.stdout !== "string") return null;
    return res.stdout;
  } catch {
    return null;
  }
}

/** a >= b for dotted numeric versions. */
export function versionGte(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export function isCompatible(version: string | null): boolean {
  return version != null && versionGte(version, MIN_CLAUDE_CODE_VERSION);
}
