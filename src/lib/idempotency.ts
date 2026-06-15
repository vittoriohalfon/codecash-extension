/**
 * Idempotency keys are derived from the serve id, NOT random — so a retried send (network blip,
 * reload) reuses the same key and the server's UNIQUE constraint makes it a no-op instead of a
 * double charge (CLAUDE.md: "double-fires are no-ops"). One serve → at most one impression + one
 * click. serveId is a uuid (36 chars), so the prefixed keys land inside the 8..128 schema bound.
 */
export const impressionKey = (serveId: string): string => `imp_${serveId}`;
export const clickKey = (serveId: string): string => `clk_${serveId}`;
