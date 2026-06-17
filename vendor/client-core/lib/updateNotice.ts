import { versionGte } from "./preflight.js";

/**
 * The PASSIVE update notice (R4-safe). codecash deliberately has NO out-of-band updater — it ships
 * only through signed channels (npm for the CLI, the Marketplace/Open VSX for the extension) and
 * never fetches or runs code at runtime. This module does none of that: it takes the client's own
 * baked-in VERSION plus two plain version STRINGS the server advertised on /api/health, compares
 * them, and returns a one-line message telling the user to update by hand. No download, no exec, no
 * new network endpoint — just a string compare and a string out.
 *
 * The caller surfaces the returned line on interactive commands the user is already reading
 * (`codecash status`, `codecash install`); a `null` return means "you're current — say nothing".
 */

/** The two server-advertised versions the notice reasons about; either may be null ("no opinion"). */
export interface UpdateAdvice {
  /** Latest published CLI version, e.g. "0.1.3". */
  latestCliVersion: string | null;
  /** Minimum supported CLI version; below it the notice escalates. */
  minCliVersion: string | null;
}

/** The exact command we tell users to run — the only supported update path for the global CLI. */
export const CODECASH_UPGRADE_CMD = "npm i -g codecash@latest";

/** Dotted numeric, 1–4 parts (e.g. "0", "0.1", "0.1.2"). `versionGte` reads garbage as NaN and
 * compares it as "older", so we must reject non-versions BEFORE comparing or we'd nag on bad data. */
function looksLikeVersion(v: string): boolean {
  return /^\d+(\.\d+){0,3}$/.test(v.trim());
}

/**
 * Build the update notice for a client on `currentVersion`, or null if it's current (or the server
 * has no opinion / advertised an unparseable version — we never nag on bad data). The below-minimum
 * case wins and uses stronger wording; otherwise a plain "newer version available" line.
 */
export function updateNoticeFor(currentVersion: string, advice: UpdateAdvice): string | null {
  if (!looksLikeVersion(currentVersion)) return null;
  // Ignore any advertised value that isn't a clean dotted-numeric version (see looksLikeVersion).
  const minCliVersion =
    advice.minCliVersion && looksLikeVersion(advice.minCliVersion) ? advice.minCliVersion : null;
  const latestCliVersion =
    advice.latestCliVersion && looksLikeVersion(advice.latestCliVersion) ? advice.latestCliVersion : null;

  // Below the minimum supported version → escalate. `versionGte(a,b)` is `a >= b`, so the negation is
  // "current is strictly older than the floor".
  if (minCliVersion && !versionGte(currentVersion, minCliVersion)) {
    return (
      `⚠ codecash ${currentVersion} is below the minimum supported version (${minCliVersion}); ` +
      `some features may stop working. Update now: ${CODECASH_UPGRADE_CMD}`
    );
  }

  if (latestCliVersion && !versionGte(currentVersion, latestCliVersion)) {
    return (
      `↑ A newer codecash is available (${latestCliVersion}; you have ${currentVersion}). ` +
      `Update: ${CODECASH_UPGRADE_CMD}`
    );
  }

  return null;
}
