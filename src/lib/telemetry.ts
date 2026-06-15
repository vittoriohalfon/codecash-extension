import type { Adapter, EventType, TelemetryReport } from "@codecash/shared";
import type { ViewContext } from "./viewTracker.js";

/**
 * Buffers the ViewTracker's funnel milestones and flushes them to the server in batches. This is
 * the client end of the usage/funnel telemetry that was previously computed and dropped: the
 * tracker emits the lifecycle, the host feeds it here, and the server forwards it to PostHog.
 *
 * Two deliberate choices:
 *   - `view_tick` is NOT forwarded. It fires every second purely to drive accrual; sending it to
 *     PostHog would be ~1 event/sec/active-dev of pure heartbeat noise and cost. The funnel only
 *     needs the milestones (rendered → viewable → threshold), so we forward those.
 *   - Best-effort, vscode-free, never throws: the sink's failures are swallowed so a telemetry
 *     blip can't disturb the money loop, and there are no timers of its own — the host flushes it.
 */

/** The funnel milestones worth a server-side event; `view_tick` is intentionally excluded. */
const FORWARDED: ReadonlySet<EventType> = new Set<EventType>([
  "impression_rendered",
  "impression_viewable",
  "view_threshold_met",
  "click",
  "error_impression",
]);

export interface TelemetrySink {
  /** Send a batch of telemetry reports. Should be fire-and-forget and never reject. */
  postTelemetry(events: TelemetryReport[]): Promise<void> | void;
}

export class TelemetryReporter {
  private buffer: TelemetryReport[] = [];

  constructor(
    private readonly sink: TelemetrySink,
    private readonly adapter: Adapter,
    private readonly now: () => number,
    /** Auto-flush once this many milestones are buffered, so a long session can't grow unbounded. */
    private readonly maxBuffer = 50,
  ) {}

  /** Record a funnel milestone (no-op for the high-frequency `view_tick` heartbeat). */
  report(type: EventType, ctx: ViewContext): void {
    if (!FORWARDED.has(type)) return;
    this.buffer.push({
      type,
      adapter: this.adapter,
      serveId: ctx.serveId || undefined,
      creativeId: ctx.creativeId || undefined,
      viewMs: Math.round(ctx.accruedMs),
      occurredAt: this.now(),
    });
    if (this.buffer.length >= this.maxBuffer) this.flush();
  }

  /** Drain the buffer to the sink. Safe to call when empty; swallows any sink rejection. */
  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      void Promise.resolve(this.sink.postTelemetry(batch)).catch(() => {});
    } catch {
      /* best-effort: a synchronous throw in the sink must never reach the loop */
    }
  }

  /** Buffered-but-unsent milestone count (for tests / diagnostics). */
  get pending(): number {
    return this.buffer.length;
  }
}
