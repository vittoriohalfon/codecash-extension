import { describe, it, expect } from "vitest";
import { workspaceKey } from "../src/lib/workspaceKey.js";

// NOTE: render.ts carries a byte-identical copy of workspaceKey (it's bundled standalone). If this
// algorithm changes, update both — these tests guard the properties the render side relies on.
describe("workspaceKey", () => {
  it("is stable for the same path", () => {
    expect(workspaceKey("/Users/me/projA")).toBe(workspaceKey("/Users/me/projA"));
  });

  it("ignores trailing slashes (host fsPath vs CC project_dir may differ)", () => {
    expect(workspaceKey("/Users/me/projA/")).toBe(workspaceKey("/Users/me/projA"));
    expect(workspaceKey("/Users/me/projA//")).toBe(workspaceKey("/Users/me/projA"));
  });

  it("differs across workspaces so parallel sessions get distinct caches", () => {
    expect(workspaceKey("/Users/me/projA")).not.toBe(workspaceKey("/Users/me/projB"));
  });

  it("is an 8-char hex string (filename-safe)", () => {
    expect(workspaceKey("/Users/me/some/deep/project")).toMatch(/^[0-9a-f]{8}$/);
  });
});
