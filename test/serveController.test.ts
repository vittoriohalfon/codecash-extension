import { describe, it, expect, vi } from "vitest";
import { ServeController, type AdSink } from "../src/lib/serveController.js";
import { ApiClient, UnauthorizedError } from "../src/lib/apiClient.js";
import type { AdServeResponse } from "@codecash/shared";

const CLAIMS = {
  serveId: "11111111-1111-1111-1111-111111111111",
  creativeId: "22222222-2222-2222-2222-222222222222",
  deviceId: "33333333-3333-3333-3333-333333333333",
  nonce: "0123456789abcdef0",
  iat: 1,
  exp: 9_999_999_999,
};
const TOKEN = `h.${Buffer.from(JSON.stringify(CLAIMS)).toString("base64url")}.s`;
const SERVE: AdServeResponse = {
  creative: { creativeId: CLAIMS.creativeId, adText: "an ad", clickUrl: "https://example.com" },
  token: TOKEN,
  viewThresholdSeconds: 5,
};

function harness(apiOverrides: Partial<Record<keyof ApiClient, unknown>> = {}) {
  const pushAd = vi.fn(async () => {});
  const sink: AdSink = { pushAd };
  const api = {
    fetchNextAd: vi.fn(async () => ({ kind: "ad", serve: SERVE })),
    postImpression: vi.fn(async () => ({ deduped: false, creditedMicros: 1000 })),
    postClick: vi.fn(async () => ({ deduped: false, creditedMicros: 50_000 })),
    refreshToken: vi.fn(async () => "fresh-token"),
    ...apiOverrides,
  } as unknown as ApiClient;
  let now = 0;
  const onEarned = vi.fn();
  const onTokenRefreshed = vi.fn(async () => {});
  const onTelemetry = vi.fn((_type: string, _ctx: unknown) => {});
  const controller = new ServeController({
    api,
    sink,
    now: () => now,
    isVisible: () => true,
    onEarned,
    onTokenRefreshed,
    onTelemetry,
  });
  return {
    controller,
    api,
    pushAd,
    onEarned,
    onTokenRefreshed,
    onTelemetry,
    advance: (ms: number) => (now = ms),
  };
}

describe("ServeController", () => {
  it("fetches, renders the ad, and enters 'serving'", async () => {
    const { controller, pushAd } = harness();
    const state = await controller.fetchAndRender();
    expect(state).toBe("serving");
    expect(pushAd).toHaveBeenCalledWith(SERVE);
  });

  it("credits an impression once view time crosses the threshold", async () => {
    const { controller, api, onEarned, advance } = harness();
    await controller.fetchAndRender();
    for (let ms = 1000; ms <= 5000; ms += 1000) {
      advance(ms);
      controller.tick();
    }
    await new Promise((r) => setTimeout(r, 0)); // flush the fire-and-forget credit chain
    expect(api.postImpression).toHaveBeenCalledTimes(1);
    expect(api.postImpression).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `imp_${CLAIMS.serveId}`, token: TOKEN }),
    );
    expect(onEarned).toHaveBeenCalledWith(1000);
  });

  it("is idempotent: a second credit attempt is a no-op", async () => {
    const { controller, api } = harness();
    await controller.fetchAndRender();
    const first = await controller.creditCurrentImpression();
    const second = await controller.creditCurrentImpression();
    expect(first).toMatchObject({ kind: "credited" });
    expect(second).toEqual({ kind: "skipped", reason: "already-sent" });
    expect(api.postImpression).toHaveBeenCalledTimes(1);
  });

  it("goes idle-killed on a 204 killswitch and renders nothing", async () => {
    const { controller, pushAd } = harness({
      fetchNextAd: vi.fn(async () => ({ kind: "none", reason: "killed" })),
    });
    expect(await controller.fetchAndRender()).toBe("idle-killed");
    expect(pushAd).not.toHaveBeenCalled();
  });

  it("goes idle-empty when there's no inventory", async () => {
    const { controller } = harness({
      fetchNextAd: vi.fn(async () => ({ kind: "none", reason: "no-inventory" })),
    });
    expect(await controller.fetchAndRender()).toBe("idle-empty");
  });

  it("refreshes the token once on a 401 and retries", async () => {
    const fetchNextAd = vi
      .fn()
      .mockRejectedValueOnce(new UnauthorizedError("expired"))
      .mockResolvedValue({ kind: "ad", serve: SERVE });
    const { controller, onTokenRefreshed, api } = harness({ fetchNextAd });
    expect(await controller.fetchAndRender()).toBe("serving");
    expect(api.refreshToken).toHaveBeenCalledTimes(1);
    expect(onTokenRefreshed).toHaveBeenCalledWith("fresh-token");
    expect(fetchNextAd).toHaveBeenCalledTimes(2);
  });

  it("surfaces auth-required when refresh also fails", async () => {
    const { controller } = harness({
      fetchNextAd: vi.fn(async () => {
        throw new UnauthorizedError("expired");
      }),
      refreshToken: vi.fn(async () => {
        throw new Error("token fully expired");
      }),
    });
    expect(await controller.fetchAndRender()).toBe("auth-required");
  });

  it("forwards the funnel via onTelemetry: rendered → viewable → tick → threshold", async () => {
    const { controller, onTelemetry, advance } = harness();
    await controller.fetchAndRender();
    // start() + setVisible(true) on a focused window fire the first two milestones immediately.
    expect(onTelemetry.mock.calls.map((c) => c[0])).toEqual([
      "impression_rendered",
      "impression_viewable",
    ]);

    for (let ms = 1000; ms <= 5000; ms += 1000) {
      advance(ms);
      controller.tick();
    }
    const types = onTelemetry.mock.calls.map((c) => c[0]);
    expect(types).toContain("view_tick");
    expect(types.filter((t) => t === "view_threshold_met")).toHaveLength(1); // fires exactly once
    // every telemetry call carries the serve context for funnel attribution
    expect(onTelemetry).toHaveBeenCalledWith(
      "view_threshold_met",
      expect.objectContaining({ serveId: CLAIMS.serveId, creativeId: CLAIMS.creativeId }),
    );
  });

  it("credits a click at 50× via the same serve", async () => {
    const { controller, api } = harness();
    await controller.fetchAndRender();
    const r = await controller.creditCurrentClick();
    expect(r).toMatchObject({ kind: "credited", creditedMicros: 50_000 });
    expect(api.postClick).toHaveBeenCalledWith(
      expect.objectContaining({
        impressionIdempotencyKey: `imp_${CLAIMS.serveId}`,
        idempotencyKey: `clk_${CLAIMS.serveId}`,
      }),
    );
  });
});
