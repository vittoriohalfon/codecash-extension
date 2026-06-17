import type { AdServeResponse, EventType, EarningsSnapshot, TargetingTag } from "@codecash/shared";
import { ApiClient, UnauthorizedError, type NextAd } from "./apiClient.js";
import { ViewTracker, type ViewContext } from "./viewTracker.js";
import { readServeClaims } from "./tokenClaims.js";
import { impressionKey, clickKey } from "./idempotency.js";

/**
 * Orchestrates the client money loop for one device:
 *   fetchAndRender → (host feeds focus + ticks) → at view_threshold_met → creditCurrentImpression.
 *
 * It owns the loop's *logic* but not its *cadence*: the host drives timing by calling tick()/
 * setVisible() and re-invoking fetchAndRender() on a schedule. That split keeps every decision here
 * synchronous-ish and unit-testable, with no `vscode` and no timers of its own.
 *
 * Trust model: the controller can't fabricate money. It only returns the server-signed token; the
 * server verifies sig + idempotency + budget on every event. Idempotency keys are serve-derived so
 * a retried send is a no-op, never a double charge.
 */

export type ServeState =
  | "stopped"
  | "serving" // an ad is rendered and accruing view time
  | "idle-killed" // server killswitch on (204 killed)
  | "idle-empty" // no funded inventory (204 no-inventory)
  | "auth-required" // device token missing/expired and refresh failed
  | "error"; // transient fetch error; the host will retry next cycle

export type CreditOutcome =
  | { kind: "credited"; deduped: boolean; creditedMicros: number }
  | { kind: "skipped"; reason: "no-serve" | "already-sent" | "no-claims" }
  | { kind: "auth-required" }
  | { kind: "error"; detail: string };

/** Where a fetched ad is rendered — the injection adapter (claude-cli) implements this. */
export interface AdSink {
  pushAd(serve: AdServeResponse): Promise<void> | void;
}

export interface ControllerDeps {
  api: ApiClient;
  sink: AdSink;
  now: () => number;
  /** Visibility proxy — VS Code window focus on the CLI surface. */
  isVisible: () => boolean;
  onTelemetry?: (type: EventType, ctx: ViewContext) => void;
  /**
   * Earnings changed or were re-reported — host updates the widget. Fires when the server piggybacks
   * an earnings snapshot (any outcome — authoritative, so always applied) OR, against an older server
   * with no snapshot, when a credit actually landed. `earnings` is undefined in that fallback case.
   */
  onEarned?: (creditedMicros: number, earnings?: EarningsSnapshot) => void;
  onState?: (state: ServeState) => void;
  /** Refresh succeeded — persist the rotated token (SecretStorage) so getToken() returns it. */
  onTokenRefreshed?: (token: string) => Promise<void> | void;
  /**
   * Opt-in "relevant ads" seam (docs/targeting-plan.md Layer 3). When provided, its coarse stack tags
   * are sent with each fetch so the server can weight the auction toward relevant ads. OMITTED by
   * default → fetches carry no tags (identical to the untargeted behavior). The host wires this ONLY
   * once the user has consented (Layer 6), typically `() => deriveDeviceTags(workspaceRoot, {adapter})`.
   * Best-effort: a throw/reject here is swallowed and the fetch proceeds untargeted.
   */
  getTags?: () => readonly TargetingTag[] | Promise<readonly TargetingTag[]>;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

export class ServeController {
  private state: ServeState = "stopped";
  private current: AdServeResponse | null = null;
  private currentServeId: string | null = null;
  private tracker: ViewTracker | null = null;
  private impressionSent = false;

  constructor(private readonly deps: ControllerDeps) {}

  getState(): ServeState {
    return this.state;
  }

  getCurrentServe(): AdServeResponse | null {
    return this.current;
  }

  /** Forward a focus change into the active tracker. */
  setVisible(visible: boolean): void {
    this.tracker?.setVisible(visible, this.deps.now());
  }

  /** Periodic heartbeat — accrues visible time and fires the threshold once. */
  tick(): void {
    this.tracker?.tick(this.deps.now());
  }

  /** Stop accruing; the host clears its timers and (on disable) restores settings separately. */
  stop(): void {
    this.tracker?.stop();
    this.tracker = null;
    this.current = null;
    this.currentServeId = null;
    this.impressionSent = false;
    this.setState("stopped");
  }

