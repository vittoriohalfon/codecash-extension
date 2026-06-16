/**
 * The display string for an ad on the spinner verb + the VS Code panel: the company name before the
 * ad copy — `<brandName> · <adText>` (e.g. "Ramp · save time and money") — or the ad copy alone when
 * there's no brand. The standalone status-line render script (adapters/claude-cli/render.ts) is a
 * zero-dependency bundled file and can't import this, so it BYTE-MIRRORS the same format — KEEP THE
 * TWO IN SYNC.
 */
export const AD_BRAND_SEP = " · "; // space + U+00B7 MIDDLE DOT + space

export function formatAdLabel(brandName: string | null | undefined, adText: string): string {
  return brandName && brandName.length > 0 ? `${brandName}${AD_BRAND_SEP}${adText}` : adText;
}
