import { describe, it, expect } from "vitest";
import { osc8Link } from "../src/lib/osc8.js";

describe("osc8Link", () => {
  it("wraps text in an OSC 8 hyperlink to the url", () => {
    const link = osc8Link("https://example.com", "ad· hello");
    expect(link).toBe("\x1b]8;;https://example.com\x1b\\ad· hello\x1b]8;;\x1b\\");
  });

  it("ends by closing the hyperlink so following output isn't linkified", () => {
    expect(osc8Link("https://x.test", "y")).toMatch(/\x1b]8;;\x1b\\$/);
  });
});
