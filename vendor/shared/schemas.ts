import { z } from "zod";
import { TargetingPredicateSchema, isTargetedPredicate } from "./targeting.js";
import { MIN_BID_USD, MIN_BID_USD_TARGETED } from "./constants.js";

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
  /**
   * The advertiser/company name shown BEFORE the ad copy in the status-line ad as
   * `<brandName> · <adText>` (e.g. "Ramp · save time and money"). Optional for back-compat: an older
   * server omits it and the client renders the ad copy alone.
   */
  brandName: z.string().max(40).optional(),
  /**
   * LEGACY (deprecated): the advertiser's bare destination domain, once shown as
   * `ad· <adText> ∿ <displayDomain>`. Superseded by `brandName` in the ad line. Still sent for
   * back-compat (an older render script falls back to it); new clients prefer `brandName`.
   */
  displayDomain: z.string().max(120).optional(),
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
  /** Company name shown before the ad copy as `<brandName> · <adText>` (see AdCreativeSchema). */
  brandName: z.string().max(40).optional(),
  /** LEGACY: advertiser's bare domain, once appended as `∿ <displayDomain>` (see AdCreativeSchema). */
  displayDomain: z.string().max(120).optional(),
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
 * Pre-auth / anonymous funnel signals (CLAUDE.md "Observability"). The device-authed telemetry above
 * can only see a user who already linked a device — blind to the install-but-never-signed-in cohort,
 * preflight failures, and client crashes. These signals (POST /api/events/client, no token) make that
 * cohort visible: install → connect_started → connected → enabled, with preflight_failed as the branch.
 */
export const CLIENT_SIGNAL_TYPES = [
  "install", // the extension activated for the first time on this machine
  "connect_started", // the user opened the web sign-in (connect / paste)
  "connected", // a device token was stored client-side (sign-in completed)
  "preflight_failed", // enable/resume aborted: Claude Code missing or too old
  "enabled", // serving started — the funnel terminal
] as const;
export const ClientSignalTypeSchema = z.enum(CLIENT_SIGNAL_TYPES);
export type ClientSignalType = z.infer<typeof ClientSignalTypeSchema>;

const ClientSignalSchema = z.object({
  kind: z.literal("signal"),
  type: ClientSignalTypeSchema,
  occurredAt: z.number().int(),
  /** Short context, e.g. the preflight failure reason. Never PII or code. */
  reason: z.string().max(200).optional(),
  ccVersion: z.string().max(64).optional(),
});

const ClientErrorSchema = z.object({
  kind: z.literal("error"),
  occurredAt: z.number().int(),
  message: z.string().min(1).max(1000),
  name: z.string().max(120).optional(),
  stack: z.string().max(8000).optional(),
  /** Logical location in the extension host, e.g. "enable" or "command:codecash.connect". */
  where: z.string().max(120).optional(),
});

export const ClientEventSchema = z.discriminatedUnion("kind", [ClientSignalSchema, ClientErrorSchema]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

/**
 * Body of POST /api/events/client — the ANONYMOUS pre-auth channel. `anonId` is a random, non-PII
 * per-install UUID the extension keeps in globalState; it keys the funnel without identifying a user.
 * Bounded + best-effort: the server forwards signals to PostHog and errors to Datadog, writes no DB
 * rows, and moves no money, so an unauthenticated caller can't reach the ledger through it.
 */
export const ClientEventBatchSchema = z.object({
  anonId: z.string().min(8).max(64),
  adapter: AdapterSchema.optional(),
  platform: z.string().max(64).optional(),
  extVersion: z.string().max(32).optional(),
  events: z.array(ClientEventSchema).min(1).max(50),
});
export type ClientEventBatch = z.infer<typeof ClientEventBatchSchema>;

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
  /**
   * The advertiser/company name shown before the ad copy (`<brandName> · <headline>`). One destination
   * URL is all we ask for now — the displayed domain is no longer collected (it was redundant friction);
   * the brand name is what developers see. Optional server-side for back-compat, required by the form.
   */
  brandName: z.string().trim().max(40).optional(),
  iconDataUrl: z
    .string()
    .max(ICON_MAX_CHARS, "Icon must be ≤64KB")
    .regex(/^data:image\/(png|jpeg|webp);base64,/, "Icon must be a PNG, JPEG, or WebP")
    .optional(),
  bidUsd: z.number().positive().min(MIN_BID_USD, `Minimum bid is $${MIN_BID_USD}.00 per block`).max(10_000),
  blocks: z.number().int().min(1).max(1000),
  showOnLeaderboard: z.boolean().optional(),
  /**
   * Optional stack-targeting predicate (docs/targeting-plan.md). `include` is a SOFT relevance boost,
   * `exclude` a HARD filter; an absent/empty predicate = untargeted (matches everyone at the baseline).
   * Validated against the closed taxonomy here; persisted to creatives.targeting on the draft creative.
   */
  targeting: TargetingPredicateSchema.optional(),
}).superRefine((bid, ctx) => {
  // Targeted campaigns carry a higher bid floor (MIN_BID_USD_TARGETED). Enforced here so the server
  // rejects an under-floor targeted bid even if a client skipped the check; the error is pathed to
  // `bidUsd` so the form can highlight the right field.
  if (isTargetedPredicate(bid.targeting) && bid.bidUsd < MIN_BID_USD_TARGETED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bidUsd"],
      message: `Targeted campaigns require a minimum bid of $${MIN_BID_USD_TARGETED}.00 per block`,
    });
  }
});
export type AdvertiserBid = z.infer<typeof AdvertiserBidSchema>;

/**
 * Body of the admin "add an ad manually" action (the superadmin panel, ADMIN_EMAILS-gated). Lets an
 * operator place an ad directly — typically their OWN affiliate links — WITHOUT the public Stripe bid
 * flow: the block is granted, not Stripe-funded. There's no `email`/`bidUsd` field because the bid is
 * fixed server-side to an implied $1.00/block, so devs are credited exactly as for a real $1 bid; the
 * advertiser side is settled off-platform. Field rules mirror AdvertiserBidSchema (brandName required
 * here — it's the per-brand advertiser name — and `blocks` allowed higher since there's no charge).
 */
export const AdminManualAdSchema = z.object({
  brandName: z.string().trim().min(1, "Brand name is required").max(40),
  headline: z.string().trim().min(3).max(60),
  clickUrl: z.string().url().startsWith("https://", "Destination URL must be https://").max(2048),
  iconDataUrl: z
    .string()
    .max(ICON_MAX_CHARS, "Icon must be ≤64KB")
    .regex(/^data:image\/(png|jpeg|webp);base64,/, "Icon must be a PNG, JPEG, or WebP")
    .optional(),
  blocks: z.number().int().min(1).max(100_000),
  /** Optional stack-targeting predicate (docs/targeting-plan.md), same shape as the public bid form. */
  targeting: TargetingPredicateSchema.optional(),
});
export type AdminManualAd = z.infer<typeof AdminManualAdSchema>;
