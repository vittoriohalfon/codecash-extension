import type { AdServeResponse } from "@codecash/shared";
import type { InjectionAdapter, PreflightResult } from "../types.js";
import { codecashPaths, type CodecashPaths } from "../../lib/paths.js";
import {
  installClaudeCliAdapter,
  uninstallClaudeCliAdapter,
  type StatusLineVariant,
} from "../../lib/settings.js";
import {
  writeAdCache,
  writeWorkspaceAdCache,
  writeSessionAdCache,
  clearSessionAdCache,
  readAdCache,
  isAdFresh,
} from "../../lib/adCache.js";
import { reassertInjection, type ReassertResult } from "../../lib/reassert.js";
import { workspaceKey, sessionKey } from "../../lib/workspaceKey.js";
import { formatAdLabel } from "../../lib/adLabel.js";
import { detectClaudeCodeVersion, isCompatible } from "../../lib/preflight.js";

/** How the adapter writes the statusLine command — see buildStatusLineCommand. */
export interface ClaudeCliAdapterOptions {
  /** "extension" (default) or "cli" (the CLI daemon → D15 hybrid command). */
  variant?: StatusLineVariant;
  /** for the CLI variant: the absolute node binary (process.execPath). */
  nodePath?: string;
  /**
   * Claude Code `session_id` this adapter serves (the CLI daemon sets it per adopted session). When set,
   * {@link ClaudeCliAdapter.cacheAd} writes a per-SESSION cache (`ads/s-<sessionKey>.json`) instead of a
   * per-workspace one, so two terminals in the SAME repo render+credit their OWN creative (the
   * visibility rule). Unset for the extension (one controller per VS Code window → per-workspace cache).
   */
  sessionId?: string;
}

/**
 * The claude-cli adapter — the stable, config-file injection surface (PLAN §2). Renders the ad as
 * the Claude Code spinner verb + a clickable status line, with backup/restore and chain-capture.
 *
 * The per-session status line is the confirmed, billed surface (the visibility rule): with a
 * `sessionId` (the CLI daemon, per adopted session) the ad is cached per-SESSION so two terminals in the
 * SAME repo each render+credit their OWN creative; without one (the extension, one controller per VS
 * Code window) it falls back to a per-`workspaceDir` cache. The spinner verb stays machine-global
 * (Claude Code only supports one `spinnerVerbs`), so it reflects whichever session wrote last and is
 * NEVER multiplied into extra impressions.
 */
export class ClaudeCliAdapter implements InjectionAdapter {
  readonly id = "claude-cli" as const;

  private readonly variant: StatusLineVariant;
  private readonly nodePath: string | undefined;
  private readonly sessionId: string | undefined;

  constructor(
    private readonly renderScriptPath: string,
    private readonly paths: CodecashPaths = codecashPaths(),
    private readonly workspaceDir: string | null = null,
    opts: ClaudeCliAdapterOptions = {},
  ) {
    this.variant = opts.variant ?? "extension";
    this.nodePath = opts.nodePath;
    this.sessionId = opts.sessionId;
  }

  async preflight(): Promise<PreflightResult> {
    const ccVersion = detectClaudeCodeVersion();
    if (ccVersion == null) {
      return { ok: false, ccVersion: null, reason: "Claude Code CLI not found on PATH" };
    }
    if (!isCompatible(ccVersion)) {
      return { ok: false, ccVersion, reason: `Claude Code ${ccVersion} lacks spinnerVerbs support` };
    }
    return { ok: true, ccVersion };
  }

  async enable(adText?: string): Promise<void> {
    const res = installClaudeCliAdapter(this.paths, {
      renderScriptPath: this.renderScriptPath,
      variant: this.variant,
      nodePath: this.nodePath,
      adText,
    });
    if (!res.ok) {
      throw new Error(`codecash: refused to enable — ${res.reason}`);
    }
  }

  async disable(): Promise<void> {
    uninstallClaudeCliAdapter(this.paths);
  }

  /**
   * Re-assert the injection if settings.json drifted out from under us (R1 self-healing). Idempotent:
   * writes ONLY on real drift, so it never fights the per-rotation pushAd and a watcher fed by our own
   * writes converges in one read. Pulls the current fresh ad from the cache so a re-install restores
   * the live spinner verb (and leaves the verb alone when nothing is fresh). Synchronous + never
   * throws — safe to call from a file-watcher / backstop-timer callback. claude-cli-specific (the
   * webview adapters don't inject via settings.json), so it's not on the InjectionAdapter contract.
   */
  reassert(): ReassertResult {
    const cache = readAdCache(this.paths);
    // Restore the brand-prefixed spinner verb (`<brand> · <ad>`) the live ad is showing, not the raw copy.
    const adText = cache && isAdFresh(cache) ? formatAdLabel(cache.brandName, cache.adText) : undefined;
    return reassertInjection(this.paths, {
      renderScriptPath: this.renderScriptPath,
      variant: this.variant,
      nodePath: this.nodePath,
      adText,
    });
  }

  /**
   * Write the freshly-fetched ad to the local cache(s) only — the per-SESSION cache when this adapter
   * serves a specific `session_id` (the CLI daemon, so two same-repo terminals each render their OWN
   * ad), else the per-workspace cache (the extension), plus the legacy global cache. Does NOT touch
   * `~/.claude/settings.json`. The CLI daemon uses this per-session and coalesces ONE global
   * spinnerVerbs write per tick (A1/T20) instead of re-installing settings on every session's serve.
   */
  cacheAd(serve: AdServeResponse): void {
    const cache = {
      adText: serve.creative.adText,
      clickUrl: serve.creative.clickUrl,
      // Stored raw; the status-line render script composes `<brandName> · <adText>` itself.
      brandName: serve.creative.brandName,
      displayDomain: serve.creative.displayDomain,
      iconUrl: serve.creative.iconUrl,
      creativeId: serve.creative.creativeId,
      token: serve.token,
      ts: Date.now(),
    };
    if (this.sessionId) {
      // Per-SESSION surface: the render script reads `ads/s-<sessionKey>.json` first, so this session's
      // terminal shows exactly the creative its own serve is crediting (no same-repo collision).
      writeSessionAdCache(this.paths, sessionKey(this.sessionId), cache);
    } else if (this.workspaceDir) {
      writeWorkspaceAdCache(this.paths, workspaceKey(this.workspaceDir), cache);
    }
    // Legacy global cache → last-resort fallback (render with no session/workspace match, older scripts).
    writeAdCache(this.paths, cache);
  }

  /** Drop this session's per-session cache file when the daemon reaps the session (best-effort). */
  clearCache(): void {
    if (this.sessionId) clearSessionAdCache(this.paths, sessionKey(this.sessionId));
  }

  /**
   * Refresh ONLY the global spinner verb to `label` (idempotent re-install; spinnerVerbs is machine-
   * global). The CLI daemon calls this once per tick with the latest ad — coalescing the global write
   * across all sessions (A1/T20) — rather than per-serve.
   */
  setSpinnerVerb(label: string): void {
    installClaudeCliAdapter(this.paths, {
      renderScriptPath: this.renderScriptPath,
      variant: this.variant,
      nodePath: this.nodePath,
      adText: label,
    });
  }

  async pushAd(serve: AdServeResponse): Promise<void> {
    this.cacheAd(serve);
    // Refresh the spinner verb to the current ad — brand-prefixed (`<brand> · <ad>`), so the "thinking"
    // verb reads e.g. "Ramp · save time and money" (idempotent re-install; spinnerVerbs is global).
    this.setSpinnerVerb(formatAdLabel(serve.creative.brandName, serve.creative.adText));
  }
}
