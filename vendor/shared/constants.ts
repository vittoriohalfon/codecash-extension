/**
 * Marketplace constants. Many of these are *defaults* — the server `flags` row is the
 * source of truth at runtime (killswitch, min_view_ms, rev_share_pct, …). Keep the
 * defaults here in sync with the `flags` table seed.
 */

/**
 * Dev's revenue share, in percent — an even 50/50 split with the platform.
 *
 * This is the FALLBACK default. The runtime source of truth is the `flags.revSharePct` row
 * (authoritative since viral-mechanics Phase 2 §0), which the seed initializes to this value — keep
 * the two in sync.
 */
export const DEFAULT_REV_SHARE_PCT = 50;

/** A click is worth this many impressions. */
export const CLICK_MULTIPLIER = 50;

/**
 * Money unit. The ledger stores integer MICRO-DOLLARS
 * (µUSD, 1e-6 USD) because a 5s impression is sub-cent (~$0.001 = 1000 µUSD) and integer cents
 * would round every credit to 0. Convert to Stripe cents only at payout time.
 */
export const MICROS_PER_CENT = 10_000;
export const MICROS_PER_USD = 1_000_000;

/**
 * Minimum dev balance before a Stripe Connect payout is allowed (the "$10 threshold"). Payouts
 * ship after launch ("payouts soon"); until then this just gates the dashboard's cash-out CTA.
 */
export const PAYOUT_THRESHOLD_MICROS = 10 * MICROS_PER_USD; // $10.00

/**
 * Below this lifetime credit, share cards/prompts lead with non-$ stats (ads shown, rank) instead
 * of a tiny dollar figure — the "small-numbers" rule. This is the code fallback; the runtime value
 * is `flags.extra.shareThresholdMicros`, so it can be retuned without a deploy.
 */
export const SHARE_PROMPT_THRESHOLD_MICROS = 5 * MICROS_PER_USD; // $5.00

/**
 * Referral-loop tunables (viral mechanics Phase 2). These are FALLBACKS — the live values live in
 * `flags.extra` so they change without a migration or deploy.
 * The incentive is a two-sided rev-share boost funded from the platform's margin: while a referral
 * is active, BOTH the referrer and the invitee resolve a dev split of base + boost (clamped to the
 * cap), so the platform eats the difference and no extra ledger entry is created.
 */
/** Extra percentage POINTS added to the dev split while a referral boost is active (50% → 60%). */
export const DEFAULT_REFERRAL_BOOST_PCT = 10;
/** How long the boost lasts once the invitee activates, in days. */
export const DEFAULT_REFERRAL_BOOST_DAYS = 30;
/** The invitee must earn at least this much (credited µUSD) before the boost activates — never on
 *  signup, so a referral only pays once the new dev is genuinely earning (anti-farming). */
export const DEFAULT_REFERRAL_ACTIVATION_MICROS = 1 * MICROS_PER_USD; // $1.00
/** Max simultaneously-active boosting referrals one referrer can hold (anti-abuse cap). */
export const DEFAULT_REFERRAL_CAP_PER_REFERRER = 25;
/** Hard ceiling on the resolved dev split, in percent — the boost can never push past this. */
export const DEFAULT_DEV_SPLIT_CAP_PCT = 85;

/**
 * Anti-abuse earning caps surfaced on the dev dashboard's "Earning Limits" card AND enforced
 * server-side in the credit path — once a dev reaches a ceiling, further events record but credit
 * nothing. Defaults are a conservative $20/hr · $200/day.
 * Promote to the `flags` table when fraud work lands — until then these are the source of truth.
 */
export const HOURLY_EARN_CAP_CENTS = 2_000;
export const DAILY_EARN_CAP_CENTS = 20_000;

/**
 * Cumulative *visible* seconds before an ad counts as shown and credits. Held at
 * a genuine 5s so every impression is a real, advertiser-fair view (≥ the IAB video-viewability bar) —
 * VOLUME comes from PARALLELISM (up to MAX_CONCURRENT_INSTANCES concurrent sessions each earning), not
 * from a short dwell. The signed token, serve-age gate, idempotency, and presence/focus requirement
 * make each impression unforgeable; the per-device hourly cap is the hard governor. Runtime source of
 * truth is the `flags` row.
 */
export const DEFAULT_VIEW_THRESHOLD_SECONDS = 5;

/** How often the client emits a `view_tick` while the ad is visible, in ms. */
export const VIEW_TICK_INTERVAL_MS = 1000;

/**
 * Local ad-cache staleness bound for the RENDER path only: the status-line script stops showing a
 * cached ad once it's older than this, so a dead/disabled extension can't keep showing a stale ad
 * forever. This is NOT the serve cadence — how often the extension fetches a fresh ad is the
 * rotation interval below (DEFAULT_ROTATION_SECONDS), which is much shorter.
 */
export const AD_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Ad ROTATION cadence (seconds): how often the extension fetches a fresh ad, and therefore how often
 * an actively-viewing dev can earn one verified impression (a serve redeems into exactly one). Short
 * and server-tunable — overridable at runtime via the `flags` row and echoed in every serve response
 * — so ads change continuously while there's demand, with no client redeploy to retune. MUST stay
 * above the view threshold (an ad that rotates before {@link DEFAULT_VIEW_THRESHOLD_SECONDS} could
 * never clear the view + serve-age checks); {@link MIN_ROTATION_SECONDS} is the hard floor.
 */
export const DEFAULT_ROTATION_SECONDS = 8;
export const MIN_ROTATION_SECONDS = 6;

