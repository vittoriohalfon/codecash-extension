import {
  DEFAULT_VIEW_THRESHOLD_SECONDS,
  VIEW_TICK_INTERVAL_MS,
  STUCK_SESSION_MS,
  type EventType,
} from "@codecash/shared";

/**
 * Pure view-time accumulator for ONE ad serve — the client half of the credit lifecycle
 * (CLAUDE.md): impression_rendered → impression_viewable → view_tick → view_threshold_met, with
 * error_impression as the stuck-session safety net.
 *
 * The claude-cli surface is a terminal the extension host can't see into, so the host feeds this
 * a visibility proxy (VS Code window focus) plus a clock, and this turns it into accrued *visible*
 * time. Accrual is delta-based and clamped, so an unfocused window or a slept laptop doesn't
 * silently bank view time. No `vscode` import → fully unit-testable.
 */

export type ViewPhase = "idle" | "rendered" | "viewable" | "credited" | "errored";

export interface ViewContext {
  serveId: string;
  creativeId: string;
  accruedMs: number;
}

export interface ViewTrackerCallbacks {
  /** Non-billable lifecycle telemetry (→ TelemetryReporter → PostHog): rendered/viewable/view_tick/threshold/error. */
  onTelemetry?(type: EventType, ctx: ViewContext): void;
  /** Cumulative visible time crossed the threshold — fire the billable impression exactly once. */
  onThreshold(ctx: ViewContext): void;
}

/** Clamp a single accrual slice so a sleep/suspend gap can't bank minutes of fake view time. */
const MAX_SLICE_MS = 2 * VIEW_TICK_INTERVAL_MS;

export class ViewTracker {
  private phase: ViewPhase = "idle";
  private serveId = "";
  private creativeId = "";
  private accruedMs = 0;
  private lastAt = 0;
  private startedAt = 0;
  private visible = false;
  private readonly thresholdMs: number;

  constructor(
    private readonly cb: ViewTrackerCallbacks,
    thresholdSeconds: number = DEFAULT_VIEW_THRESHOLD_SECONDS,
    /** Wall-clock lifetime after which an uncredited serve is flagged `error_impression`. */
    private readonly stuckMs: number = STUCK_SESSION_MS,
  ) {
    this.thresholdMs = Math.max(0, thresholdSeconds) * 1000;
  }

  /** A new ad was rendered to the surface — reset accrual and begin tracking. */
  start(serveId: string, creativeId: string, now: number): void {
    this.phase = "rendered";
    this.serveId = serveId;
    this.creativeId = creativeId;
    this.accruedMs = 0;
    this.lastAt = now;
    this.startedAt = now;
    this.visible = false;
    this.cb.onTelemetry?.("impression_rendered", this.ctx());
  }

  /** The surface became (in)visible — VS Code window focus is the proxy on the CLI surface. */
  setVisible(visible: boolean, now: number): void {
    this.accrue(now); // bank the slice under the OLD visibility before flipping
    this.visible = visible;
    if (visible && this.phase === "rendered") {
      this.phase = "viewable";
      this.cb.onTelemetry?.("impression_viewable", this.ctx());
    }
  }

  /** Periodic heartbeat (every VIEW_TICK_INTERVAL_MS): accrue visible time, fire threshold once. */
  tick(now: number): void {
    const wasViewable = this.phase === "viewable";
    this.accrue(now);
    if (wasViewable && this.phase === "viewable") {
      this.cb.onTelemetry?.("view_tick", this.ctx());
    }
    // Stuck-session safety net: a serve that's been mounted far past STUCK_SESSION_MS without ever
    // crediting (a wedged refetch loop or a dead fetch timer leaves it dangling) is flagged ONCE and
    // abandoned, so the funnel records the stall instead of a silent never-resolving serve. Checked
    // after accrual so a serve that just credited this tick is already out of `isActive`.
    if (this.isActive && now - this.startedAt >= this.stuckMs) {
      this.phase = "errored";
      this.cb.onTelemetry?.("error_impression", this.ctx());
    }
  }

  /** Abandon tracking (disable / new fetch). */
  stop(): void {
    this.phase = "idle";
  }

  get currentPhase(): ViewPhase {
    return this.phase;
  }

  /** Still accruing toward a credit (not idle, not yet credited). */
  get isActive(): boolean {
    return this.phase === "rendered" || this.phase === "viewable";
  }

  getAccruedMs(): number {
    return this.accruedMs;
  }

  private accrue(now: number): void {
    let slice = now - this.lastAt;
    this.lastAt = now;
    if (this.phase !== "viewable" || !this.visible) return;
    if (slice < 0) slice = 0;
    if (slice > MAX_SLICE_MS) slice = MAX_SLICE_MS;
    this.accruedMs += slice;
    if (this.accruedMs >= this.thresholdMs) {
      this.phase = "credited";
      this.cb.onTelemetry?.("view_threshold_met", this.ctx());
      this.cb.onThreshold(this.ctx());
    }
  }

  private ctx(): ViewContext {
    return { serveId: this.serveId, creativeId: this.creativeId, accruedMs: this.accruedMs };
  }
}
