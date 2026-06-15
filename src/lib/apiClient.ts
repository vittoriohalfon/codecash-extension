import {
  AdServeResponseSchema,
  type AdServeResponse,
  type ImpressionEvent,
  type ClickEvent,
  type TelemetryReport,
  type EarningsSnapshot,
} from "@codecash/shared";

/**
 * The networked client for the money loop (Phase 3). Talks to the Phase-4 endpoints with the
 * device token as `Authorization: Bearer`. vscode-free (uses global `fetch` + an injectable impl)
 * so it can be unit-tested and driven by the E2E harness against a live server.
 *
 * It NEVER mints billable events: it returns the server-signed token, and the server verifies the
 * signature + idempotency + budget. The client is the untrusted edge of the loop by design.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? `${status} ${code}`);
    this.name = "ApiError";
  }
}

/** 401 — the device token is missing/expired; the caller should refresh or prompt re-sign-in. */
export class UnauthorizedError extends ApiError {
  constructor(detail?: string) {
    super(401, "unauthorized", detail);
    this.name = "UnauthorizedError";
  }
}

/** GET /api/ads/next either serves an ad or returns 204 with a reason (killswitch / no inventory). */
export type NextAd =
  | { kind: "ad"; serve: AdServeResponse }
  | { kind: "none"; reason: string };

export interface CreditResult {
  deduped: boolean;
  creditedMicros: number;
  /**
   * The dev's running earnings totals, piggybacked by the server (fleetSignals-style) so the widget
   * updates without a separate /api/me/earnings poll. Absent against an older server.
   */
  earnings?: EarningsSnapshot;
}

export interface ApiClientOptions {
  /**
   * Server base URL, or a getter resolved per-request so a change to the `codecash.apiBaseUrl`
   * setting takes effect without an editor reload. A plain string keeps existing callers working.
   */
  baseUrl: string | (() => string);
  /** Returns the current device token (read fresh each call so a refresh takes effect). */
  getToken: () => string | undefined;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

async function errorCode(res: Response): Promise<string> {
  try {
    const j = (await res.clone().json()) as { error?: unknown };
    if (typeof j?.error === "string") return j.error;
  } catch {
    /* non-JSON body */
  }
  return "http_error";
}

export class ApiClient {
  private readonly resolveBaseUrl: () => string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ApiClientOptions) {
    const b = opts.baseUrl;
    this.resolveBaseUrl = typeof b === "function" ? b : () => b;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Current server base URL with trailing slashes stripped (resolved fresh each call). */
  private base(): string {
    return this.resolveBaseUrl().replace(/\/+$/, "");
  }

  private authHeaders(): Record<string, string> {
    const t = this.opts.getToken();
    return t ? { authorization: `Bearer ${t}` } : {};
  }

  /** GET /api/health — unauthenticated reachability probe used to gate enable(). */
  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base()}/api/health`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** GET /api/ads/next — device-authed. 204 → idle (killed/no-inventory). */
  async fetchNextAd(): Promise<NextAd> {
    const res = await this.fetchImpl(`${this.base()}/api/ads/next`, {
      method: "GET",
      headers: { ...this.authHeaders() },
    });
    if (res.status === 204) {
      return { kind: "none", reason: res.headers.get("x-codecash-reason") ?? "no-content" };
    }
    if (res.status === 401) throw new UnauthorizedError(await errorCode(res));
    if (!res.ok) throw new ApiError(res.status, await errorCode(res));
    const parsed = AdServeResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new ApiError(502, "bad_ad_response", parsed.error.message);
    return { kind: "ad", serve: parsed.data };
  }

  /** POST /api/events/impression — billable; the signed token authorizes it. */
  postImpression(ev: ImpressionEvent): Promise<CreditResult> {
    return this.postEvent("/api/events/impression", ev);
  }

  /** POST /api/events/click — billable, valued 50× an impression. */
  postClick(ev: ClickEvent): Promise<CreditResult> {
    return this.postEvent("/api/events/click", ev);
  }

  private async postEvent(path: string, body: unknown): Promise<CreditResult> {
    const res = await this.fetchImpl(`${this.base()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new UnauthorizedError(await errorCode(res));
    if (!res.ok) throw new ApiError(res.status, await errorCode(res));
    const j = (await res.json()) as {
      deduped?: unknown;
      creditedMicros?: unknown;
      earnings?: { todayMicros?: unknown; lifetimeMicros?: unknown };
    };
    const result: CreditResult = {
      deduped: j.deduped === true,
      creditedMicros: Number(j.creditedMicros ?? 0),
    };
    if (j.earnings && typeof j.earnings === "object") {
      result.earnings = {
        todayMicros: Number(j.earnings.todayMicros ?? 0),
        lifetimeMicros: Number(j.earnings.lifetimeMicros ?? 0),
      };
    }
    return result;
  }

  /**
   * POST /api/events/telemetry — NON-billable funnel telemetry, batched. Fire-and-forget: it never
   * throws and never rejects, because losing a telemetry sample must never disturb the money loop
   * (no auth retry, no error surfaced). Skipped entirely when there's no token to attribute it.
   */
  async postTelemetry(events: TelemetryReport[]): Promise<void> {
    if (events.length === 0 || !this.opts.getToken()) return;
    try {
      await this.fetchImpl(`${this.base()}/api/events/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({ events }),
      });
    } catch {
      /* best-effort telemetry; swallow */
    }
  }

  /** GET /api/me/earnings — device-authed dev earnings (µUSD) for the status-bar widget (cold start). */
  async fetchEarnings(): Promise<EarningsSnapshot> {
    const res = await this.fetchImpl(`${this.base()}/api/me/earnings`, {
      method: "GET",
      headers: { ...this.authHeaders() },
    });
    if (res.status === 401) throw new UnauthorizedError(await errorCode(res));
    if (!res.ok) throw new ApiError(res.status, await errorCode(res));
    const j = (await res.json()) as { todayMicros?: unknown; lifetimeMicros?: unknown };
    return {
      todayMicros: Number(j.todayMicros ?? 0),
      lifetimeMicros: Number(j.lifetimeMicros ?? 0),
    };
  }

  /**
   * POST /api/devices/revoke — kill this device's token server-side on sign-out, so a leaked token
   * can't keep rotating within the refresh grace window after the user disconnects. Best-effort: the
   * server is idempotent and an already-dead token is fine to "revoke" again, so this only throws on
   * a transport failure (the caller swallows it and clears local storage regardless).
   */
  async revokeToken(): Promise<void> {
    await this.fetchImpl(`${this.base()}/api/devices/revoke`, {
      method: "POST",
      headers: { ...this.authHeaders() },
    });
  }

  /** POST /api/devices/refresh — rotate the device token. Throws if the token is fully expired. */
  async refreshToken(): Promise<string> {
    const res = await this.fetchImpl(`${this.base()}/api/devices/refresh`, {
      method: "POST",
      headers: { ...this.authHeaders() },
    });
    if (!res.ok) throw new ApiError(res.status, "refresh_failed");
    const j = (await res.json()) as { deviceToken?: unknown };
    if (typeof j.deviceToken !== "string") throw new ApiError(502, "bad_refresh_response");
    return j.deviceToken;
  }
}
