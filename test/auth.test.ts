import { describe, it, expect } from "vitest";
import {
  AuthStore,
  looksLikeToken,
  readTokenLifetime,
  shouldRotateToken,
  type SecretStore,
} from "../src/lib/auth.js";

/** Build a JWT-shaped token whose payload carries the given iat/exp (seconds). Signature is fake. */
function tokenWith(iatSec: number, expSec: number): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "HS256" })}.${seg({ iat: iatSec, exp: expSec })}.sig`;
}

/** In-memory SecretStore standing in for vscode.SecretStorage. */
function fakeSecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k),
    store: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  };
}

describe("looksLikeToken", () => {
  it("accepts a JWT-shaped string and rejects junk", () => {
    expect(looksLikeToken("aaa.bbb.ccc")).toBe(true);
    expect(looksLikeToken("  aaa.bbb.ccc  ")).toBe(true);
    expect(looksLikeToken("not a token")).toBe(false);
    expect(looksLikeToken("aaa.bbb")).toBe(false);
  });
});

describe("AuthStore", () => {
  it("persists a session and exposes the token synchronously after load", async () => {
    const secrets = fakeSecrets();
    const store = new AuthStore(secrets);
    await store.load();
    expect(store.hasToken()).toBe(false);

    await store.setSession("aaa.bbb.ccc", "dev-1");
    expect(store.getToken()).toBe("aaa.bbb.ccc");
    expect(store.getDeviceId()).toBe("dev-1");

    // A fresh store hydrating from the same secrets sees it.
    const reopened = new AuthStore(secrets);
    await reopened.load();
    expect(reopened.getToken()).toBe("aaa.bbb.ccc");
    expect(reopened.getDeviceId()).toBe("dev-1");
  });

  it("setToken rotates only the token (refresh path)", async () => {
    const secrets = fakeSecrets();
    const store = new AuthStore(secrets);
    await store.setSession("old.tok.en", "dev-1");
    await store.setToken("new.tok.en");
    expect(store.getToken()).toBe("new.tok.en");
    expect(store.getDeviceId()).toBe("dev-1");
  });

  it("clear wipes both keys", async () => {
    const secrets = fakeSecrets();
    const store = new AuthStore(secrets);
    await store.setSession("aaa.bbb.ccc", "dev-1");
    await store.clear();
    expect(store.hasToken()).toBe(false);
    expect(secrets.map.size).toBe(0);
  });

  it("trims a pasted token", async () => {
    const store = new AuthStore(fakeSecrets());
    await store.setSession("  aaa.bbb.ccc \n", "dev");
    expect(store.getToken()).toBe("aaa.bbb.ccc");
  });
});

describe("readTokenLifetime", () => {
  it("reads iat/exp out of a JWT payload", () => {
    expect(readTokenLifetime(tokenWith(1000, 4600))).toEqual({ iat: 1000, exp: 4600 });
  });

  it("returns null for malformed or claim-less tokens", () => {
    expect(readTokenLifetime("garbage")).toBeNull();
    expect(readTokenLifetime("aaa.bbb")).toBeNull();
    expect(readTokenLifetime("not.a.jwt")).toBeNull();
    const noClaims = `${Buffer.from("{}").toString("base64url")}.${Buffer.from("{}").toString("base64url")}.sig`;
    expect(readTokenLifetime(noClaims)).toBeNull();
  });
});

describe("shouldRotateToken", () => {
  const NOW_MS = 1_700_000_000_000;
  const nowSec = NOW_MS / 1000;

  it("is false early in the token's life", () => {
    // Fresh 1h token: issued now, expires in an hour → only 0% elapsed.
    expect(shouldRotateToken(tokenWith(nowSec, nowSec + 3600), NOW_MS)).toBe(false);
  });

  it("is true once past half its life", () => {
    // 1h token, 40 min elapsed (> 50%) → rotate.
    expect(shouldRotateToken(tokenWith(nowSec - 2400, nowSec + 1200), NOW_MS)).toBe(true);
  });

  it("honors a custom ahead-ratio", () => {
    // 20 min into a 1h token: past 0.25 but not 0.75.
    const tok = tokenWith(nowSec - 1200, nowSec + 2400);
    expect(shouldRotateToken(tok, NOW_MS, 0.25)).toBe(true);
    expect(shouldRotateToken(tok, NOW_MS, 0.75)).toBe(false);
  });

  it("is false for a malformed token", () => {
    expect(shouldRotateToken("garbage", NOW_MS)).toBe(false);
    expect(shouldRotateToken("not.a.jwt", NOW_MS)).toBe(false);
  });
});
