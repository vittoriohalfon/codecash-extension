import type { AdServeResponse } from "@codecash/shared";
import type { InjectionAdapter, PreflightResult } from "../types.js";
import { codecashPaths, type CodecashPaths } from "../../lib/paths.js";
import { installClaudeCliAdapter, uninstallClaudeCliAdapter } from "../../lib/settings.js";
import { writeAdCache, writeWorkspaceAdCache, readAdCache, isAdFresh } from "../../lib/adCache.js";
import { reassertInjection, type ReassertResult } from "../../lib/reassert.js";
import { workspaceKey } from "../../lib/workspaceKey.js";
import { formatAdLabel } from "../../lib/adLabel.js";
import { detectClaudeCodeVersion, isCompatible } from "../../lib/preflight.js";

/**
 * The claude-cli adapter — the stable, config-file injection surface (PLAN §2). Renders the ad as
 * the Claude Code spinner verb + a clickable status line, with backup/restore and chain-capture.
 *
 * `workspaceDir` (this VS Code window's project folder) keys a per-workspace ad cache so parallel
 * Claude Code sessions each show their OWN distinct creative. The spinner verb stays machine-global
 * (Claude Code only supports one `spinnerVerbs`), so it reflects whichever session wrote last; the
 * always-visible, per-session surface is the status line.
 */
export class ClaudeCliAdapter implements InjectionAdapter {
  readonly id = "claude-cli" as const;

  constructor(
    private readonly renderScriptPath: string,
    private readonly paths: CodecashPaths = codecashPaths(),
    private readonly workspaceDir: string | null = null,
  ) {}

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
    return reassertInjection(this.paths, { renderScriptPath: this.renderScriptPath, adText });
  }

  async pushAd(serve: AdServeResponse): Promise<void> {
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
    // Per-workspace cache → this session's terminal renders ITS own ad (distinct per parallel session).
    if (this.workspaceDir) {
      writeWorkspaceAdCache(this.paths, workspaceKey(this.workspaceDir), cache);
    }
    // Legacy global cache → fallback for sessions whose project dir doesn't match + older render scripts.
    writeAdCache(this.paths, cache);
    // Refresh the spinner verb to the current ad — brand-prefixed (`<brand> · <ad>`), so the "thinking"
    // verb reads e.g. "Ramp · save time and money" (idempotent re-install; spinnerVerbs is global).
    installClaudeCliAdapter(this.paths, {
      renderScriptPath: this.renderScriptPath,
      adText: formatAdLabel(serve.creative.brandName, serve.creative.adText),
    });
  }
}
