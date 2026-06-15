import type { Adapter as AdapterId, AdServeResponse } from "@codecash/shared";

export interface PreflightResult {
  ok: boolean;
  ccVersion: string | null;
  reason?: string;
}

/**
 * An injection surface. claude-cli ships first; codex-cli / claude-code / codex implement the
 * same contract later (PLAN §2). Keeping this interface stable is what lets the extension host
 * treat every surface uniformly.
 */
export interface InjectionAdapter {
  readonly id: AdapterId;
  /** Check the surface is present + compatible before touching anything. */
  preflight(): Promise<PreflightResult>;
  /** Begin injecting (back up + patch config). Optionally seed the first ad text. */
  enable(adText?: string): Promise<void>;
  /** Restore the user's original config. Must be safe to call when not enabled. */
  disable(): Promise<void>;
  /** Push a freshly-fetched ad to the surface (write cache + refresh the spinner verb). */
  pushAd(serve: AdServeResponse): Promise<void>;
}
