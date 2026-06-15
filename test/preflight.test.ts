import { describe, it, expect } from "vitest";
import { detectClaudeCodeVersion, versionGte, isCompatible } from "../src/lib/preflight.js";

describe("preflight version gating", () => {
  it("parses a version from `claude --version` output", () => {
    expect(detectClaudeCodeVersion(() => "2.1.177 (Claude Code)\n")).toBe("2.1.177");
  });

  it("returns null when the CLI is absent", () => {
    expect(detectClaudeCodeVersion(() => null)).toBeNull();
  });

  it("compares dotted versions correctly", () => {
    expect(versionGte("2.1.177", "2.0.0")).toBe(true);
    expect(versionGte("1.9.9", "2.0.0")).toBe(false);
    expect(versionGte("2.0.0", "2.0.0")).toBe(true);
  });

  it("treats the live machine version as compatible and a null version as not", () => {
    expect(isCompatible("2.1.177")).toBe(true);
    expect(isCompatible(null)).toBe(false);
  });

  // The floor is the verified version where `spinnerVerbs` was introduced (CC 2.1.23,
  // anthropics/claude-code CHANGELOG.md). Earlier builds silently ignore the setting, so the
  // gate must reject them. Tripwire: don't lower the floor below where the feature exists.
  it("gates exactly at the spinnerVerbs introduction version (2.1.23)", () => {
    expect(isCompatible("2.1.23")).toBe(true);
    expect(isCompatible("2.1.22")).toBe(false);
    expect(isCompatible("2.0.0")).toBe(false);
  });
});
