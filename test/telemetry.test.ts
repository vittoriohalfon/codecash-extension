import { describe, it, expect, vi } from "vitest";
import type { TelemetryReport } from "@codecash/shared";
import { TelemetryReporter } from "../src/lib/telemetry.js";
import type { ViewContext } from "../src/lib/viewTracker.js";

const CTX: ViewContext = {
  serveId: "11111111-1111-1111-1111-111111111111",
  creativeId: "22222222-2222-2222-2222-222222222222",
  accruedMs: 5000,
};

function harness(maxBuffer = 50) {
  const postTelemetry = vi.fn(async (_events: TelemetryReport[]) => {});
  let now = 1000;
  const reporter = new TelemetryReporter({ postTelemetry }, "claude-cli", () => now, maxBuffer);
  return { reporter, postTelemetry, advance: (ms: number) => (now = ms) };
}

describe("TelemetryReporter", () => {
  it("buffers funnel milestones and flushes them as one batch", () => {
    const { reporter, postTelemetry } = harness();
    reporter.report("impression_rendered", { ...CTX, accruedMs: 0 });
    reporter.report("impression_viewable", { ...CTX, accruedMs: 0 });
    reporter.report("view_threshold_met", CTX);
    expect(reporter.pending).toBe(3);

    reporter.flush();
    expect(postTelemetry).toHaveBeenCalledTimes(1);
    const batch = postTelemetry.mock.calls[0]![0];
    expect(batch.map((e) => e.type)).toEqual([
      "impression_rendered",
      "impression_viewable",
      "view_threshold_met",
    ]);
    expect(batch[0]).toMatchObject({
      adapter: "claude-cli",
      serveId: CTX.serveId,
      creativeId: CTX.creativeId,
      occurredAt: 1000,
    });
    expect(batch[2]?.viewMs).toBe(5000);
    expect(reporter.pending).toBe(0);
  });

  it("drops the high-frequency view_tick heartbeat (PostHog cost/noise)", () => {
    const { reporter, postTelemetry } = harness();
    reporter.report("view_tick", CTX);
    reporter.report("view_tick", CTX);
    expect(reporter.pending).toBe(0);
    reporter.flush();
    expect(postTelemetry).not.toHaveBeenCalled();
  });

  it("auto-flushes when the buffer reaches maxBuffer", () => {
    const { reporter, postTelemetry } = harness(2);
    reporter.report("impression_rendered", CTX);
    expect(postTelemetry).not.toHaveBeenCalled();
    reporter.report("impression_viewable", CTX); // hits maxBuffer=2 → auto-flush
    expect(postTelemetry).toHaveBeenCalledTimes(1);
    expect(reporter.pending).toBe(0);
  });

  it("flush on an empty buffer is a no-op", () => {
    const { reporter, postTelemetry } = harness();
    reporter.flush();
    expect(postTelemetry).not.toHaveBeenCalled();
  });

  it("never throws when the sink rejects, and still clears the buffer", () => {
    const postTelemetry = vi.fn(async () => {
      throw new Error("network down");
    });
    const reporter = new TelemetryReporter({ postTelemetry }, "claude-cli", () => 1);
    reporter.report("view_threshold_met", CTX);
    expect(() => reporter.flush()).not.toThrow();
    expect(reporter.pending).toBe(0); // drained even though the send failed
  });
});
