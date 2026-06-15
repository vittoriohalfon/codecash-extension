/**
 * Idempotency keys derived from the serve id (NOT random), so a retried send reuses the same key and
 * the server's UNIQUE constraint makes a double-fire a no-op (CLAUDE.md: "double-fires are no-ops").
 * One serve → at most one impression + one click.
 *
 * SHARED so the server-side click-redirect (/c/[token]) derives the SAME keys the extension client
 * posts with: they must match to dedupe a click AND to find the parent impression by key. serveId is
 * a uuid (36 chars), so the prefixed keys stay inside the 8..128 idempotency-key schema bound.
 */
export const impressionKey = (serveId: string): string => `imp_${serveId}`;
export const clickKey = (serveId: string): string => `clk_${serveId}`;
