import { describe, it, expect, vi } from "vitest";
import { ApiClient, ApiError, UnauthorizedError } from "../src/lib/apiClient.js";

const SERVE = {
  creative: {
    creativeId: "22222222-2222-2222-2222-222222222222",
    adText: "righthand.ai — your AI chief of staff",
    clickUrl: "https://teams.righthand.ai/signup",
  },
  token: "header.payload.sig",
  viewThresholdSeconds: 5,
};

function client(fetchImpl: typeof fetch, token: string | undefined = "tok") {
  return new ApiClient({ baseUrl: "http://x/", getToken: () => token, fetchImpl });
}

describe("ApiClient.fetchNextAd", () => {
  it("returns the parsed ad on 200 and sends the bearer token", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(SERVE), { status: 200 })),
    );
    const res = await client(fetchImpl as unknown as typeof fetch).fetchNextAd();
    expect(res).toEqual({ kind: "ad", serve: SERVE });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("maps 204 to idle with the x-codecash-reason", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 204, headers: { "x-codecash-reason": "killed" } }),
    );
    const res = await client(fetchImpl as unknown as typeof fetch).fetchNextAd();
    expect(res).toEqual({ kind: "none", reason: "killed" });
  });

  it("throws UnauthorizedError on 401", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    await expect(client(fetchImpl as unknown as typeof fetch).fetchNextAd()).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("rejects a malformed ad body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    await expect(client(fetchImpl as unknown as typeof fetch).fetchNextAd()).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("omits the bearer header when there is no token", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204, headers: { "x-codecash-reason": "killed" } })),
    );
    const noToken = new ApiClient({
      baseUrl: "http://x/",
      getToken: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await noToken.fetchNextAd();
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers ?? {}).not.toHaveProperty("authorization");
  });
});

describe("ApiClient.postImpression / postClick", () => {
  it("returns the credit result on 200", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, deduped: false, creditedMicros: 1000 }), { status: 200 }),
    );
    const r = await client(fetchImpl as unknown as typeof fetch).postImpression({
      token: "t",
      idempotencyKey: "imp_abc12345",
      viewMs: 6000,
      occurredAt: 1,
    });
    expect(r).toEqual({ deduped: false, creditedMicros: 1000 });
  });

  it("surfaces a server error code (e.g. 409 replay)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "replay" }), { status: 409 }),
    );
    await expect(
      client(fetchImpl as unknown as typeof fetch).postImpression({
        token: "t",
        idempotencyKey: "imp_abc12345",
        viewMs: 6000,
        occurredAt: 1,
      }),
    ).rejects.toMatchObject({ status: 409, code: "replay" });
  });
});

describe("ApiClient.ping", () => {
  it("returns true when /api/health is ok and hits the health path", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const ok = await client(fetchImpl as unknown as typeof fetch).ping();
    expect(ok).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://x/api/health");
  });

  it("returns false on a non-ok status", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    expect(await client(fetchImpl as unknown as typeof fetch).ping()).toBe(false);
  });

  it("returns false (never throws) when the server is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await client(fetchImpl as unknown as typeof fetch).ping()).toBe(false);
  });
});

describe("ApiClient dynamic baseUrl", () => {
  it("resolves a function baseUrl fresh on each request", async () => {
    let base = "http://a/";
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const c = new ApiClient({
      baseUrl: () => base,
      getToken: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await c.ping();
    base = "http://b/";
    await c.ping();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://a/api/health");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://b/api/health");
  });
});

describe("ApiClient.postTelemetry", () => {
  const ev = {
    type: "view_threshold_met" as const,
    adapter: "claude-cli" as const,
    occurredAt: 1,
  };

  it("posts the batch to /api/events/telemetry with the bearer token", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await client(fetchImpl as unknown as typeof fetch).postTelemetry([ev]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://x/api/events/telemetry");
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(JSON.parse(String(init?.body))).toEqual({ events: [ev] });
  });

  it("sends nothing for an empty batch or when there is no token", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await client(fetchImpl as unknown as typeof fetch).postTelemetry([]); // empty batch
    const noToken = new ApiClient({
      baseUrl: "http://x/",
      getToken: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await noToken.postTelemetry([ev]); // no token to attribute
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws when the network fails (best-effort telemetry)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      client(fetchImpl as unknown as typeof fetch).postTelemetry([ev]),
    ).resolves.toBeUndefined();
  });
});

describe("ApiClient.refreshToken", () => {
  it("returns the rotated token", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ deviceToken: "fresh" }), { status: 200 }),
    );
    expect(await client(fetchImpl as unknown as typeof fetch).refreshToken()).toBe("fresh");
  });

  it("throws on a failed refresh", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(client(fetchImpl as unknown as typeof fetch).refreshToken()).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe("ApiClient.revokeToken", () => {
  it("POSTs to /api/devices/revoke with the bearer token", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ revoked: true }), { status: 200 }),
    );
    await client(fetchImpl as unknown as typeof fetch).revokeToken();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://x/api/devices/revoke");
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer tok" });
  });
});
