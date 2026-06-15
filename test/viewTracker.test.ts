import { describe, it, expect, vi } from "vitest";
import { ViewTracker } from "../src/lib/viewTracker.js";
import type { EventType } from "@codecash/shared";

const SERVE = "s1";
const CREATIVE = "c1";

function make(thresholdSeconds = 5, stuckMs?: number) {
  const onThreshold = vi.fn();
  const telemetry: EventType[] = [];
  const t = new ViewTracker(
    { onThreshold, onTelemetry: (type) => telemetry.push(type) },
    thresholdSeconds,
    stuckMs,
  );
  return { t, onThreshold, telemetry };
}

describe("ViewTracker", () => {
  it("emits rendered → viewable and accrues visible time to the threshold", () => {
    const { t, onThreshold, telemetry } = make(5);
    t.start(SERVE, CREATIVE, 0);
    expect(telemetry).toEqual(["impression_rendered"]);
    t.setVisible(true, 0);
    expect(t.currentPhase).toBe("viewable");
    for (let ms = 1000; ms <= 4000; ms += 1000) t.tick(ms);
    expect(onThreshold).not.toHaveBeenCalled();
    expect(t.getAccruedMs()).toBe(4000);
    t.tick(5000); // crosses 5s
    expect(onThreshold).toHaveBeenCalledTimes(1);
    expect(t.currentPhase).toBe("credited");
    expect(telemetry).toContain("view_threshold_met");
  });

  it("fires the threshold exactly once even with extra ticks", () => {
    const { t, onThreshold } = make(5);
    t.start(SERVE, CREATIVE, 0);
    t.setVisible(true, 0);
    for (let ms = 1000; ms <= 12000; ms += 1000) t.tick(ms);
    expect(onThreshold).toHaveBeenCalledTimes(1);
  });

  it("does not accrue while the window is not visible", () => {
    const { t, onThreshold } = make(5);
    t.start(SERVE, CREATIVE, 0);
    t.setVisible(true, 0);
    t.tick(1000); // +1000 visible → 1000
    t.setVisible(false, 1500); // banks the 500ms slice → 1500
    t.tick(3000); // invisible → no accrual
    t.tick(9000); // invisible → no accrual
    expect(t.getAccruedMs()).toBe(1500);
    expect(onThreshold).not.toHaveBeenCalled();
  });

  it("clamps a huge gap (sleep/suspend) so view time can't be banked while away", () => {
    const { t } = make(60);
    t.start(SERVE, CREATIVE, 0);
    t.setVisible(true, 0);
    t.tick(10 * 60 * 1000); // 10 minutes later in one tick
    expect(t.getAccruedMs()).toBe(2000); // clamped to 2 × tick interval
  });

  it("never accrues before it becomes viewable", () => {
    const { t } = make(5);
    t.start(SERVE, CREATIVE, 0);
    t.tick(4000); // rendered but never made visible
    expect(t.getAccruedMs()).toBe(0);
    expect(t.currentPhase).toBe("rendered");
  });

  it("emits error_impression once when a serve stays uncredited past the stuck window", () => {
    const { t, telemetry } = make(5, 10_000); // stuck after 10s of wall-clock
    t.start(SERVE, CREATIVE, 0);
    t.setVisible(false, 0); // never focused → never credits
    t.tick(5000);
    expect(telemetry).not.toContain("error_impression");
    t.tick(10_000); // hits the stuck window
    expect(telemetry.filter((e) => e === "error_impression")).toHaveLength(1);
    expect(t.currentPhase).toBe("errored");
    t.tick(20_000); // stays one-shot
    expect(telemetry.filter((e) => e === "error_impression")).toHaveLength(1);
  });

  it("never emits error_impression for a serve that credited normally", () => {
    const { t, telemetry } = make(5, 10_000);
    t.start(SERVE, CREATIVE, 0);
    t.setVisible(true, 0);
    for (let ms = 1000; ms <= 6000; ms += 1000) t.tick(ms); // credits at 5s
    t.tick(60_000); // long past the stuck window, but already credited
    expect(t.currentPhase).toBe("credited");
    expect(telemetry).not.toContain("error_impression");
  });
});
