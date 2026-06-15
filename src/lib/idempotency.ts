/**
 * Serve-derived idempotency keys. The single source of truth now lives in `@codecash/shared` so the
 * server-side click-redirect (/c/[token]) derives byte-identical keys to what the client posts —
 * required to dedupe clicks and to find a click's parent impression. Re-exported here so existing
 * extension imports (`./idempotency.js`) keep their path.
 */
export { impressionKey, clickKey } from "@codecash/shared";
