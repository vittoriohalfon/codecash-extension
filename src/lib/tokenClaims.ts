import { AdServeTokenClaimsSchema, type AdServeTokenClaims } from "@codecash/shared";

/**
 * Read (NOT verify) the claims out of a server-signed ad-serve token. The client treats the token
 * as an opaque bearer it returns to the server — but it needs the `serveId` inside to build a
 * per-serve idempotency key and to label telemetry. Decoding the JWT payload is safe and local;
 * the server still verifies the signature on every billable event, so a tampered payload here only
 * hurts the client's own bookkeeping, never the ledger.
 */
export function readServeClaims(token: string): AdServeTokenClaims | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    const parsed = AdServeTokenClaimsSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
