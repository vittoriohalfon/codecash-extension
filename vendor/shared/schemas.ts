import { z } from "zod";

/**
 * The credit lifecycle (CLAUDE.md): impression_rendered → impression_viewable →
 * view_tick → view_threshold_met → click. `error_impression` is a stuck-session safety net.
 * These are telemetry (PostHog); only `view_threshold_met` (impression) and `click` are billable.
 */
export const EVENT_TYPES = [
  "impression_rendered",
  "impression_viewable",
  "view_tick",
  "view_threshold_met",
  "click",
  "error_impression",
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

/** Which agent surface rendered the ad. Ascending difficulty; claude-cli ships first. */
export const AdapterSchema = z.enum(["claude-cli", "codex-cli", "claude-code", "codex"]);
export type Adapter = z.infer<typeof AdapterSchema>;

/**
 * Claims the SERVER signs into an ad-serve token. The client cannot mint these — it can only
 * return the token the server issued. Verified (sig + exp + nonce) on every impression/click.
 */
export const AdServeTokenClaimsSchema = z.object({
  serveId: z.string().uuid(),
  creativeId: z.string().uuid(),
  deviceId: z.string().uuid(),
  nonce: z.string().min(16),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type AdServeTokenClaims = z.infer<typeof AdServeTokenClaimsSchema>;

/** Body of POST /api/devices/register — the extension provisioning an install (Phase 4.0). */
export const DeviceRegisterSchema = z.object({
  adapter: AdapterSchema,
  platform: z.string().max(64).optional(),
  ccVersion: z.string().max(64).optional(),
});
export type DeviceRegister = z.infer<typeof DeviceRegisterSchema>;

/** The creative the client renders. Mirrors the local ad-cache shape (adText/clickUrl/iconUrl). */
export const AdCreativeSchema = z.object({
  creativeId: z.string().uuid(),
  adText: z.string().min(1).max(120),
  body: z.string().max(280).optional(),
  clickUrl: z.string().url(),
  /** base64-encoded icon, optional (CLAUDE.md). */
  iconUrl: z.string().optional(),
});
export type AdCreative = z.infer<typeof AdCreativeSchema>;

/** Response of GET /api/ads/next: a creative + the signed token to redeem it. */
export const AdServeResponseSchema = z.object({
  creative: AdCreativeSchema,
  token: z.string(), // signed JWT (claims = AdServeTokenClaims)
  viewThresholdSeconds: z.number().int().positive(),
  /**
   * How long to show this ad before fetching the next — the server-controlled rotation cadence.
   * Optional for back-compat (an older server omits it); the client falls back to DEFAULT_ROTATION_SECONDS.
   */
  rotationSeconds: z.number().int().positive().optional(),
});
export type AdServeResponse = z.infer<typeof AdServeResponseSchema>;

/** Local ad-cache file the render script reads. Render-only; never phones home (CLAUDE.md). */
export const AdCacheSchema = z.object({
  adText: z.string(),
  clickUrl: z.string().url(),
  iconUrl: z.string().optional(),
  creativeId: z.string().uuid(),
  token: z.string(),
  /** epoch ms the cache was written; used for ~10-min freshness. */
  ts: z.number().int(),
});
export type AdCache = z.infer<typeof AdCacheSchema>;

const idempotencyKey = z.string().min(8).max(128);

/** Billable: POST /api/events/impression — fired at view_threshold_met. */
export const ImpressionEventSchema = z.object({
  token: z.string(),
  idempotencyKey,
  /** cumulative visible ms when the threshold was crossed. */
  viewMs: z.number().int().nonnegative(),
  occurredAt: z.number().int(),
});
export type ImpressionEvent = z.infer<typeof ImpressionEventSchema>;

/** Billable: POST /api/events/click — valued CLICK_MULTIPLIER × an impression. */
export const ClickEventSchema = z.object({
  token: z.string(),
  /** the idempotency key of the impression this click belongs to. */
  impressionIdempotencyKey: idempotencyKey,
  idempotencyKey,
  occurredAt: z.number().int(),
});
export type ClickEvent = z.infer<typeof ClickEventSchema>;

/**
 * Dev earnings totals for the status-bar widget, in integer µUSD. Returned by GET /api/me/earnings
 * and piggybacked (fleetSignals-style) onto billable-event responses so the widget can update without
 * a dedicated poll. Derived from the ledger, never stored.
 */
export const EarningsSnapshotSchema = z.object({
  todayMicros: z.number().int().nonnegative(),
  lifetimeMicros: z.number().int().nonnegative(),
});
export type EarningsSnapshot = z.infer<typeof EarningsSnapshotSchema>;

/** Non-billable lifecycle telemetry → PostHog. The canonical, fully-attributed event shape. */
export const TelemetryEventSchema = z.object({
  type: EventTypeSchema,
  adapter: AdapterSchema,
  deviceId: z.string().uuid(),
  creativeId: z.string().uuid().optional(),
  serveId: z.string().uuid().optional(),
  viewMs: z.number().int().nonnegative().optional(),
  occurredAt: z.number().int(),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

/**
 * The wire shape the extension POSTs to /api/events/telemetry. It deliberately OMITS `deviceId`:
 * identity is not a client claim — the server fills it (and the dev's profileId) from the
 * device-auth bearer token, so a tampered client can't mis-attribute another device's funnel.
 * The client only supplies what it legitimately knows from the serve token (serveId/creativeId).
 */
export const TelemetryReportSchema = z.object({
  type: EventTypeSchema,
  adapter: AdapterSchema,
  creativeId: z.string().uuid().optional(),
  serveId: z.string().uuid().optional(),
  viewMs: z.number().int().nonnegative().optional(),
  occurredAt: z.number().int(),
});
export type TelemetryReport = z.infer<typeof TelemetryReportSchema>;

/** Batched telemetry body — the client buffers funnel milestones and flushes them together. */
export const TelemetryBatchSchema = z.object({
  events: z.array(TelemetryReportSchema).min(1).max(100),
});
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;

/**
 * Body of POST /api/advertiser/checkout — the public, email-only self-serve bid form. No login:
 * identity is the email + the Stripe-verified payment. The creative is persisted as a `draft`
 * BEFORE checkout (the ≤64KB base64 icon can't fit in Stripe metadata), then a superadmin approves
 * it to `active` before it serves. `bidUsd` is dollars PER BLOCK (a block = 1,000 × 5s impressions),
 * min $1; the bid sets auction priority. Icon is an optional `data:image/...;base64,…` URI ≤64KB.
 */
const ICON_MAX_CHARS = 90_000; // ~64KB binary → ~88KB base64 + the data-URI prefix.
export const AdvertiserBidSchema = z.object({
  email: z.string().email().max(254),
  headline: z.string().trim().min(3).max(60),
  clickUrl: z.string().url().startsWith("https://", "Destination URL must be https://").max(2048),
  brandName: z.string().trim().max(40).optional(),
  iconDataUrl: z
    .string()
    .max(ICON_MAX_CHARS, "Icon must be ≤64KB")
    .regex(/^data:image\/(png|jpeg|webp);base64,/, "Icon must be a PNG, JPEG, or WebP")
    .optional(),
  bidUsd: z.number().positive().min(1, "Minimum bid is $1.00 per block").max(10_000),
  blocks: z.number().int().min(1).max(1000),
  showOnLeaderboard: z.boolean().optional(),
});
export type AdvertiserBid = z.infer<typeof AdvertiserBidSchema>;
