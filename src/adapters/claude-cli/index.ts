import type { AdServeResponse } from "@codecash/shared";
import type { InjectionAdapter, PreflightResult } from "../types.js";
import { codecashPaths, type CodecashPaths } from "../../lib/paths.js";
import { installClaudeCliAdapter, uninstallClaudeCliAdapter } from "../../lib/settings.js";
import { writeAdCache, writeWorkspaceAdCache } from "../../lib/adCache.js";
import { workspaceKey } from "../../lib/workspaceKey.js";
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

  async pushAd(serve: AdServeResponse): Promise<void> {
    const cache = {
      adText: serve.creative.adText,
      clickUrl: serve.creative.clickUrl,
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
    // Refresh the spinner verb to the current ad (idempotent re-install; spinnerVerbs is global).
    installClaudeCliAdapter(this.paths, {
      renderScriptPath: this.renderScriptPath,
      adText: serve.creative.adText,
    });
  }
}
