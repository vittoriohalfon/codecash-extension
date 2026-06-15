import { describe, it, expect, beforeEach } from "vitest";
import {
  PanelSpinnerBridge,
  isSpinnerVerbsValue,
  adSpinnerVerbs,
  type SpinnerVerbsValue,
  type SpinnerConfigStore,
  type CaptureStore,
  type CapturedSpinner,
} from "../src/lib/panelBridge.js";

/** In-memory `claudeCode.spinnerVerbs` (global scope) that records every write. */
class FakeConfigStore implements SpinnerConfigStore {
  writes: Array<SpinnerVerbsValue | undefined> = [];
  constructor(private value: SpinnerVerbsValue | undefined = undefined) {}
  readGlobal(): SpinnerVerbsValue | undefined {
    return this.value;
  }
  async writeGlobal(value: SpinnerVerbsValue | undefined): Promise<void> {
    this.value = value;
    this.writes.push(value);
  }
}

/** Durable capture (mirrors context.globalState — survives a simulated window reload). */
class FakeCaptureStore implements CaptureStore {
  constructor(private value: CapturedSpinner | undefined = undefined) {}
  read(): CapturedSpinner | undefined {
    return this.value;
  }
  async write(v: CapturedSpinner | undefined): Promise<void> {
    this.value = v;
  }
}

let config: FakeConfigStore;
let capture: FakeCaptureStore;

describe("isSpinnerVerbsValue", () => {
  it("accepts well-formed specs and rejects junk", () => {
    expect(isSpinnerVerbsValue({ mode: "replace", verbs: ["ad"] })).toBe(true);
    expect(isSpinnerVerbsValue({ mode: "append", verbs: [] })).toBe(true);
    expect(isSpinnerVerbsValue({ mode: "nope", verbs: ["ad"] })).toBe(false);
    expect(isSpinnerVerbsValue({ mode: "replace", verbs: [1, 2] })).toBe(false);
    expect(isSpinnerVerbsValue({ verbs: ["ad"] })).toBe(false);
    expect(isSpinnerVerbsValue(null)).toBe(false);
    expect(isSpinnerVerbsValue("ad")).toBe(false);
  });
});

describe("PanelSpinnerBridge", () => {
  beforeEach(() => {
    config = new FakeConfigStore();
    capture = new FakeCaptureStore();
  });

  it("on a clean setting: captures null, shows the ad, and on disable deletes our key", async () => {
    const bridge = new PanelSpinnerBridge(config, capture);
    await bridge.enable("buy acme");

    expect(capture.read()).toEqual({ original: null });
    expect(config.readGlobal()).toEqual(adSpinnerVerbs("buy acme"));

    await bridge.disable();
    // restored to "nothing" → our key is cleared, and the capture is forgotten.
    expect(config.readGlobal()).toBeUndefined();
    expect(capture.read()).toBeUndefined();
  });

  it("captures the user's pre-existing spinnerVerbs and restores it exactly on disable", async () => {
    const original: SpinnerVerbsValue = { mode: "append", verbs: ["Ponering", "Vibing"] };
    config = new FakeConfigStore(original);
    const bridge = new PanelSpinnerBridge(config, capture);

    await bridge.enable("buy acme");
    expect(capture.read()).toEqual({ original });
    expect(config.readGlobal()).toEqual(adSpinnerVerbs("buy acme"));

    await bridge.disable();
    expect(config.readGlobal()).toEqual(original);
    expect(capture.read()).toBeUndefined();
  });

  it("update() swaps the verb to the new ad", async () => {
    const bridge = new PanelSpinnerBridge(config, capture);
    await bridge.enable("ad one");
    await bridge.update("ad two");
    expect(config.readGlobal()).toEqual(adSpinnerVerbs("ad two"));
  });

  it("skips redundant writes when the ad text is unchanged", async () => {
    const bridge = new PanelSpinnerBridge(config, capture);
    await bridge.enable("same ad"); // write #1
    await bridge.update("same ad"); // no-op
    await bridge.update("same ad"); // no-op
    await bridge.update("different"); // write #2
    expect(config.writes).toEqual([adSpinnerVerbs("same ad"), adSpinnerVerbs("different")]);
  });

  it("resume after reload does NOT re-capture our own ad as the user's original", async () => {
    const original: SpinnerVerbsValue = { mode: "replace", verbs: ["user's own"] };
    config = new FakeConfigStore(original);

    // First window: enable, then the window goes away. The setting now holds OUR ad; the capture
    // (durable) holds the user's real original.
    await new PanelSpinnerBridge(config, capture).enable("ad one");
    expect(config.readGlobal()).toEqual(adSpinnerVerbs("ad one"));
    expect(capture.read()).toEqual({ original });

    // New window after reload: same durable capture, setting still holds our ad. A fresh bridge must
    // NOT capture our ad — the capture-once gate sees an existing capture and leaves it alone.
    const resumed = new PanelSpinnerBridge(config, capture);
    await resumed.enable("ad two");
    expect(capture.read()).toEqual({ original }); // unchanged — still the user's real value

    // Disable restores the user's actual original, never our injected ad.
    await resumed.disable();
    expect(config.readGlobal()).toEqual(original);
  });

  it("disable() is a no-op when never enabled (leaves the user's setting untouched)", async () => {
    const original: SpinnerVerbsValue = { mode: "replace", verbs: ["theirs"] };
    config = new FakeConfigStore(original);
    const bridge = new PanelSpinnerBridge(config, capture);

    await bridge.disable();
    expect(config.writes).toEqual([]); // never wrote
    expect(config.readGlobal()).toEqual(original);
  });
});
