import { describe, it, expect } from "vitest";
import { nextFetchDelayMs } from "../src/lib/rotation.js";
import {
  DEFAULT_ROTATION_SECONDS,
  MIN_ROTATION_SECONDS,
  NO_FILL_BACKOFF_MS,
  ROTATION_ERROR_RETRY_MS,
} from "@codecash/shared";

describe("nextFetchDelayMs", () => {
  it("follows the server's rotation cadence while serving", () => {
    expect(nextFetchDelayMs("serving", 20)).toBe(20_000);
    expect(nextFetchDelayMs("serving", 30)).toBe(30_000);
  });

  it("falls back to the default rotation when the server omits it", () => {
    expect(nextFetchDelayMs("serving", undefined)).toBe(DEFAULT_ROTATION_SECONDS * 1000);
  });

  it("clamps below the floor so an ad can't rotate before an impression can credit", () => {
    expect(nextFetchDelayMs("serving", 1)).toBe(MIN_ROTATION_SECONDS * 1000);
  });

  it("backs off when there's no inventory or serving stopped", () => {
    expect(nextFetchDelayMs("idle-empty", undefined)).toBe(NO_FILL_BACKOFF_MS);
    expect(nextFetchDelayMs("idle-killed", undefined)).toBe(NO_FILL_BACKOFF_MS);
    expect(nextFetchDelayMs("stopped", undefined)).toBe(NO_FILL_BACKOFF_MS);
  });

  it("retries sooner after a transient error or auth gap", () => {
    expect(nextFetchDelayMs("error", undefined)).toBe(ROTATION_ERROR_RETRY_MS);
    expect(nextFetchDelayMs("auth-required", undefined)).toBe(ROTATION_ERROR_RETRY_MS);
  });
});
