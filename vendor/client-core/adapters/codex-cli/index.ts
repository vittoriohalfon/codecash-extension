import type { AdServeResponse } from "@codecash/shared";
import type { InjectionAdapter, PreflightResult } from "../types.js";
import { codecashPaths, type CodecashPaths } from "../../lib/paths.js";
import { installCodexCliAdapter, uninstallCodexCliAdapter } from "../../lib/codexSettings.js";
import {
  writeAdCache,
  writeWorkspaceAdCache,
  writeSessionAdCache,
  clearSessionAdCache,
} from "../../lib/adCache.js";
import { workspaceKey, sessionKey } from "../../lib/workspaceKey.js";
import { detectCodexVersion, isCodexCompatible, CODEX_MIN_VERSION } from "../../lib/preflight.js";

/** Set to "1" to bypass the version gate and test against a source-built codex (the hook is unreleased). */
const CODEX_FORCE_ENV = "CODECASH_CODEX_FORCE";

export interface CodexCliAdapterOptions {
  /** absolute node binary (process.execPath) written into config.toml — covers PATH-less shells. */
  nodePath?: string;
  /** Codex `session_id` this adapter serves (per-SESSION cache, like the Claude CLI daemon). */
  sessionId?: string;
  /** seconds before Codex kills the render command. Defaults to 5. */
  timeoutSec?: number;
  /** minimum seconds between Codex re-runs. Defaults to 10. */
  intervalSec?: number;
  /** segment placement relative to Codex's built-in items. Defaults to "end". */
  position?: "start" | "end";
}

/**
 * The codex-cli adapter — the config-file injection surface for OpenAI's Codex CLI (PLAN §2), the
 * sibling of {@link ClaudeCliAdapter}. It writes a single `[tui].status_line_command` entry to
 * ~/.codex/config.toml pointing at our render script; Codex re-runs that command on its interval, feeds
 * it session JSON on stdin, and renders the first stdout line (the cached ad) as a status-line segment.
 *
 * Unlike Claude Code there is no spinner-verb equivalent and the ad text never lives in config.toml:
 * `enable()` writes the command ONCE and `pushAd()` only refreshes the local cache the script reads.
 *
 * GATED: no released Codex ships `status_line_command` yet (we contributed it upstream — see
 * lib/preflight.ts {@link CODEX_MIN_VERSION}), so `preflight()` reports not-ready on every released
 * Codex until then. Set `CODECASH_CODEX_FORCE=1` to test against a source-built codex.
 */
export class CodexCliAdapter implements InjectionAdapter {
  readonly id = "codex-cli" as const;

  private readonly nodePath: string | undefined;
  private readonly sessionId: string | undefined;
  private readonly timeoutSec: number | undefined;
  private readonly intervalSec: number | undefined;
  private readonly position: "start" | "end" | undefined;

  constructor(
    private readonly renderScriptPath: string,
    private readonly paths: CodecashPaths = codecashPaths(),
    private readonly workspaceDir: string | null = null,
    opts: CodexCliAdapterOptions = {},
  ) {
    this.nodePath = opts.nodePath;
    this.sessionId = opts.sessionId;
    this.timeoutSec = opts.timeoutSec;
    this.intervalSec = opts.intervalSec;
    this.position = opts.position;
  }

  async preflight(): Promise<PreflightResult> {
    const version = detectCodexVersion();
    if (version == null) {
      return { ok: false, ccVersion: null, reason: "Codex CLI not found on PATH" };
    }
    if (process.env[CODEX_FORCE_ENV] === "1") {
      return { ok: true, ccVersion: version };
    }
    if (!isCodexCompatible(version)) {
      return {
        ok: false,
        ccVersion: version,
        reason: `Codex ${version} lacks tui.status_line_command (needs ≥ ${CODEX_MIN_VERSION}); set ${CODEX_FORCE_ENV}=1 to override`,
      };
    }
    return { ok: true, ccVersion: version };
  }

  async enable(): Promise<void> {
    const res = installCodexCliAdapter(this.paths, {
      renderScriptPath: this.renderScriptPath,
      nodePath: this.nodePath,
      timeoutSec: this.timeoutSec,
      intervalSec: this.intervalSec,
      position: this.position,
    });
    if (!res.ok) {
      throw new Error(`codecash: refused to enable codex — ${res.reason}`);
    }
  }

  async disable(): Promise<void> {
    uninstallCodexCliAdapter(this.paths);
  }

  /**
   * Write the freshly-fetched ad to the local cache(s) — per-SESSION when this adapter serves a
   * `session_id` (two same-repo terminals each render their OWN ad), else per-workspace, plus the legacy
   * global cache. Does NOT touch config.toml. Mirrors {@link ClaudeCliAdapter.cacheAd}.
   */
  cacheAd(serve: AdServeResponse): void {
    const cache = {
      adText: serve.creative.adText,
      clickUrl: serve.creative.clickUrl,
      brandName: serve.creative.brandName,
      displayDomain: serve.creative.displayDomain,
      iconUrl: serve.creative.iconUrl,
      creativeId: serve.creative.creativeId,
      token: serve.token,
      ts: Date.now(),
    };
    if (this.sessionId) {
      writeSessionAdCache(this.paths, sessionKey(this.sessionId), cache);
    } else if (this.workspaceDir) {
      writeWorkspaceAdCache(this.paths, workspaceKey(this.workspaceDir), cache);
    }
    writeAdCache(this.paths, cache);
  }

  /** Drop this session's per-session cache file when the daemon reaps the session (best-effort). */
  clearCache(): void {
    if (this.sessionId) clearSessionAdCache(this.paths, sessionKey(this.sessionId));
  }

  /**
   * Refresh the ad. Codex re-runs the render command on its own interval and reads the cache, so unlike
   * the Claude surface there is no spinner verb to rewrite — updating the cache is the whole job.
   */
  async pushAd(serve: AdServeResponse): Promise<void> {
    this.cacheAd(serve);
  }
}
