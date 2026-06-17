/**
 * The claude-code (VS Code panel) surface.
 *
 * The claude-cli adapter renders the ad in the *terminal* via `~/.claude/settings.json`. The Claude
 * Code **extension panel** is a different surface: it draws its own "thinking" spinner and reads the
 * verb list from the VS Code setting **`claudeCode.spinnerVerbs`** — NOT from `~/.claude/settings.json`
 * (verified by reading the installed 2.1.177 bundle: the host does
 * `getConfiguration("claudeCode").get("spinnerVerbs")` and feeds it to the React spinner). So nothing
 * we write to `~/.claude/settings.json` ever reaches the panel; we have to mirror the ad into the VS
 * Code setting too.
 *
 * This bridge does exactly that, with the same capture-once / restore discipline as `lib/settings.ts`:
 * stash the user's original `claudeCode.spinnerVerbs` on enable, mirror the live ad text while serving,
 * and put their original back (or delete ours) on disable. It is intentionally **vscode-free** — it
 * talks to the setting through the injected {@link SpinnerConfigStore} + {@link CaptureStore}, so it is
 * unit-tested with fakes and the host wires the real VS Code-backed implementations.
 *
 * SCOPE / known limit: the panel only renders the spinner VERB. There is no status-line UI in the
 * panel, so the clickable `statusLine` hyperlink (the claude-cli click surface) does not exist here —
 * a panel session earns *impressions* (the ad shows as the thinking verb) but no in-place click. The
 * billable unit is already the impression, so this needs no money-loop change.
 *
 * "Never break the user's tools" still applies: writing a config value is reversible, and every store
 * call is awaited so a failed write surfaces to the host (which treats the panel surface as best-effort
 * and never lets it break the terminal surface).
 */

export interface SpinnerVerbsValue {
  mode: "append" | "replace";
  verbs: string[];
}

/** True for a well-formed `claudeCode.spinnerVerbs` value (defensive parse of an `unknown` from config). */
export function isSpinnerVerbsValue(v: unknown): v is SpinnerVerbsValue {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    (o.mode === "append" || o.mode === "replace") &&
    Array.isArray(o.verbs) &&
    o.verbs.every((x) => typeof x === "string")
  );
}

/**
 * The verb spec we inject for an ad. A single `replace` verb means the panel's spinner always shows
 * exactly the ad text (its picker chooses uniformly from the list, so a one-element list is constant)
 * rather than mixing it with Claude's defaults.
 */
export function adSpinnerVerbs(adText: string): SpinnerVerbsValue {
  return { mode: "replace", verbs: [adText] };
}

/**
 * Read/write the user-scope (global) `claudeCode.spinnerVerbs` setting. Global scope only, so we
 * never capture or clobber a workspace-scoped value the user set deliberately. `readGlobal` returns
 * `undefined` when unset; `writeGlobal(undefined)` clears our key entirely.
 */
export interface SpinnerConfigStore {
  readGlobal(): SpinnerVerbsValue | undefined;
  writeGlobal(value: SpinnerVerbsValue | undefined): Promise<void>;
}

/** The user's original value, captured once on enable. `null` = the user had nothing set. */
export interface CapturedSpinner {
  original: SpinnerVerbsValue | null;
}

/**
 * Persist the capture across window reloads. MUST be durable (the host backs this with
 * `context.globalState`): if it were memory-only, a reload would find OUR ad still in the setting and
 * "capture" it as the user's original, so disable could never restore their real value.
 */
export interface CaptureStore {
  read(): CapturedSpinner | undefined;
  write(v: CapturedSpinner | undefined): Promise<void>;
}

export class PanelSpinnerBridge {
  /** JSON of the verbs we last wrote, to skip redundant settings writes when the ad repeats. */
  private lastWritten: string | null = null;

  constructor(
    private readonly config: SpinnerConfigStore,
    private readonly capture: CaptureStore,
  ) {}

  /**
   * Begin mirroring: capture the user's original (exactly once — guarded by an existing capture so a
   * resume-after-reload doesn't re-capture our own ad), then show the seed/ad text. The capture also
   * defends against capturing our own value: if what's there is already a single-verb `replace` (the
   * shape we write) we still trust the capture-once gate, but to be safe across odd states we never
   * capture when a capture already exists.
   */
  async enable(adText: string): Promise<void> {
    if (this.capture.read() === undefined) {
      const original = this.config.readGlobal() ?? null;
      await this.capture.write({ original });
    }
    await this.write(adText);
  }

  /** Refresh the displayed ad (called per rotation by the host). Never re-captures. */
  async update(adText: string): Promise<void> {
    await this.write(adText);
  }

  /**
   * Restore the user's original value (or delete our key if they had none) and forget the capture, so
   * a later enable captures fresh. Safe to call when never enabled (no capture → clears nothing extra).
   */
  async disable(): Promise<void> {
    const cap = this.capture.read();
    // No capture means we never enabled (or already disabled): leave the setting untouched.
    if (cap !== undefined) {
      await this.config.writeGlobal(cap.original ?? undefined);
      await this.capture.write(undefined);
    }
    this.lastWritten = null;
  }

  /**
   * Take the ad OFF the panel spinner — restore the user's captured original (or remove our key) —
   * WITHOUT forgetting the capture, so a later {@link update} re-shows an ad without re-capturing. The
   * host calls this when sibling windows disagree on the ad: `claudeCode.spinnerVerbs` is one global VS
   * Code setting, so a single brand would contradict another window's terminal status line. Distinct
   * from {@link disable}, which is the teardown that also forgets the capture. No-op if never enabled.
   */
  async clear(): Promise<void> {
    const cap = this.capture.read();
    if (cap === undefined) return; // never enabled → nothing of ours to clear
    await this.config.writeGlobal(cap.original ?? undefined);
    this.lastWritten = null; // force the next update() to write the ad again
  }

  private async write(adText: string): Promise<void> {
    const value = adSpinnerVerbs(adText);
    const key = JSON.stringify(value.verbs);
    if (key === this.lastWritten) return; // same ad → skip a redundant settings.json write
    await this.config.writeGlobal(value);
    this.lastWritten = key;
  }
}
