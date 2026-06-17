import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { VIEW_TICK_INTERVAL_MS, MICROS_PER_USD, type EarningsSnapshot } from "@codecash/shared";
// The whole vscode-free money loop + claude-cli adapter now lives in @codecash/client-core (shared
// with the standalone CLI/daemon). This host owns only the VS Code glue around it.
import {
  nextFetchDelayMs,
  ClaudeCliAdapter,
  type PreflightResult,
  formatAdLabel,
  ApiClient,
  AuthStore,
  looksLikeToken,
  shouldRotateToken,
  ServeController,
  type ServeState,
  SignalCache,
  TelemetryReporter,
  ClientReporter,
  codecashPaths,
  type CodecashPaths,
  heartbeat,
  dropInstance,
  shouldAccrue,
  readPresenceFile,
  writePresenceFile,
} from "@codecash/client-core";
import {
  daemonLiveness,
  daemonLockPath,
  daemonDeferenceTransition,
  type DaemonLiveness,
} from "@codecash/client-core/daemon-lock";
import type { PanelSpinnerBridge } from "../lib/panelBridge.js";
import {
  createPanelBridge,
  detectClaudeCodePanel,
  MIN_CLAUDE_CODE_PANEL_VERSION,
  type PanelDetection,
} from "./panelSurface.js";

// Baked at build time via esbuild `define` (see esbuild.mjs). A published build can ship a prod
// server URL through the CODECASH_DEFAULT_API_BASE_URL env var without any code edit, while local
// dev falls back to the dev server. The `codecash.apiBaseUrl` setting still overrides this.
const DEFAULT_BASE_URL =
  (process.env.CODECASH_DEFAULT_API_BASE_URL || "").trim() || "http://localhost:3000";

/** globalState key for the one-time connect nonce, so a malicious page can't inject a token. */
const PENDING_STATE_KEY = "codecash.pendingConnectState";

/** The placeholder ad shown the instant we enable, before the first real serve arrives. */
const SEED_AD_TEXT = "codecash — get paid to vibe code";

/**
 * How long a piggybacked earnings snapshot stays fresh enough to skip the cold-start /api/me/earnings
 * poll (fleetSignals uses ~90s). Steady-state updates ride the event responses; this only gates the
 * one poll at startServing(), so a recently-credited session re-enabling doesn't re-poll needlessly.
 */
const EARNINGS_FRESH_MS = 90_000;

/**
 * R1 self-healing cadences. A file-watcher re-asserts the injection when ~/.claude/settings.json is
 * changed externally; DEBOUNCE coalesces an editor's multi-write bursts (and our own writes, which
 * the watcher also sees — reassert no-ops when in sync). HEARTBEAT is a low-frequency backstop so the
 * surface stays true even if a watcher event is missed (some platforms / network filesystems), and
 * during long no-fill backoff when pushAd isn't re-writing settings on its own.
 */
