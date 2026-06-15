/**
 * Vendored subset of the codecash shared package, for the open client repo.
 *
 * ONLY the non-secret modules the extension actually needs: marketplace constants, the zod
 * event/wire schemas, and the pricing math. The server-side token *signing* code (the
 * Ed25519/HMAC `token.ts` + `deviceToken.ts`, and the `keygen` script) is DELIBERATELY NOT
 * vendored here — the client never mints or signs a token, it only returns the signed token the
 * server issued. Keep it that way: do not add `export * from "./token.js"` (or deviceToken) here.
 */
export * from "./constants.js";
export * from "./schemas.js";
export * from "./pricing.js";