  /**
   * Fetch the next ad and render it. Sets up a fresh tracker primed to the server's view threshold,
   * and seeds visibility from the host so accrual starts immediately if the window is focused.
   */
  async fetchAndRender(): Promise<ServeState> {
    // Resolve opt-in targeting tags (best-effort: a failure must never disturb serving → untargeted).
    let tags: readonly TargetingTag[] | undefined;
    if (this.deps.getTags) {
      try {
        tags = await this.deps.getTags();
      } catch {
        tags = undefined;
      }
    }

    let next: NextAd;
    try {
      next = await this.withAuthRetry(() => this.deps.api.fetchNextAd(tags));
    } catch (err) {
      if (err instanceof UnauthorizedError) return this.setState("auth-required");
      this.deps.log?.("error", "fetchNextAd failed", err);
      return this.setState("error");
    }

    if (next.kind === "none") {
      this.tracker?.stop();
      this.tracker = null;
      this.current = null;
      this.currentServeId = null;
      return this.setState(next.reason === "killed" ? "idle-killed" : "idle-empty");
    }

    const serve = next.serve;
    const claims = readServeClaims(serve.token);
    if (!claims) {
      // Can't build an idempotency key without the serveId — render nothing rather than guess.
      this.deps.log?.("warn", "ad-serve token had no readable claims; skipping");
      return this.setState("error");
    }

    await this.deps.sink.pushAd(serve);

    this.current = serve;
    this.currentServeId = claims.serveId;
    this.impressionSent = false;
    this.tracker = new ViewTracker(
      {
        onTelemetry: (type, ctx) => this.deps.onTelemetry?.(type, ctx),
        onThreshold: () => void this.creditCurrentImpression(),
      },
      serve.viewThresholdSeconds,
    );
    this.tracker.start(claims.serveId, claims.creativeId, this.deps.now());
    this.tracker.setVisible(this.deps.isVisible(), this.deps.now());
    return this.setState("serving");
  }

  /** Post the billable impression for the current serve. Idempotent + retry-safe. */
  async creditCurrentImpression(): Promise<CreditOutcome> {
    const serve = this.current;
    const serveId = this.currentServeId;
    if (!serve || !serveId) return { kind: "skipped", reason: "no-serve" };
    if (this.impressionSent) return { kind: "skipped", reason: "already-sent" };

    this.impressionSent = true; // guard re-entry; reset on a retryable failure below
    const accruedMs = this.tracker?.getAccruedMs() ?? serve.viewThresholdSeconds * 1000;
    try {
      const r = await this.withAuthRetry(() =>
        this.deps.api.postImpression({
          token: serve.token,
          idempotencyKey: impressionKey(serveId),
          viewMs: Math.round(accruedMs),
          occurredAt: this.deps.now(),
        }),
      );
      if (r.earnings || (!r.deduped && r.creditedMicros > 0))
        this.deps.onEarned?.(r.creditedMicros, r.earnings);
      this.deps.log?.("info", `impression ${r.deduped ? "deduped" : "credited"} ${r.creditedMicros}µ$`);
      return { kind: "credited", ...r };
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        this.impressionSent = false;
        this.setState("auth-required");
        return { kind: "auth-required" };
      }
      this.impressionSent = false; // allow a retry on the next tick/cycle
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.log?.("error", "impression post failed", err);
      return { kind: "error", detail };
    }
  }

  /**
   * Post the billable click for the current serve (50× an impression). The parent impression must
   * have been credited first; we key the click off the SAME serve. On the terminal surface a real
   * click signal needs a server-side redirect (deferred) — this path is exercised by tests/harness
   * and is ready for the webview adapters that can observe clicks directly.
   */
  async creditCurrentClick(): Promise<CreditOutcome> {
    const serve = this.current;
    const serveId = this.currentServeId;
    if (!serve || !serveId) return { kind: "skipped", reason: "no-serve" };
    try {
      const r = await this.withAuthRetry(() =>
        this.deps.api.postClick({
          token: serve.token,
          impressionIdempotencyKey: impressionKey(serveId),
          idempotencyKey: clickKey(serveId),
          occurredAt: this.deps.now(),
        }),
      );
      if (r.earnings || (!r.deduped && r.creditedMicros > 0))
        this.deps.onEarned?.(r.creditedMicros, r.earnings);
      this.deps.log?.("info", `click ${r.deduped ? "deduped" : "credited"} ${r.creditedMicros}µ$`);
      return { kind: "credited", ...r };
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        this.setState("auth-required");
        return { kind: "auth-required" };
      }
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.log?.("error", "click post failed", err);
      return { kind: "error", detail };
    }
  }

  /** Run `fn`; on a 401 try ONE token refresh, persist it, and retry. Bubbles the 401 if refresh fails. */
  private async withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      try {
        const fresh = await this.deps.api.refreshToken();
        await this.deps.onTokenRefreshed?.(fresh);
      } catch {
        throw err; // refresh failed → surface the original 401 so the host prompts re-sign-in
      }
      return await fn();
    }
  }

  private setState(state: ServeState): ServeState {
    if (state !== this.state) {
      this.state = state;
      this.deps.onState?.(state);
    }
    return state;
  }
}
