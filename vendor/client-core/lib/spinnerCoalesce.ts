/**
 * Decide what the ONE machine-global Claude Code spinner verb should show across all live sessions /
 * windows — shared by the standalone CLI daemon (which coalesces its in-process sessions) and the VS
 * Code extension (which coalesces sibling windows through the on-disk {@link ./spinnerRegistry}).
 *
 * `spinnerVerbs` is a single shared setting, but the billed surface — the status line — is per session
 * / per window. So we may brand the spinner ONLY when every live participant is showing the SAME ad:
 * the moment two show DIFFERENT advertisers, any one brand on the spinner would contradict the status
 * line under every terminal but one (the bug: a "Base44" spinner above a "justskim" status line). In
 * that case we return null → the caller clears the spinner. The spinner is a non-billable bonus
 * surface, so clearing it costs no revenue, only the contradiction. (Pure + side-effect-free so it can
 * be unit-tested without spawning a daemon / launching VS Code; the caller owns the actual write.)
 *
 * A null/undefined label (a participant that hasn't fetched an ad yet) is ignored — it has no status
 * line to contradict — so a just-started session doesn't force every sibling's spinner to clear.
 *
 * @returns the single agreed ad label to brand the spinner with, or null to clear it.
 */
export function resolveSpinnerLabel(labels: Iterable<string | null | undefined>): string | null {
  const distinct = new Set<string>();
  for (const l of labels) if (l) distinct.add(l);
  if (distinct.size !== 1) return null;
  for (const l of distinct) return l;
  return null;
}
