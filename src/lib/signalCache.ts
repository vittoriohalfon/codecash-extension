import type { EarningsSnapshot } from "@codecash/shared";

/**
 * fleetSignals-style freshness cache (R2): holds the latest earnings snapshot the server piggybacked
 * onto a billable-event response, so the status-bar widget updates WITHOUT a dedicated
 * /api/me/earnings poll, and the cold-start poll can be skipped while a snapshot is still fresh.
 *
 * Pure + clock-injectable (no timers, no `vscode`) so it's unit-testable and mirrors the codebase's
 * "logic in tested modules, glue in the host" split. The snapshot the server returns is authoritative
 * (a ledger SUM read post-commit), so applying it on any outcome — credited, capped, or deduped —
 * is always correct, never stale.
 */
export class SignalCache {
  private earnings: EarningsSnapshot | undefined;
  private earningsAt = 0;

  /** Record a fresh snapshot (from an event response or a cold-start poll) stamped at `now` (ms). */
  noteEarnings(snapshot: EarningsSnapshot, now: number): void {
    this.earnings = snapshot;
    this.earningsAt = now;
  }

  getEarnings(): EarningsSnapshot | undefined {
    return this.earnings;
  }

  /** True if a snapshot exists and is younger than `ms` — used to suppress the cold-start poll. */
  earningsFreshWithin(ms: number, now: number): boolean {
    return this.earnings !== undefined && now - this.earningsAt < ms;
  }

  /** Drop the snapshot (e.g. on sign-out — never show one identity's earnings to the next). */
  clear(): void {
    this.earnings = undefined;
    this.earningsAt = 0;
  }
}
