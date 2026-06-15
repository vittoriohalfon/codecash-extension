import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { VIEW_TICK_INTERVAL_MS, MICROS_PER_USD } from "@codecash/shared";
import { nextFetchDelayMs } from "../lib/rotation.js";
import { ClaudeCliAdapter } from "../adapters/claude-cli/index.js";
import { ApiClient } from "../lib/apiClient.js";
import { AuthStore, looksLikeToken, shouldRotateToken } from "../lib/auth.js";
import { ServeController, type ServeState } from "../lib/serveController.js";
import { TelemetryReporter } from "../lib/telemetry.js";
import { codecashPaths, type CodecashPaths } from "../lib/paths.js";
import {
  heartbeat,
  dropInstance,
  shouldAccrue,
  readPresenceFile,
  writePresenceFile,
} from "../lib/presence.js";

// Baked at build time via esbuild `define` (see esbuild.mjs). A published build can ship a prod
// server URL through the CODECASH_DEFAULT_API_BASE_URL env var without any code edit, while local
// dev falls back to the dev server. The `codecash.apiBaseUrl` setting still overrides this.
const DEFAULT_BASE_URL =
  (process.env.CODECASH_DEFAULT_API_BASE_URL || "").trim() || "http://localhost:3000";

/** globalState key for the one-time connect nonce, so a malicious page can't inject a token. */
const PENDING_STATE_KEY = "codecash.pendingConnectState";

/**
 * The extension host's money-loop service. Owns the VS Code glue — SecretStorage auth, the status-
 * bar widget, the two timers (view-tick + ad refetch), and window-focus visibility — and delegates
 * every decision to the tested, vscode-free modules (ApiClient, ServeController, ViewTracker).
 *
 * Loop cadence: one ad per refetch interval; while focused the view tracker accrues toward the
 * server's threshold and fires a single billable impression. Everything is reversible and never
 * throws into the CLI (settings backup/restore lives in the adapter).
 */
