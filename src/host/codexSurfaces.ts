import { existsSync } from "node:fs";
import type { AdServeResponse } from "@codecash/shared";
import {
  CodexCliWrapperAdapter,
  CodexCliAdapter,
  findCodexShim,
  type CodecashPaths,
  type InjectionAdapter,
} from "@codecash/client-core";

/** Either Codex-CLI adapter: the config status-line driver or the PATH-shim banner. Both have cacheAd. */
type CodexCliSurface = InjectionAdapter & { cacheAd(serve: AdServeResponse): void };

/**
 * Self-contained manager for the opt-in **Codex CLI** ad surface — the `codex-cli` PATH-shim banner,
 * or (when forced) the config status-line driver. Kept entirely out of {@link CodecashService}'s
 * claude-cli money loop so the default (gate-off) path is byte-for-byte unchanged: the service makes a
 * handful of gated calls (detect / enable / pushAd / disable) and this owns the rest.
 *
 * The Codex *panel* (VS Code) surface was removed: reaching it required patching OpenAI's extension
 * bundle on disk + relaxing its CSP, which crosses the clean-room/ToS guardrail in CLAUDE.md
 * ("Reach surfaces through config, never by injecting another extension's webview"). Only the
 * config-driven CLI surface remains.
 *
 * Crediting model (matches the claude-code panel): the impression stays HOST-driven via the
 * ServeController — this is a bonus DISPLAY surface, never an extra billable count.
 *
 * CLI surface selection is EXPLICIT and safety-gated:
 *  - With `CODECASH_CODEX_FORCE=1` (the user asserts a Codex that has the `[tui].status_line_command`
 *    hook — e.g. a build from the upstream-PR branch) we use the CONFIG adapter: it writes
 *    `status_line_command` and Codex renders a LIVE status-line ad. This is the real surface.
 *  - Otherwise we use the PATH-shim BANNER (a startup print). We deliberately do NOT trust the version
 *    floor for this — no RELEASED Codex ships the hook yet, and writing the key to a codex that doesn't
 *    understand it could break the CLI. So the live config surface is opt-in via the force flag until a
 *    real release ships the hook and the floor is corrected.
 */
export interface CodexSurfaceDeps {
  paths: CodecashPaths;
  /** Absolute path to the bundled Codex render script (dist/renderCodex.mjs) for the config adapter. */
  renderCodexScriptPath: string;
  /** This window's workspace dir, for the per-workspace ad cache the render script reads. */
  workspaceDir: string | null;
  log: (msg: string) => void;
  reportError: (e: unknown, where: string) => void;
}

export interface CodexDetection {
  cli: boolean;
  /** Human label for the success toast, or null when no codex surface is available. */
  label: string | null;
}

export class CodexSurfaceManager {
  private cli: CodexCliSurface | null = null;
  private active = false;

  constructor(private readonly deps: CodexSurfaceDeps) {}

  /** True when the user asserts a hook-enabled Codex → drive the LIVE status line, not the banner. */
  private useConfigCli(): boolean {
    return process.env.CODECASH_CODEX_FORCE === "1";
  }

  /** Construct the Codex-CLI adapter for the current mode (config status-line vs PATH-shim banner). */
  private makeCli(): CodexCliSurface | null {
    if (this.useConfigCli()) {
      return new CodexCliAdapter(this.deps.renderCodexScriptPath, this.deps.paths, this.deps.workspaceDir);
    }
    const shim = findCodexShim();
    return shim ? new CodexCliWrapperAdapter(shim, this.deps.paths) : null;
  }

  /** Whether a codex CLI surface is present + compatible right now (best-effort, never throws). */
  async detect(): Promise<CodexDetection> {
    let cli = false;
    try {
      const a = this.makeCli();
      if (a) cli = (await a.preflight()).ok;
    } catch (e) {
      this.deps.reportError(e, "codex.detect.cli");
    }
    return { cli, label: cli ? "the Codex CLI" : null };
  }

  /**
   * Inject the codex CLI surface, best-effort. Idempotent: re-running on activation reuses the adapter.
   * Returns true if the surface came up.
   */
  async enable(seed?: string): Promise<boolean> {
    let any = false;
    try {
      const a = this.cli ?? this.makeCli();
      if (a && (await a.preflight()).ok) {
        await a.enable(seed);
        this.cli = a;
        any = true;
      }
    } catch (e) {
      this.deps.reportError(e, "codex.enable.cli");
    }
    this.active = any;
    return any;
  }

  /** Push the fresh ad to the CLI banner / status-line cache. */
  pushAd(serve: AdServeResponse): void {
    try {
      this.cli?.cacheAd(serve);
    } catch (e) {
      this.deps.reportError(e, "codex.pushAd");
    }
  }

  /** Restore the codex CLI surface. Safe to call when nothing was enabled. */
  async disable(): Promise<void> {
    try {
      await this.cli?.disable();
    } catch (e) {
      this.deps.reportError(e, "codex.disable.cli");
    }
    this.cli = null;
    this.active = false;
  }
}

/** True iff a `~/.codecash/codex.enabled` opt-in marker file is present. */
export function codexOptInFileExists(paths: CodecashPaths): boolean {
  try {
    return existsSync(paths.codexOptIn);
  } catch {
    return false;
  }
}
