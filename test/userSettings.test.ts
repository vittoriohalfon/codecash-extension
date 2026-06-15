import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import {
  setTopLevelKey,
  resolveUserSettingsPath,
  writeUserSettingFile,
} from "../src/lib/userSettings.js";

const KEY = "claudeCode.spinnerVerbs";
const AD = { mode: "replace", verbs: ["buy acme"] };

describe("setTopLevelKey", () => {
  it("adds our key to an empty object", () => {
    const out = setTopLevelKey("{}", KEY, AD);
    expect(parse(out)[KEY]).toEqual(AD);
  });

  it("treats empty / whitespace text as {}", () => {
    expect(parse(setTopLevelKey("", KEY, AD))[KEY]).toEqual(AD);
    expect(parse(setTopLevelKey("   \n", KEY, AD))[KEY]).toEqual(AD);
  });

  it("preserves comments and other settings when adding our key", () => {
    const original = `{
  // my editor config
  "editor.fontSize": 14,
  "claudeCode.useTerminal": false /* keep the panel */
}`;
    const out = setTopLevelKey(original, KEY, AD);
    // our key landed…
    expect(parse(out)[KEY]).toEqual(AD);
    // …and the user's comments + values survived verbatim.
    expect(out).toContain("// my editor config");
    expect(out).toContain("/* keep the panel */");
    expect(parse(out)["editor.fontSize"]).toBe(14);
    expect(parse(out)["claudeCode.useTerminal"]).toBe(false);
  });

  it("updates an existing value in place", () => {
    const original = `{ "claudeCode.spinnerVerbs": { "mode": "replace", "verbs": ["old"] } }`;
    const out = setTopLevelKey(original, KEY, AD);
    expect(parse(out)[KEY]).toEqual(AD);
  });

  it("deletes our key when value is undefined, leaving the rest intact", () => {
    const original = `{
  // user comment
  "editor.fontSize": 14,
  "claudeCode.spinnerVerbs": { "mode": "replace", "verbs": ["ad"] }
}`;
    const out = setTopLevelKey(original, KEY, undefined);
    expect(KEY in parse(out)).toBe(false);
    expect(parse(out)["editor.fontSize"]).toBe(14);
    expect(out).toContain("// user comment");
  });
});

describe("resolveUserSettingsPath", () => {
  it("derives <userDir>/settings.json from a globalStorage path", () => {
    const gs = join("/home/me/.config/Code/User/globalStorage", "pub.codecash");
    expect(resolveUserSettingsPath(gs)).toBe("/home/me/.config/Code/User/settings.json");
  });

  it("is case-insensitive on the globalStorage segment", () => {
    const gs = join("/x/User/GlobalStorage", "pub.codecash");
    expect(resolveUserSettingsPath(gs)).toBe(join("/x/User", "settings.json"));
  });

  it("returns null when the layout isn't …/globalStorage/<ext>", () => {
    expect(resolveUserSettingsPath("/weird/remote/path/storage/ext")).toBeNull();
  });
});

describe("writeUserSettingFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codecash-settings-"));
  });

  it("creates settings.json when it doesn't exist, then updates and deletes the key", () => {
    const path = join(dir, "settings.json");
    expect(existsSync(path)).toBe(false);

    writeUserSettingFile(path, KEY, AD);
    expect(parse(readFileSync(path, "utf8"))[KEY]).toEqual(AD);

    writeUserSettingFile(path, KEY, { mode: "replace", verbs: ["next ad"] });
    expect(parse(readFileSync(path, "utf8"))[KEY]).toEqual({ mode: "replace", verbs: ["next ad"] });

    writeUserSettingFile(path, KEY, undefined);
    expect(KEY in parse(readFileSync(path, "utf8"))).toBe(false);
  });

  it("preserves a pre-existing commented settings.json on disk", () => {
    const path = join(dir, "settings.json");
    writeFileSync(path, `{\n  // do not touch\n  "files.autoSave": "onFocusChange"\n}\n`, "utf8");

    writeUserSettingFile(path, KEY, AD);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("// do not touch");
    expect(parse(text)["files.autoSave"]).toBe("onFocusChange");
    expect(parse(text)[KEY]).toEqual(AD);
  });
});
