import {
  DEFAULT_ROTATION_SECONDS,
  MIN_ROTATION_SECONDS,
  NO_FILL_BACKOFF_MS,
  ROTATION_ERROR_RETRY_MS,
} from "@codecash/shared";
import type { ServeState } from "./serveController.js";

/**
 * How long the host waits before fetching the next ad — the dynamic replacement for the old fixed
 * 10-minute interval. The policy:
 *   - serving       → follow the server's rotationSeconds (clamped to MIN_ROTATION_SECONDS) so ads
 *                     rotate continuously and a focused dev earns one verified impression per serve;
 *   - no inventory  → back off to NO_FILL_BACKOFF_MS so a dry market isn't polled every few seconds;
 *   - error / auth  → retry sooner (ROTATION_ERROR_RETRY_MS) to recover from a transient blip.
 *
 * Pure + vscode-free so the cadence policy is unit-testable; the host just schedules a timer with it.
 */
export function nextFetchDelayMs(state: ServeState, rotationSeconds: number | undefined): number {
  switch (state) {
    case "serving":
      return Math.max(rotationSeconds ?? DEFAULT_ROTATION_SECONDS, MIN_ROTATION_SECONDS) * 1000;
    case "error":
    case "auth-required":
      return ROTATION_ERROR_RETRY_MS;
    case "idle-empty":
    case "idle-killed":
    case "stopped":
    default:
      return NO_FILL_BACKOFF_MS;
  }
}
