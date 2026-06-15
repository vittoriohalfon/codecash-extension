/**
 * Device-token storage for the extension. The token is minted by the web app (Clerk-authed
 * `link-device` page → POST /api/devices/register) and pasted/handed back here; we hold it in
 * VS Code SecretStorage and keep a live in-memory copy so ApiClient's synchronous getToken() always
 * returns the freshest value (a refresh updates both). vscode-free: it depends only on a minimal
 * SecretStore interface, which `vscode.SecretStorage` satisfies and tests can fake.
 */

import { DEVICE_TOKEN_ROTATE_AHEAD_RATIO } from "@codecash/shared";

export interface SecretStore {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

const TOKEN_KEY = "codecash.deviceToken";
const DEVICE_ID_KEY = "codecash.deviceId";

/** Lightly validate a pasted device token looks like a JWT (header.payload.signature). */
export function looksLikeToken(value: string): boolean {
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value.trim());
}

/**
 * Decode (WITHOUT verifying) a device token's lifetime so the host can rotate it BEFORE it expires.
 * The client holds no secret to verify with and doesn't need one — the server is the authority; this
 * only decides *when* to refresh. Returns null on any malformed token.
 */
export function readTokenLifetime(token: string): { iat: number; exp: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      iat?: unknown;
      exp?: unknown;
    };
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;
    return { iat: payload.iat, exp: payload.exp };
  } catch {
    return null;
  }
}

/**
 * True once a device token is past `aheadRatio` of its lifetime — time to rotate. We rotate ahead of
 * the reactive 401 (which is too late: by then the token is dead and even refresh needs it within the
 * server's grace window) so an actively-used editor's token never lapses in the first place.
 *
 * Note this also returns true once the token is already past `exp` — a window that slept past the TTL
 * proactively heals on its next refetch (the server's refresh grace window accepts the just-expired
 * token), rather than waiting to 401 and recovering reactively. Returns false only for a malformed or
 * lifetime-less token.
 */
export function shouldRotateToken(
  token: string,
  nowMs: number,
  aheadRatio: number = DEVICE_TOKEN_ROTATE_AHEAD_RATIO,
): boolean {
  const life = readTokenLifetime(token);
  if (!life) return false;
  const iatMs = life.iat * 1000;
  const expMs = life.exp * 1000;
  if (expMs <= iatMs) return false;
  return nowMs >= iatMs + (expMs - iatMs) * aheadRatio;
}

export class AuthStore {
  private token: string | undefined;
  private deviceId: string | undefined;

  constructor(private readonly secrets: SecretStore) {}

  /** Hydrate the in-memory copy from SecretStorage. Call once on activation. */
  async load(): Promise<void> {
    this.token = (await this.secrets.get(TOKEN_KEY)) ?? undefined;
    this.deviceId = (await this.secrets.get(DEVICE_ID_KEY)) ?? undefined;
  }

  /** Synchronous accessor for ApiClient — bound so it can be passed by reference. */
  readonly getToken = (): string | undefined => this.token;

  hasToken(): boolean {
    return !!this.token;
  }

  getDeviceId(): string | undefined {
    return this.deviceId;
  }

  /** Store a freshly-issued token (and optional device id) from sign-in. */
  async setSession(token: string, deviceId?: string): Promise<void> {
    this.token = token.trim();
    await this.secrets.store(TOKEN_KEY, this.token);
    if (deviceId) {
      this.deviceId = deviceId;
      await this.secrets.store(DEVICE_ID_KEY, deviceId);
    }
  }

  /** Persist a rotated token from /api/devices/refresh (onTokenRefreshed hook). */
  async setToken(token: string): Promise<void> {
    this.token = token.trim();
    await this.secrets.store(TOKEN_KEY, this.token);
  }

  async clear(): Promise<void> {
    this.token = undefined;
    this.deviceId = undefined;
    await this.secrets.delete(TOKEN_KEY);
    await this.secrets.delete(DEVICE_ID_KEY);
  }
}