export class CodecashService {
  private readonly auth: AuthStore;
  private readonly api: ApiClient;
  private readonly adapter: ClaudeCliAdapter;
  private controller: ServeController | null = null;
  private reporter: TelemetryReporter | null = null;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private fetchTimer: ReturnType<typeof setTimeout> | undefined;
  private windowSub: vscode.Disposable | undefined;
  private todayMicros = 0;
  private running = false;
  private readonly out: vscode.OutputChannel;
  private readonly extensionId: string;
  private readonly memento: vscode.Memento;
  private readonly paths: CodecashPaths = codecashPaths();
  /** Unique per extension-host (per VS Code window) — identity in the shared presence map. */
  private readonly instanceId = randomUUID();
  /** Last computed accrual visibility (focus OR present-within-cap); seeds the view tracker. */
  private lastVisible = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly widget: vscode.StatusBarItem,
    renderScriptPath: string,
  ) {
    this.auth = new AuthStore(context.secrets);
    // This window's project folder keys the per-workspace ad cache → distinct ad per parallel session.
    const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    this.adapter = new ClaudeCliAdapter(renderScriptPath, this.paths, workspaceDir);
    this.out = vscode.window.createOutputChannel("codecash");
    // Resolve the base URL per-request so changing `codecash.apiBaseUrl` takes effect without reload.
    this.api = new ApiClient({ baseUrl: () => this.baseUrl(), getToken: this.auth.getToken });
    this.extensionId = context.extension.id;
    this.memento = context.globalState;
    context.subscriptions.push(this.out);
  }

  private baseUrl(): string {
    const v = vscode.workspace.getConfiguration("codecash").get<string>("apiBaseUrl");
    return (v && v.trim()) || DEFAULT_BASE_URL;
  }

  /** Hydrate auth + paint the widget, then resume serving if the user left it enabled. */
  async init(): Promise<void> {
    await this.auth.load();
    this.renderWidget();
    await this.resumeIfEnabled();
    await this.promptIfPaused();
  }

  /**
   * Catch the "connected but paused" limbo: a token is stored but the user never ran enable (or
   * disabled, then reloaded). Without a nudge here the status bar is a silent icon and the only way
   * to turn ads on is hunting the command palette. One non-blocking prompt; declining is fine and
   * it simply re-offers next activation. `resumeIfEnabled` already covered the enabled case.
   */
  private async promptIfPaused(): Promise<void> {
    const enabled = vscode.workspace.getConfiguration("codecash").get<boolean>("enabled") ?? false;
    if (this.running || enabled || !this.auth.hasToken()) return;
    const choice = await vscode.window.showInformationMessage(
      "codecash is connected but paused — turn it on to start earning while you wait.",
      "Enable & earn",
    );
    if (choice === "Enable & earn") await this.enable();
  }

  /**
   * Restart the serve loop on activation when the user previously enabled it. VS Code does not
   * persist the running loop across window reloads — only the `codecash.enabled` flag and the
   * SecretStorage token survive — so without this, ads silently stop after every reload until the
   * user runs Enable again. We re-assert the surface (idempotent) in case settings drifted.
   */
  private async resumeIfEnabled(): Promise<void> {
    const enabled = vscode.workspace.getConfiguration("codecash").get<boolean>("enabled") ?? false;
    if (!enabled || this.running || !this.auth.hasToken()) return;
    const pf = await this.adapter.preflight();
    if (!pf.ok) {
      this.out.appendLine(`resume skipped: ${pf.reason}`);
      return;
    }
    await this.adapter.enable("codecash — get paid for waiting");
    await this.startServing();
    this.out.appendLine(`resumed serving on Claude Code ${pf.ccVersion}`);
  }

  /**
   * Editor-initiated connect (the primary path). Opens the web sign-in page with a callback URI
   * that routes the freshly minted device token straight back to THIS editor — no copy-paste — plus
   * a one-time `state` nonce so an unrelated page can't inject a token. `uriScheme` + asExternalUri
   * make the round-trip work across VS Code / Insiders / Cursor / Windsurf and Remote/Codespaces.
   * Falls back to manual paste if the callback can't be built or doesn't round-trip.
   */
  async connect(): Promise<void> {
    if (this.auth.hasToken()) {
      // Already connected: clicking "Connect & start earning" again should just turn ads on.
      if (this.running) {
        void vscode.window.showInformationMessage(
          "codecash is already on — you're earning while you wait.",
        );
      } else {
        await this.enable();
      }
      return;
    }
    let url = `${this.baseUrl()}/app/link-device`;
    try {
      const state = randomUUID();
      await this.memento.update(PENDING_STATE_KEY, state);
      const callback = await vscode.env.asExternalUri(
        vscode.Uri.parse(`${vscode.env.uriScheme}://${this.extensionId}/auth`),
      );
      const qs = new URLSearchParams({ redirect: callback.toString(true), state });
      url = `${url}?${qs.toString()}`;
    } catch (e) {
      this.out.appendLine(`connect: callback unavailable, using paste fallback — ${stringifyErr(e)}`);
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
    const choice = await vscode.window.showInformationMessage(
      "codecash: finishing sign-in in your browser — this editor will connect automatically.",
      "Paste token instead",
    );
    if (choice === "Paste token instead" && !this.auth.hasToken()) await this.promptPasteToken(true);
  }

  /**
   * Manual paste path: open the web sign-in page and capture the pasted device token. The fallback
   * to {@link connect}; also used by enable() when no token is stored yet. Returns true if connected.
   */
  async signIn(autoEnable = false): Promise<boolean> {
    await vscode.env.openExternal(vscode.Uri.parse(`${this.baseUrl()}/app/link-device`));
    return this.promptPasteToken(autoEnable);
  }

  /**
   * Open the web dashboard, where the share card lets the dev copy a link to their public /u/[handle]
   * earnings page (viral mechanics Phase 1). The extension intentionally doesn't know the handle —
   * the dashboard owns sharing; this is just the doorway.
   */
  async share(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(`${this.baseUrl()}/app/dashboard`));
  }

  /**
   * Open the dashboard, where the referral card lets the dev copy their /r/<code> invite link
   * (viral mechanics Phase 2). Like share(), the extension doesn't know the code — the dashboard
   * owns the referral loop; this is just the doorway.
   */
  async invite(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(`${this.baseUrl()}/app/dashboard`));
  }

  /** Prompt for a pasted token (no browser reopen). Returns true if a token was stored. */
  private async promptPasteToken(autoEnable: boolean): Promise<boolean> {
    const pasted = await vscode.window.showInputBox({
      title: "Connect codecash",
      prompt: "Paste the device token from the codecash web page (it opened in your browser).",
      ignoreFocusOut: true,
      password: true,
      validateInput: (v) => (looksLikeToken(v) ? null : "That doesn't look like a device token."),
    });
    if (!pasted) return false;
    await this.finishConnect(pasted.trim(), autoEnable);
    return true;
  }

  /**
   * Sign-in via the editor callback deep link from the web page. Rejects any token that doesn't
   * carry the matching one-time `state` we issued in {@link connect} — without this, any page could
   * deep-link `…/auth?token=` and silently bind this editor to someone else's account.
   */
  async signInWithToken(token: string, state?: string | null): Promise<void> {
    const expected = this.memento.get<string>(PENDING_STATE_KEY);
    if (!expected || state !== expected) {
      void vscode.window.showWarningMessage("codecash: ignored an unsolicited sign-in link.");
      return;
    }
    await this.memento.update(PENDING_STATE_KEY, undefined);
    if (!looksLikeToken(token)) return;
    await this.finishConnect(token.trim(), true);
  }

  /**
   * Store the token, paint the widget, then either refetch (already serving) or — for the one-click
   * onboarding path — turn ads on automatically. Connecting IS the consent to enable: the button
   * the user clicked says "start earning", and enable() preflights, backs up settings, and is fully
   * reversible via Disable. We only fall back to a manual nudge when auto-enable wasn't requested
   * (i.e. the low-level signIn() called from inside enable(), which must not recurse).
   */
  private async finishConnect(token: string, autoEnable: boolean): Promise<void> {
    await this.auth.setSession(token);
    this.renderWidget();
    if (this.running) {
      await this.refetch();
      void vscode.window.showInformationMessage("codecash: reconnected.");
    } else if (autoEnable) {
      await this.enable(); // shows its own success toast
    } else {
      void vscode.window.showInformationMessage(
        "codecash: connected. Run “codecash: Enable ad injection” to start earning.",
      );
    }
  }

  async enable(): Promise<void> {
    const pf = await this.adapter.preflight();
    if (!pf.ok) {
      void vscode.window.showWarningMessage(`codecash: ${pf.reason}`);
      return;
    }
    if (!this.auth.hasToken()) {
      const ok = await this.signIn();
      if (!ok) {
        void vscode.window.showWarningMessage("codecash: sign in to start earning.");
        return;
      }
    }

    // Reachability gate: turn a silent "no ads ever appear" failure (wrong/unreachable server URL)
    // into a clear, actionable message. Once serving, transient outages are handled by the loop.
    if (!(await this.api.ping())) {
      const choice = await vscode.window.showWarningMessage(
        `codecash: can't reach the server at ${this.baseUrl()}. Check the codecash.apiBaseUrl setting, then try again.`,
        "Open settings",
      );
      if (choice === "Open settings") {
        void vscode.commands.executeCommand("workbench.action.openSettings", "codecash.apiBaseUrl");
      }
      return;
    }

    // Patch the surface up front so the spinner/status line are live even before the first ad.
    await this.adapter.enable("codecash — get paid for waiting");

    await vscode.workspace
      .getConfiguration("codecash")
      .update("enabled", true, vscode.ConfigurationTarget.Global);

    await this.startServing();
    void vscode.window.showInformationMessage(
      `codecash enabled on Claude Code ${pf.ccVersion}. Your settings were backed up.`,
    );
  }

  /**
   * Build the controller, wire focus + timers, and prime the first ad. Shared by enable() and the
   * activation resume path. Idempotent — a second call while already running is a no-op.
   */
  private async startServing(): Promise<void> {
    if (this.running) return;
    // The client end of the funnel: ViewTracker's milestones (via onTelemetry) are batched here and
    // flushed to the server, which forwards them to PostHog. Previously these were dropped on the
    // floor, leaving us blind to fill rate / funnel / shown-but-not-credited.
    this.reporter = new TelemetryReporter(
      { postTelemetry: (evs) => this.api.postTelemetry(evs) },
      "claude-cli",
      () => Date.now(),
    );
    this.controller = new ServeController({
      api: this.api,
      sink: this.adapter,
      now: () => Date.now(),
      isVisible: () => this.lastVisible,
      onTelemetry: (type, ctx) => this.reporter?.report(type, ctx),
      onEarned: () => void this.refreshEarnings(),
      onState: (s) => this.onState(s),
      onTokenRefreshed: (t) => this.auth.setToken(t),
      log: (lvl, msg, extra) =>
        this.out.appendLine(`${lvl}: ${msg}${extra ? ` ${stringifyErr(extra)}` : ""}`),
    });
    this.running = true;
    // A focus change re-evaluates this session's accrual visibility (focus + cross-instance presence).
    this.windowSub = vscode.window.onDidChangeWindowState(() => this.recomputeVisibility());
    // Each tick: heartbeat presence + recompute visibility, then accrue + flush milestones (≤1s latency).
    this.tickTimer = setInterval(() => {
      this.recomputeVisibility();
      this.controller?.tick();
      this.reporter?.flush();
    }, VIEW_TICK_INTERVAL_MS);
    this.recomputeVisibility(); // seed visibility before the first serve

    // The first fetch; refetch() schedules each subsequent one off the server's rotation cadence
    // (a self-rescheduling timeout, not a fixed interval) so ads can rotate continuously.
    await this.refetch();
    await this.refreshEarnings();
    this.renderWidget();
  }

  async disable(): Promise<void> {
    this.running = false;
    this.controller?.stop();
    this.controller = null;
    this.reporter?.flush(); // don't strand the last buffered milestones on the way out
    this.reporter = null;
    this.clearTimers();
    this.adapter.disable();
    // Leave the presence cohort promptly so other sessions' concurrency cap frees up immediately.
    writePresenceFile(
      this.paths.presence,
      dropInstance(readPresenceFile(this.paths.presence), this.instanceId, Date.now()),
    );
    await vscode.workspace
      .getConfiguration("codecash")
      .update("enabled", false, vscode.ConfigurationTarget.Global);
    this.renderWidget();
    void vscode.window.showInformationMessage("codecash disabled. Original settings restored.");
  }

  /**
   * Heartbeat into the shared presence map and recompute whether THIS session may accrue view time:
   * its own window is focused, OR a developer is present (some codecash window focused recently) and
   * this session is within the concurrency cap — so parallel sessions on a present dev's screen each
   * earn, bounded by the cap and the per-device hourly earn cap. Best-effort; presence I/O never throws.
   */
  private recomputeVisibility(): void {
    const now = Date.now();
    const focused = vscode.window.state.focused;
    const next = heartbeat(readPresenceFile(this.paths.presence), this.instanceId, focused, now);
    writePresenceFile(this.paths.presence, next);
    this.lastVisible = shouldAccrue(next, this.instanceId, focused, now);
    this.controller?.setVisible(this.lastVisible);
  }

  async signOut(): Promise<void> {
    if (this.running) await this.disable();
    await this.auth.clear();
    this.todayMicros = 0;
    this.renderWidget();
    void vscode.window.showInformationMessage("codecash: signed out.");
  }

  showStatus(): void {
    const usd = (this.todayMicros / MICROS_PER_USD).toFixed(2);
    const where = this.running
      ? `running — ${describeState(this.controller?.getState())}`
      : this.auth.hasToken()
        ? "stopped"
        : "not signed in";
    void vscode.window.showInformationMessage(
      `codecash — $${usd} today · ${where}. See full earnings on your dashboard.`,
    );
  }

  private async refetch(): Promise<void> {
    if (!this.controller) return;
    await this.maybeRotateToken();
    const state = await this.controller.fetchAndRender();
    if (state === "auth-required") {
      void vscode.window
        .showWarningMessage("codecash: your session expired — sign in again to keep earning.", "Sign in")
        .then((choice) => {
          if (choice) void this.signIn();
        });
    }
    // Rotate on the server's cadence (fast while serving, backed off when there's no inventory),
    // replacing the old fixed 10-min interval. `?.` because disable() can null the controller mid-fetch.
    this.scheduleNextFetch(nextFetchDelayMs(state, this.controller?.getCurrentServe()?.rotationSeconds));
  }

  /**
   * Queue the next ad fetch. Self-rescheduling (each refetch sets the next timer) so the cadence can
   * change per serve. A no-op once stopped, so disable()/clearTimers() reliably halt the loop.
   */
  private scheduleNextFetch(ms: number): void {
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchTimer = undefined;
    if (!this.running) return;
    this.fetchTimer = setTimeout(() => void this.refetch(), ms);
  }

  /**
   * Proactively rotate the device token once it's past half its life, while it's still valid. The
   * refresh endpoint needs an unexpired token, so the reactive 401 path is too late — by then the
   * token is dead and refresh 401s too, forcing a manual re-link. Rides the existing refetch cadence
   * (no extra timer). Best-effort: on failure the reactive 401 retry + the server's refresh grace
   * window remain the backstops, so a failed rotation never strands serving.
   */
  private async maybeRotateToken(): Promise<void> {
    const token = this.auth.getToken();
    if (!token || !shouldRotateToken(token, Date.now())) return;
    try {
      const fresh = await this.api.refreshToken();
      await this.auth.setToken(fresh);
      this.out.appendLine("rotated device token ahead of expiry");
    } catch (e) {
      this.out.appendLine(`proactive token rotation failed (will retry next cycle): ${stringifyErr(e)}`);
    }
  }

  private async refreshEarnings(): Promise<void> {
    try {
      const e = await this.api.fetchEarnings();
      this.todayMicros = e.todayMicros;
      this.renderWidget();
    } catch {
      /* keep last-known earnings; the widget never blocks on the network */
    }
  }

  private onState(state: ServeState): void {
    this.out.appendLine(`state: ${state}`);
  }

  private renderWidget(): void {
    const usd = (this.todayMicros / MICROS_PER_USD).toFixed(2);
    if (this.running) {
      this.widget.text = `$(rss) codecash ($${usd} today)`;
      this.widget.command = "codecash.status";
      this.widget.tooltip = "codecash — earning while you wait. Click for status.";
      this.widget.backgroundColor = undefined;
    } else if (this.auth.hasToken()) {
      // Connected but paused: make the status bar an obvious call to action, not a dead icon —
      // this is the state where a user would otherwise have to hunt the command palette to enable.
      this.widget.text = "$(rss) codecash — paused";
      this.widget.command = "codecash.enable";
      this.widget.tooltip = "codecash is connected but paused. Click to enable and start earning.";
      this.widget.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      // Fresh user: a click should start the one-click connect flow, not show an empty status.
      this.widget.text = "$(rss) codecash";
      this.widget.command = "codecash.connect";
      this.widget.tooltip = "codecash — click to connect and get paid for waiting.";
      this.widget.backgroundColor = undefined;
    }
  }

  private clearTimers(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.tickTimer = undefined;
    this.fetchTimer = undefined;
    this.windowSub?.dispose();
    this.windowSub = undefined;
  }

  dispose(): void {
    this.clearTimers();
  }
}

function describeState(state: ServeState | undefined): string {
  switch (state) {
    case "serving":
      return "showing an ad";
    case "idle-killed":
      return "paused (server killswitch)";
    case "idle-empty":
      return "no ads available right now";
    case "auth-required":
      return "sign-in required";
    case "error":
      return "reconnecting…";
    default:
      return "starting…";
  }
}

function stringifyErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