const REASSERT_DEBOUNCE_MS = 500;
const REASSERT_HEARTBEAT_MS = 30_000;

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
  /**
   * The claude-code (VS Code panel) surface: mirrors the live ad text into `claudeCode.spinnerVerbs`
   * so users of the Claude Code *extension panel* (not just the terminal CLI) see the ad as the
   * spinner verb. Driven in parallel to {@link adapter}; best-effort, never breaks the CLI surface.
   */
  private readonly panel: PanelSpinnerBridge;
  private controller: ServeController | null = null;
  private reporter: TelemetryReporter | null = null;
  /** Anonymous, pre-auth funnel + crash reporter (always available, even before sign-in). */
  private readonly clientReporter: ClientReporter;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private fetchTimer: ReturnType<typeof setTimeout> | undefined;
  private windowSub: vscode.Disposable | undefined;
  /** R1 self-healing: watches ~/.claude/settings.json for external drift; backstop timer + debounce. */
  private settingsWatcher: vscode.Disposable | undefined;
  private reassertTimer: ReturnType<typeof setInterval> | undefined;
  private reassertDebounce: ReturnType<typeof setTimeout> | undefined;
  private todayMicros = 0;
  /** Latest earnings snapshot the server piggybacked on event responses (R2); gates the cold poll. */
  private readonly signals = new SignalCache();
  private running = false;
  private readonly out: vscode.OutputChannel;
  private readonly extensionId: string;
  private readonly memento: vscode.Memento;
  private readonly paths: CodecashPaths = codecashPaths();
  /** The CLI daemon's single-instance lock (Phase D / T22 coexistence) — read each tick to defer. */
  private readonly daemonLock = daemonLockPath(this.paths.codecashDir);
  /**
   * True while we've stood down because a live CLI daemon owns the claude-cli loop (asymmetric
   * coexistence: the daemon never checks us, so there's no livelock). While deferred we stop
   * serving/accruing/crediting AND stop touching ~/.claude/settings.json (the CLI owns it); the tick
   * keeps polling daemon liveness and resumes us when it goes away. See {@link syncDaemonCoexistence}.
   */
  private deferredToDaemon = false;
  /** Unique per extension-host (per VS Code window) — identity in the shared presence map. */
  private readonly instanceId = randomUUID();
  /** Last computed accrual visibility (focus OR present-within-cap); seeds the view tracker. */
  private lastVisible = false;
  /**
   * Last auth/serving state mirrored into the VS Code context keys that gate the command palette
   * (see contributes.menus.commandPalette). Two auth keys, deliberately distinct:
   *   • codecash:signedIn   — a device token is stored (usable or not) → gates Sign out / earnings / share.
   *   • codecash:sessionLive — that token is actually usable (not expired past grace) → gates the auth
   *                            entry points (Connect / paste, shown when NOT live) and Enable.
   * Splitting them keeps every state's palette correct: an auth-required session still offers Sign
   * out *and* re-link. `undefined` until the first sync so the initial setContext always fires.
   */
  private ctxSignedIn: boolean | undefined;
  private ctxSessionLive: boolean | undefined;
  private ctxEnabled: boolean | undefined;
  /**
   * True once the serve loop hit `auth-required` (token expired past the refresh grace) and not yet
   * re-authed. We deliberately keep the stored token (rotation + grace self-heal), so `hasToken()`
   * alone can't tell a usable session from a dead one — this flag does, so the palette/widget re-
   * surface the auth entry points exactly when re-link is actually needed. Cleared on a good serve,
   * a fresh token, or disable.
   */
  private authRequired = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly widget: vscode.StatusBarItem,
    renderScriptPath: string,
  ) {
    this.auth = new AuthStore(context.secrets);
    // This window's project folder keys the per-workspace ad cache → distinct ad per parallel session.
    const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    this.adapter = new ClaudeCliAdapter(renderScriptPath, this.paths, workspaceDir);
    this.panel = createPanelBridge(context.globalState, context.globalStorageUri.fsPath);
    this.out = vscode.window.createOutputChannel("codecash");
    // Resolve the base URL per-request so changing `codecash.apiBaseUrl` takes effect without reload.
    this.api = new ApiClient({ baseUrl: () => this.baseUrl(), getToken: this.auth.getToken });
    this.extensionId = context.extension.id;
    this.memento = context.globalState;
    // Anonymous pre-auth reporter: built once here (NOT per-serve like the telemetry reporter) so it
    // can emit install/connect/preflight signals and crash reports before any device token exists.
    this.clientReporter = new ClientReporter(
      { postClientEvents: (b) => this.api.postClientEvents(b) },
      this.resolveAnonId(context),
      {
        adapter: "claude-cli",
        platform: process.platform,
        extVersion:
          typeof context.extension.packageJSON?.version === "string"
            ? (context.extension.packageJSON.version as string)
            : undefined,
      },
    );
    context.subscriptions.push(this.out);
  }

  /**
   * A stable, random, non-PII per-install id for the anonymous funnel (install → connect_started →
   * connected → enabled) and crash reports. Generated once and kept in globalState; it identifies an
   * INSTALL, never a user, so it works before — and independent of — any device token.
   */
  private resolveAnonId(context: vscode.ExtensionContext): string {
    const KEY = "codecash.anonId";
    let id = context.globalState.get<string>(KEY);
    if (!id) {
      id = randomUUID();
      void context.globalState.update(KEY, id);
    }
    return id;
  }

  /** Forward an extension-host error to Datadog via the anonymous channel. Always safe to call. */
  reportError(error: unknown, where: string): void {
    this.clientReporter.reportError(error, where);
  }

  /** Emit the one-time `install` funnel signal (called from activation's first-run gate). */
  signalInstall(): void {
    this.clientReporter.signal("install");
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
    const surf = await this.detectSurfaces();
    if (!surf.ok) {
      this.clientReporter.signal("preflight_failed", {
        reason: surf.reason,
        ccVersion: surf.cli.ccVersion ?? undefined,
      });
      this.out.appendLine(`resume skipped: ${surf.reason}`);
      return;
    }
    // Don't inject over a live CLI daemon (Phase D / T22) — startServing() stands us down and the
    // tick resumes us when it stops. See enable()'s matching gate.
    const daemonLive = this.daemonOwnsLoop();
    if (!daemonLive) {
      const injected = await this.injectSurfaces(SEED_AD_TEXT, surf);
      if (!injected.ok) {
        this.clientReporter.reportError(injected.error, "resume.inject");
        this.out.appendLine(`resume failed: ${stringifyErr(injected.error)}`);
        return;
      }
    }
    await this.startServing();
    this.out.appendLine(daemonLive ? "resumed (deferred to the CLI daemon)" : `resumed serving on ${surf.label}`);
  }

  /**
   * Editor-initiated connect (the primary path). Opens the web sign-in page with a callback URI
   * that routes the freshly minted device token straight back to THIS editor — no copy-paste — plus
   * a one-time `state` nonce so an unrelated page can't inject a token. `uriScheme` + asExternalUri
   * make the round-trip work across VS Code / Insiders / Cursor / Windsurf and Remote/Codespaces.
   * Falls back to manual paste if the callback can't be built or doesn't round-trip.
   */
  async connect(): Promise<void> {
    if (this.auth.hasToken() && !this.authRequired) {
      // Already connected with a usable session: clicking "Connect & start earning" again should
      // just turn ads on. (A stale, expired-past-grace token falls through to the full re-link flow
      // below — the stored token is dead, so we mint a fresh one rather than claim we're earning.)
      if (this.running) {
        const choice = await vscode.window.showInformationMessage(
          "codecash is already connected and earning — you're all set.",
          "Show earnings",
        );
        if (choice === "Show earnings") this.showStatus();
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
    this.clientReporter.signal("connect_started");
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
    this.clientReporter.signal("connect_started");
    await vscode.env.openExternal(vscode.Uri.parse(`${this.baseUrl()}/app/link-device`));
    return this.promptPasteToken(autoEnable);
  }

  /**
   * Open the web dashboard, where the share card lets the dev copy a link to their public /u/[handle]
   * earnings page (viral mechanics Phase 1) and the referral card copies their /r/<code> invite link
   * (Phase 2). The extension intentionally knows neither the handle nor the code — the dashboard owns
   * both loops; this command (Share earnings & invite a dev) is just the doorway.
   */
  async share(): Promise<void> {
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
    this.clientReporter.signal("connected");
    this.authRequired = false; // a fresh token makes the session usable again
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

  /**
   * Detect which ad surfaces are available: the **claude-cli** terminal surface (`claude` on PATH +
   * version gate) and/or the **claude-code** extension-panel surface (the Claude Code VS Code
   * extension is installed). Either one is enough to enable — a panel-only user (extension installed,
   * no `claude` on PATH) used to be turned away by the CLI-only preflight. `label` describes the live
   * surface(s) for the success toast; `reason` explains a hard no-surface failure.
   */
  private async detectSurfaces(): Promise<{
    ok: boolean;
    cli: PreflightResult;
    panel: PanelDetection | null;
    label?: string;
    reason?: string;
  }> {
    const cli = await this.adapter.preflight();
    const panel = detectClaudeCodePanel();
    const panelOk = !!panel && panel.compatible;
    if (cli.ok) {
      return {
        ok: true,
        cli,
        panel,
        label: `Claude Code ${cli.ccVersion}${panelOk ? " + extension panel" : ""}`,
      };
    }
    if (panelOk) {
      return {
        ok: true,
        cli,
        panel,
        label: `the Claude Code extension panel${panel!.version ? ` ${panel!.version}` : ""}`,
      };
    }
    const reason =
      cli.ccVersion != null
        ? (cli.reason ?? "Claude Code is not compatible")
        : panel != null
          ? `the Claude Code extension is too old (need ${MIN_CLAUDE_CODE_PANEL_VERSION}+)`
          : "Claude Code not found — install the CLI or the Claude Code VS Code extension";
    return { ok: false, cli, panel, reason };
  }

  /**
   * Inject every available surface, best-effort. Succeeds when AT LEAST ONE surface is now live; only
   * fails (returning the first surface's error, for an actionable message) when none could be
   * injected. The panel surface is always wrapped so a settings.json-write hiccup can never block the
   * terminal surface, and vice-versa.
   */
  private async injectSurfaces(
    seed: string,
    surf: { cli: PreflightResult; panel: PanelDetection | null },
  ): Promise<{ ok: true } | { ok: false; error: unknown }> {
    let anyOk = false;
    let firstErr: unknown;
    if (surf.cli.ok) {
      try {
        await this.adapter.enable(seed);
        anyOk = true;
      } catch (e) {
        firstErr = e;
      }
    }
    if (surf.panel?.compatible) {
      try {
        await this.panel.enable(seed);
        anyOk = true;
      } catch (e) {
        firstErr ??= e;
        this.clientReporter.reportError(e, "enable.panel");
        this.out.appendLine(`panel inject failed (non-fatal): ${stringifyErr(e)}`);
      }
    }
    return anyOk ? { ok: true } : { ok: false, error: firstErr ?? new Error("no injectable surface") };
  }

  async enable(): Promise<void> {
    const surf = await this.detectSurfaces();
    if (!surf.ok) {
      this.clientReporter.signal("preflight_failed", {
        reason: surf.reason,
        ccVersion: surf.cli.ccVersion ?? undefined,
      });
      void vscode.window.showWarningMessage(`codecash: ${surf.reason}`);
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

    // Patch the surface(s) up front so the spinner/status line are live even before the first ad. We
    // hard-fail only when NO surface could be injected (e.g. CLI present but ~/.claude/settings.json
    // missing/unparseable, and no panel) — never flip `enabled` on a fully-failed inject.
    //
    // Exception (Phase D / T22): if the CLI daemon already owns the loop, do NOT inject a competing
    // surface — we'd double-credit and fight over settings.json. Flip `enabled` so we take over when
    // the CLI stops, and let startServing() stand us down; the tick resumes us when the daemon dies.
    const daemonLive = this.daemonOwnsLoop();
    if (!daemonLive) {
      const injected = await this.injectSurfaces(SEED_AD_TEXT, surf);
      if (!injected.ok) {
        this.clientReporter.reportError(injected.error, "enable.inject");
        void vscode.window.showWarningMessage(
          `codecash: couldn't enable — ${stringifyErr(injected.error)}. Your Claude Code settings were left untouched.`,
        );
        return;
      }
    }

    await vscode.workspace
      .getConfiguration("codecash")
      .update("enabled", true, vscode.ConfigurationTarget.Global);

    await this.startServing();
    void vscode.window.showInformationMessage(
      daemonLive
        ? "codecash enabled. The codecash command-line app is serving on this machine — the extension will take over automatically if you stop it."
        : `codecash enabled on ${surf.label}. Your settings were backed up.`,
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
      // Fan each fetched ad out to both surfaces: the claude-cli adapter (terminal spinner + status
      // line) and the claude-code panel bridge (the extension panel's spinner verb). The panel write
      // is best-effort — a settings.json hiccup must never break the terminal surface or the loop.
      sink: {
        pushAd: async (serve) => {
          await this.adapter.pushAd(serve);
          try {
            // Brand-prefixed (`<brand> · <ad>`) so the panel's "thinking" verb matches the terminal.
            await this.panel.update(formatAdLabel(serve.creative.brandName, serve.creative.adText));
          } catch (e) {
            this.out.appendLine(`panel update failed (non-fatal): ${stringifyErr(e)}`);
          }
        },
      },
      now: () => Date.now(),
      isVisible: () => this.lastVisible,
      onTelemetry: (type, ctx) => this.reporter?.report(type, ctx),
      onEarned: (credited, earnings) => this.applyEarnings(credited, earnings),
      onState: (s) => this.onState(s),
      onTokenRefreshed: (t) => this.auth.setToken(t),
      log: (lvl, msg, extra) =>
        this.out.appendLine(`${lvl}: ${msg}${extra ? ` ${stringifyErr(extra)}` : ""}`),
    });
    this.running = true;
    this.clientReporter.signal("enabled"); // funnel terminal: serving actually started
    // A focus change re-evaluates this session's accrual visibility (focus + cross-instance presence).
    this.windowSub = vscode.window.onDidChangeWindowState(() => this.recomputeVisibility());
    // Each tick: heartbeat presence + recompute visibility, then accrue + flush milestones (≤1s latency).
    // Wrapped so a throw in a timer callback can't surface as an unhandled rejection on the host.
    this.tickTimer = setInterval(() => {
      try {
        // First, the coexistence poll (Phase D / T22): if a CLI daemon owns the loop, stand down this
        // tick and skip serving entirely (the daemon credits; we'd double-credit + fight settings).
        if (this.syncDaemonCoexistence()) return;
        this.recomputeVisibility();
        this.controller?.tick();
        this.reporter?.flush();
      } catch (e) {
        this.clientReporter.reportError(e, "tick");
      }
    }, VIEW_TICK_INTERVAL_MS);
    this.startSelfHealing(); // keep the injection true if settings.json drifts (R1)

    // If a CLI daemon already owns the loop, stand down now instead of fetching a competing surface;
    // the tick keeps polling and resumes us (re-inject + serve) when the daemon goes away.
    if (this.syncDaemonCoexistence()) {
      this.renderWidget();
      return;
    }

    this.recomputeVisibility(); // seed visibility before the first serve

    // The first fetch; refetch() schedules each subsequent one off the server's rotation cadence
    // (a self-rescheduling timeout, not a fixed interval) so ads can rotate continuously.
    await this.refetch();
    // Cold-start earnings: steady-state updates ride the event responses (applyEarnings), so only
    // poll here when no recent snapshot is cached (e.g. first enable after a reload).
    if (!this.signals.earningsFreshWithin(EARNINGS_FRESH_MS, Date.now())) await this.refreshEarnings();
    this.renderWidget();
  }

  /**
   * Whether a live CLI daemon currently owns the loop. FAILS CLOSED (finding C1): an indeterminate
   * lock read (present-but-unreadable — transient EACCES/EBUSY or a torn file) holds the CURRENT
   * stance rather than resuming, so a read hiccup can never flip us out of deference into a
   * double-serve. Only POSITIVE evidence the daemon is gone (lock absent / pid dead / mtime stale)
   * resumes us; only a positive "live" stands us down. Never throws.
   */
  private daemonOwnsLoop(): boolean {
    let liveness: DaemonLiveness;
    try {
      liveness = daemonLiveness(this.daemonLock, Date.now());
    } catch {
      liveness = "unknown";
    }
    if (liveness === "unknown") return this.deferredToDaemon; // can't tell → hold the current stance.
    return liveness === "live";
  }

  /**
   * Coexistence with the standalone CLI daemon (Phase D / T22). The daemon and the extension both
   * serve the claude-cli surface and both credit THIS device — if both ran we'd double-credit and
   * fight over ~/.claude/settings.json. Resolution is asymmetric (see {@link daemonDeferenceTransition}):
   * a live daemon unconditionally owns the loop, so the extension stands down within one tick and
   * resumes when the daemon goes away. Returns true while deferred (the caller skips its serve work).
   * Never throws, and fails closed: an indeterminate lock read holds the current stance rather than
   * resuming (see {@link daemonOwnsLoop}), so a transient hiccup can't open a double-serve window.
   */
  private syncDaemonCoexistence(): boolean {
    switch (daemonDeferenceTransition(this.deferredToDaemon, this.daemonOwnsLoop())) {
      case "enter":
        this.enterDaemonDeference();
        break;
      case "exit":
        void this.exitDaemonDeference();
        break;
    }
    return this.deferredToDaemon;
  }

  /**
   * Stand down because a live CLI daemon now owns the claude-cli loop: cancel the pending fetch and
   * freeze accrual (belt-and-suspenders with the refetch()/reassert guards). We deliberately do NOT
   * restore ~/.claude/settings.json — the CLI owns it now and the daemon re-writes the spinner each
   * tick; restoring could clobber the CLI's surface. The controller + timers stay alive so the tick
   * keeps polling daemon liveness and {@link exitDaemonDeference} can resume us.
   */
  private enterDaemonDeference(): void {
    this.deferredToDaemon = true;
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchTimer = undefined;
    this.controller?.setVisible(false);
    this.out.appendLine("standing down — the codecash CLI daemon is serving on this machine");
    this.renderWidget();
  }

  /**
   * Resume after the CLI daemon went away: re-assert OUR surface (settings now reflect the CLI's
   * install, so a plain reassert would no-op) and restart the fetch loop. Best-effort re-inject — on
   * failure the self-healing backstop + the next pushAd retry; we never throw out of the tick. Guards
   * against re-entrancy: if a daemon re-appeared during the await we leave the (re-)deference alone.
   */
  private async exitDaemonDeference(): Promise<void> {
    this.deferredToDaemon = false;
    this.out.appendLine("resuming — the codecash CLI daemon is gone; taking the loop back");
    try {
      const surf = await this.detectSurfaces();
      if (surf.ok && !this.deferredToDaemon && this.running) {
        await this.injectSurfaces(SEED_AD_TEXT, surf);
      }
    } catch (e) {
      this.clientReporter.reportError(e, "coexistence.resume");
    }
    this.renderWidget();
    if (this.running && !this.deferredToDaemon) {
      this.recomputeVisibility(); // re-seed accrual visibility before the first post-resume serve
      await this.refetch();
    }
  }

  async disable(): Promise<void> {
    this.running = false;
    this.authRequired = false; // not serving → no stale auth-required state to surface
    this.controller?.stop();
    this.controller = null;
    this.reporter?.flush(); // don't strand the last buffered milestones on the way out
    this.reporter = null;
    this.clearTimers();
    // While deferred to the CLI daemon we never owned ~/.claude/settings.json, so don't restore it —
    // that would clobber the CLI's injection. The CLI's own `uninstall` manages its surface. (The
    // panel restore below stays unconditional: the daemon is claude-cli only and never touches it.)
    if (!this.deferredToDaemon) this.adapter.disable();
    this.deferredToDaemon = false;
    // Restore the panel's spinner verb too (best-effort — never let a config restore failure stop the
    // disable path or strand the terminal restore that already ran).
    try {
      await this.panel.disable();
    } catch (e) {
      this.out.appendLine(`panel restore failed (non-fatal): ${stringifyErr(e)}`);
    }
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

  /**
   * R1 self-healing: keep our injection true while serving. pushAd already re-installs settings each
   * rotation, but nothing covers an external edit between rotations, a stale render-script path after
   * an extension update, or long idle/no-fill windows. A file-watcher reacts to external writes and a
   * low-frequency backstop covers missed events — both delegate to the idempotent adapter.reassert(),
   * which writes ONLY on real drift, so our own writes don't loop. Best-effort: a watcher that can't
   * be created (unusual FS) just leaves the backstop timer; nothing here ever breaks serving.
   */
  private startSelfHealing(): void {
    try {
      const claudeDir = join(this.paths.home, ".claude");
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(claudeDir), "settings.json"),
      );
      const onChange = () => this.debouncedReassert();
      watcher.onDidChange(onChange);
      watcher.onDidCreate(onChange);
      watcher.onDidDelete(onChange);
      this.settingsWatcher = watcher;
    } catch (e) {
      this.out.appendLine(`self-heal watcher unavailable (backstop only): ${stringifyErr(e)}`);
    }
    this.reassertTimer = setInterval(() => this.reassertSurface(), REASSERT_HEARTBEAT_MS);
  }

  /** Coalesce a burst of settings writes (an editor save, or our own write) into one reassert. */
  private debouncedReassert(): void {
    if (this.reassertDebounce) clearTimeout(this.reassertDebounce);
    this.reassertDebounce = setTimeout(() => {
      this.reassertDebounce = undefined;
      this.reassertSurface();
    }, REASSERT_DEBOUNCE_MS);
  }

  /** Re-assert the injection if it drifted. No-op when stopped or already in sync. Never throws. */
  private reassertSurface(): void {
    // While deferred to the CLI daemon (T22) the CLI owns settings.json — reasserting our injection
    // would restart the very settings war the asymmetric guard exists to prevent.
    if (!this.running || this.deferredToDaemon) return;
    try {
      const res = this.adapter.reassert();
      if (res.reasserted) this.out.appendLine("re-asserted ad injection (settings.json had drifted)");
    } catch (e) {
      this.out.appendLine(`reassert failed (will retry): ${stringifyErr(e)}`);
    }
  }

  async signOut(): Promise<void> {
    if (this.running) await this.disable();
    // Best-effort server-side revoke BEFORE we drop the local token: kills this device's token so it
    // can't keep rotating within the server's refresh grace window after the user disconnects.
    // Offline / already-expired → fall through; the local clear below still signs the user out.
    if (this.auth.hasToken()) {
      try {
        await this.api.revokeToken();
      } catch (e) {
        this.out.appendLine(`sign-out: server revoke failed (clearing locally anyway): ${stringifyErr(e)}`);
      }
    }
    await this.auth.clear();
    this.todayMicros = 0;
    this.signals.clear(); // never carry one identity's earnings into the next sign-in
    this.renderWidget();
    void vscode.window.showInformationMessage("codecash: signed out.");
  }

  showStatus(): void {
    const usd = (this.todayMicros / MICROS_PER_USD).toFixed(2);
    const where = this.deferredToDaemon
      ? "standing by — the codecash command-line app is serving on this machine"
      : this.running
        ? `running — ${describeState(this.controller?.getState())}`
        : this.auth.hasToken()
          ? "stopped"
          : "not signed in";
    void vscode.window.showInformationMessage(
      `codecash — $${usd} today · ${where}. See full earnings on your dashboard.`,
    );
  }

  private async refetch(): Promise<void> {
    // Skip while deferred to the CLI daemon (T22): the daemon is serving — a fetch here would credit
    // a second impression for the same device. A fetch scheduled just before we deferred no-ops here.
    if (!this.controller || this.deferredToDaemon) return;
    await this.maybeRotateToken();
    const state = await this.controller.fetchAndRender();
    // Track whether the session is currently usable so the palette/widget surface re-auth exactly
    // when it's needed. A definitively-authed outcome clears the flag; "error" is left untouched
    // (it's usually a transient network blip, not an auth failure) so we don't flap the auth state.
    const wasAuthRequired = this.authRequired;
    if (state === "auth-required") {
      this.authRequired = true;
      void vscode.window
        .showWarningMessage("codecash: your session expired — sign in again to keep earning.", "Sign in")
        .then((choice) => {
          if (choice) void this.signIn();
        });
    } else if (state !== "error") {
      this.authRequired = false;
    }
    if (this.authRequired !== wasAuthRequired) this.renderWidget();
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
    this.fetchTimer = setTimeout(
      () => void this.refetch().catch((e) => this.clientReporter.reportError(e, "refetch")),
      ms,
    );
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
      this.signals.noteEarnings(e, Date.now());
      this.todayMicros = e.todayMicros;
      this.renderWidget();
    } catch {
      /* keep last-known earnings; the widget never blocks on the network */
    }
  }

  /**
   * Update the earnings widget from a billable-event response. The server piggybacks the dev's running
   * totals (R2 / fleetSignals), so a credit updates the widget with NO extra /api/me/earnings round-
   * trip. The snapshot is an authoritative ledger read, so we apply it on any outcome. We only fall
   * back to a poll against an older server that omitted the snapshot, and only when a credit actually
   * landed — preserving the pre-R2 behavior without polling on every deduped retry.
   */
  private applyEarnings(creditedMicros: number, earnings?: EarningsSnapshot): void {
    if (earnings) {
      this.signals.noteEarnings(earnings, Date.now());
      this.todayMicros = earnings.todayMicros;
      this.renderWidget();
      return;
    }
    if (creditedMicros > 0) void this.refreshEarnings();
  }

  private onState(state: ServeState): void {
    this.out.appendLine(`state: ${state}`);
  }

  private renderWidget(): void {
    this.syncContext();
    const usd = (this.todayMicros / MICROS_PER_USD).toFixed(2);
    if (this.running && this.deferredToDaemon) {
      // Deferred to the CLI daemon (T22): it's earning on this machine, not us — don't show an
      // extension earnings figure that would double-count or look stalled. Status is still clickable.
      this.widget.text = "$(rss) codecash — CLI active";
      this.widget.command = "codecash.status";
      this.widget.tooltip =
        "codecash: the command-line app is serving on this machine. The extension is standing by and will take over if you stop it.";
      this.widget.backgroundColor = undefined;
    } else if (this.running && this.authRequired) {
      // Serving but stalled on auth: don't claim we're earning — make re-link the obvious next step
      // (the auth-required toast is transient; this is the persistent surface).
      this.widget.text = "$(rss) codecash — sign-in needed";
      this.widget.command = "codecash.signIn";
      this.widget.tooltip = "codecash: your session expired. Click to sign in again and keep earning.";
      this.widget.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else if (this.running) {
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
      this.widget.tooltip = "codecash — click to connect and get paid to vibe code.";
      this.widget.backgroundColor = undefined;
    }
  }

  /**
   * Mirror authentication + serving state into the context keys that gate the command palette
   * (contributes.menus.commandPalette). Driven from renderWidget so it's re-evaluated at every
   * transition (load, connect, enable, disable, sign-out, auth-required) and can never drift from
   * the widget. See the field doc on ctxSignedIn/ctxSessionLive for what each key means. `enabled`
   * stays true through auth-required (the loop is running, just stalled) so Disable remains the way
   * to stop it. Idempotent: only fires setContext on an actual change.
   */
  private syncContext(): void {
    const signedIn = this.auth.hasToken();
    const sessionLive = signedIn && !this.authRequired;
    const enabled = this.running;
    if (signedIn !== this.ctxSignedIn) {
      this.ctxSignedIn = signedIn;
      void vscode.commands.executeCommand("setContext", "codecash:signedIn", signedIn);
    }
    if (sessionLive !== this.ctxSessionLive) {
      this.ctxSessionLive = sessionLive;
      void vscode.commands.executeCommand("setContext", "codecash:sessionLive", sessionLive);
    }
    if (enabled !== this.ctxEnabled) {
      this.ctxEnabled = enabled;
      void vscode.commands.executeCommand("setContext", "codecash:enabled", enabled);
    }
  }

  private clearTimers(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    if (this.reassertTimer) clearInterval(this.reassertTimer);
    if (this.reassertDebounce) clearTimeout(this.reassertDebounce);
    this.tickTimer = undefined;
    this.fetchTimer = undefined;
    this.reassertTimer = undefined;
    this.reassertDebounce = undefined;
    this.windowSub?.dispose();
    this.windowSub = undefined;
    this.settingsWatcher?.dispose();
    this.settingsWatcher = undefined;
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
