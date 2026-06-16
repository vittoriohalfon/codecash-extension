import { existsSync, readFileSync } from "node:fs";
import type { CodecashPaths } from "./paths.js";
import {
  installClaudeCliAdapter,
  buildStatusLineCommand,
  isCurrentStatusLine,
  type StatusLineVariant,
} from "./settings.js";

/**
 * R1 self-healing: make the claude-cli injection true again if `~/.claude/settings.json` drifted out
 * from under us — an external write (a Claude Code update, the user, another extension) removed or
 * replaced our `statusLine`, or our render-script path went stale after an extension update.
 *
 * Idempotent by design: it re-writes settings.json ONLY when our statusLine is actually missing /
 * changed / wrong-path. When nothing drifted it does NOT write, which is what lets a file watcher
 * fed by our OWN writes converge in a single read instead of looping (re-asserting writes identical
 * bytes → the next self-triggered event reads "in sync" → stop). It never throws — a missing or
 * unparseable settings file is reported, never thrown, to honor "never break the user's CLI".
 *
 * spinnerVerbs is intentionally NOT a drift signal here: it changes every rotation and is owned by
 * pushAd. We only refresh it (to the current fresh ad) as a side effect of a statusLine re-install,
 * so reassert never fights pushAd over the verb.
 */
export interface ReassertOptions {
  /** absolute path to the bundled render script (dist/render.mjs) — the current one. */
  renderScriptPath: string;
  /** which client is reasserting — selects the expected statusLine command shape. Default "extension". */
  variant?: StatusLineVariant;
  /** for the CLI variant: the absolute node binary (process.execPath). */
  nodePath?: string;
  /** current fresh ad text to restore as the spinner verb on re-install; omit when none is fresh. */
  adText?: string;
  /** clock injection for tests (forwarded to installClaudeCliAdapter's one-time capture stamp). */
  now?: () => number;
}

export type ReassertResult =
  | { reasserted: true }
  | { reasserted: false; reason: "in_sync" | "no_settings" | "unparseable" | "install_failed" };

export function reassertInjection(paths: CodecashPaths, opts: ReassertOptions): ReassertResult {
  let raw: string;
  try {
    if (!existsSync(paths.claudeSettings)) return { reasserted: false, reason: "no_settings" };
    raw = readFileSync(paths.claudeSettings, "utf8");
  } catch {
    // We only ever PATCH an existing settings.json; if we can't even read it, do nothing.
    return { reasserted: false, reason: "no_settings" };
  }

  let statusLine: unknown;
  try {
    statusLine = (JSON.parse(raw) as { statusLine?: unknown }).statusLine;
  } catch {
    // Unparseable JSON: refuse to touch it (installClaudeCliAdapter would refuse too).
    return { reasserted: false, reason: "unparseable" };
  }

  // In sync only when the live command is byte-for-byte the one we'd write now — so a stale path after
  // an update (or a variant/marker change) counts as drift and gets rewritten, while our own identical
  // re-writes converge in one read instead of looping.
  const expected = buildStatusLineCommand({
    renderScriptPath: opts.renderScriptPath,
    variant: opts.variant,
    nodePath: opts.nodePath,
  });
  if (isCurrentStatusLine(statusLine, expected)) return { reasserted: false, reason: "in_sync" };

  // Drift: re-install. installClaudeCliAdapter is idempotent and won't re-capture (config.json
  // already exists from the original enable), so the user's true original stays preserved.
  const res = installClaudeCliAdapter(paths, {
    renderScriptPath: opts.renderScriptPath,
    variant: opts.variant,
    nodePath: opts.nodePath,
    adText: opts.adText,
    now: opts.now,
  });
  return res.ok ? { reasserted: true } : { reasserted: false, reason: "install_failed" };
}