/** No funded inventory (204): poll this slowly instead of every rotation, so a dry market isn't hammered. */
export const NO_FILL_BACKOFF_MS = 60 * 1000;

/** After a transient fetch error / auth gap, retry on this cadence (sooner than the no-fill backoff). */
export const ROTATION_ERROR_RETRY_MS = 15 * 1000;

/**
 * Multi-instance crediting (parallel Claude Code sessions). A developer running N sessions side by
 * side genuinely hosts N on-screen ad surfaces, so each can earn — but only while a real human is
 * present and bounded so it can't be farmed. The model:
 *   - Per-WORKSPACE ads: each session serves + caches its OWN creative (keyed by project dir) so the
 *     N surfaces show N DISTINCT advertisers, not one ad repeated (which would be unfair billing).
 *   - Presence gate: an unfocused session only accrues while SOME codecash window was focused within
 *     PRESENCE_HEARTBEAT_TTL_MS (a real dev is at the machine), shared via a heartbeat file.
 *   - Concurrency cap: at most MAX_CONCURRENT_INSTANCES sessions accrue at once.
 *   - The per-device $20/hr · $200/day earn caps remain the hard governor on top of all this.
 * This is an opportunity-to-see model (like out-of-home): the advertiser pays for genuine on-screen
 * presence in an active dev session, not guaranteed sole focus.
 */
export const MAX_CONCURRENT_INSTANCES = 10;
/** A session counts as "developer present" if a codecash window was focused within this window. */
export const PRESENCE_HEARTBEAT_TTL_MS = 8 * 1000;
/** Drop an instance from the shared presence map once its heartbeat is older than this. */
export const PRESENCE_STALE_MS = 30 * 1000;
/** Subdirectory under CODECASH_DIR holding per-workspace ad caches (`ads/<workspaceKey>.json`). */
export const CODECASH_ADS_SUBDIR = "ads";

/**
 * Per-device ad diversity / frequency cap: the auction won't re-serve a creative shown to the SAME
 * device within this window, so concurrent sessions (and consecutive rotations) get DISTINCT
 * advertisers instead of the top bid on repeat — required for multi-instance fairness, and it fixes
 * one big bidder monopolizing a dev's screen. Falls back to the full pool when inventory is too thin
 * to fill distinctly (can't show more distinct ads than exist).
 */
export const DEVICE_FREQ_CAP_SECONDS = 20;

/**
 * Stuck-session watchdog. If ONE ad serve stays actively tracked (rendered/viewable, never credited)
 * for this long, the ViewTracker emits a one-shot `error_impression` and abandons it — the safety-net
 * leg of the credit lifecycle. Set GREATER than AD_CACHE_TTL_MS so a healthy refetch,
 * which mints a fresh tracker each cycle and resets the clock, never trips it; only a wedged loop
 * (refetch erroring, or its timer dead) keeps a single serve mounted long enough to fire. This turns
 * a silent dangling serve into a visible funnel signal instead of a mystery.
 */
export const STUCK_SESSION_MS = 15 * 60 * 1000;

/** Ad-serve token lifetime. Short — a token must be redeemed promptly or re-fetched. */
export const TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Device-auth token lifetime. The extension holds this in SecretStorage and rotates it AHEAD of
 * expiry. If it does lapse, /api/devices/refresh still
 * accepts it for DEVICE_TOKEN_REFRESH_GRACE_SECONDS so serving self-heals; only past that grace must
 * the extension re-register.
 */
export const DEVICE_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Grace window for ROTATING an already-expired device token, honored by /api/devices/refresh ONLY.
 * That endpoint verifies the signature + claims but tolerates an `exp` up to this far in the past, so
 * an editor that slept past DEVICE_TOKEN_TTL_SECONDS can self-heal on its next request instead of
 * dead-ending at a manual re-link. Billable paths (/api/ads/next, /api/events/*) NEVER honor this —
 * they reject the instant a token expires.
 *
 * DELIBERATELY PERPETUAL: a token rotated within the grace of each expiry refreshes forever, with no
 * forced re-link — that's the "leave it running all day" guarantee, and it's the intended design, not
 * an oversight. This bound only catches a token that's been *abandoned* for the whole window (laptop
 * off for a week), which then re-links through the web session. It also caps how long a *leaked*
 * already-expired token stays rotatable; shorten it if abuse shows up. Re-link is still required after
 * an explicit sign-out (the extension drops the token) or a DEVICE_TOKEN_SECRET rotation (signature
 * breaks), so "perpetual" is bounded by those, not unconditional.
 */
export const DEVICE_TOKEN_REFRESH_GRACE_SECONDS = 7 * 24 * 60 * 60;

/**
 * When the extension proactively rotates: once a device token is past this fraction of its lifetime,
 * it refreshes while the token is still valid, so rotation never depends on the (too-late) reactive
 * 401 path. 0.5 → rotate at the halfway mark.
 */
export const DEVICE_TOKEN_ROTATE_AHEAD_RATIO = 0.5;

/** A block = 1,000 × 5s impressions, ~$1 minimum. */
export const IMPRESSIONS_PER_BLOCK = 1000;

/** Local files the client writes, under the user's home dir — our own dir, not any third-party ad tool's. */
export const CODECASH_DIR = ".codecash";
export const AD_CACHE_FILE = "ad-cache.json";
export const SETTINGS_BACKUP_FILE = "claude-settings.backup.json";

/** Ledger account identifiers for double-entry bookkeeping. */
export const LEDGER_ACCOUNTS = {
  advertiser: "advertiser",
  dev: "dev",
  platform: "platform",
} as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[keyof typeof LEDGER_ACCOUNTS];
