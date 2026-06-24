import {
  DEFAULT_REV_SHARE_PCT,
  CLICK_MULTIPLIER,
  IMPRESSIONS_PER_BLOCK,
  MICROS_PER_CENT,
} from "./constants.js";

/**
 * Single source of truth for marketplace economics. The landing page reads these for the
 * "get paid to vibe code" math AND the API bills against them — so the numbers a dev sees
 * advertised can never drift from what actually credits the ledger.
 *
 * All money is integer MICRO-DOLLARS (µUSD, 1e-6 USD) — decision D1. A 5s impression is sub-cent
 * (~$0.001 = 1000 µUSD), so integer cents would round every credit to 0. The dev/platform split
 * is computed so the two ALWAYS sum to the gross — platform takes the remainder — which keeps the
 * double-entry ledger balanced to the µUSD regardless of rounding.
 */

/** µUSD charged for a single 5s impression, for a block of `impressionsTotal` at `priceMicros`. */
export function microsPerImpression(
  priceMicros: number,
  impressionsTotal: number = IMPRESSIONS_PER_BLOCK,
): number {
  if (impressionsTotal <= 0) return 0;
  return priceMicros / impressionsTotal;
}

/** Dev's credit (µUSD) for a gross billable amount (rounded to the µUSD). */
export function devCreditMicros(grossMicros: number, revSharePct: number = DEFAULT_REV_SHARE_PCT): number {
  return Math.round((grossMicros * revSharePct) / 100);
}

/** Platform's credit = the remainder, so dev + platform === gross exactly. */
export function platformCreditMicros(
  grossMicros: number,
  revSharePct: number = DEFAULT_REV_SHARE_PCT,
): number {
  return grossMicros - devCreditMicros(grossMicros, revSharePct);
}

/** A click is worth CLICK_MULTIPLIER impressions. */
export function clickValueMicros(perImpressionMicros: number): number {
  return perImpressionMicros * CLICK_MULTIPLIER;
}

/** Effective CPM (µUSD per 1,000 impressions) — the auction sort key. */
export function effectiveCpmMicros(perImpressionMicros: number): number {
  return perImpressionMicros * 1000;
}

/**
 * Convert an advertiser's purchase (bid in integer CENTS per block × N blocks) into the block row's
 * integer fields. Cents in → all-integer math out, so there's no float drift between what Stripe
 * charges (`amountCents`) and what the ledger bills against (`priceMicros`). A block is
 * IMPRESSIONS_PER_BLOCK (1,000) × 5s impressions; `bidCpmMicros` (µUSD per 1,000 impressions) is the
 * auction sort key and equals the per-block bid since a block is exactly 1,000 impressions.
 */
export function blockPurchasePricing(bidCents: number, blocks: number) {
  const amountCents = bidCents * blocks;
  return {
    amountCents, // what Stripe charges
    impressionsTotal: blocks * IMPRESSIONS_PER_BLOCK,
    priceMicros: amountCents * MICROS_PER_CENT, // total µUSD the block is worth
    bidCpmMicros: bidCents * MICROS_PER_CENT, // µUSD per 1,000 impressions — auction key
  };
}

/**
 * Convert a dev's available µUSD balance into a whole-cent Stripe payout. Stripe transfers are
 * cents-native, so we floor µUSD → cents and only ever pay out (and reserve) the cent-aligned part;
 * the sub-cent remainder stays on the dev's pending balance for next time (decision D1). Returns
 * BOTH the cents to transfer and the EXACT µUSD that reserves (cents × MICROS_PER_CENT), so the
 * cash-out route, the admin transfer, and the dashboard all agree on what a payout actually removes
 * from the balance — `reservedMicros` is always ≤ the input and cent-aligned, never the raw input.
 * A negative/zero/non-finite input yields `{ cents: 0, reservedMicros: 0 }`.
 */
export function payoutCentsFromMicros(availableMicros: number): {
  cents: number;
  reservedMicros: number;
} {
  if (!Number.isFinite(availableMicros) || availableMicros <= 0) {
    return { cents: 0, reservedMicros: 0 };
  }
  const cents = Math.floor(availableMicros / MICROS_PER_CENT);
  return { cents, reservedMicros: cents * MICROS_PER_CENT };
}

/** Display economics for the landing page, derived from one block at `priceMicros`. */
export function landingEconomics(priceMicros: number, impressionsTotal: number = IMPRESSIONS_PER_BLOCK) {
  const perImpression = microsPerImpression(priceMicros, impressionsTotal);
  return {
    revSharePct: DEFAULT_REV_SHARE_PCT,
    clickMultiplier: CLICK_MULTIPLIER,
    impressionsPerBlock: impressionsTotal,
    devMicrosPerImpression: perImpression * (DEFAULT_REV_SHARE_PCT / 100),
    devMicrosPerClick: clickValueMicros(perImpression) * (DEFAULT_REV_SHARE_PCT / 100),
  };
}
