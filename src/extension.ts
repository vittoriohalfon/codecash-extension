import * as vscode from "vscode";
import { CodecashService } from "./host/service.js";

/**
 * Extension host. Phase 3 wires the full client money loop: sign in (device token in
 * SecretStorage) → fetch a signed ad → render it on the claude-cli surface → accrue on-screen view
 * time → at the threshold POST a billable impression → reflect earnings in the status-bar widget.
 * The stateful orchestration lives in CodecashService; this file is activation + commands + the
 * vscode:// sign-in deep link.
 */
export function activate(context: vscode.ExtensionContext): void {
  const renderScriptPath = context.asAbsolutePath("dist/render.mjs");
  // The Codex status-line render script (config adapter's [tui].status_line_command target). Resolved
  // here so it's an absolute path inside the installed extension, like the claude render script above.
  const renderCodexScriptPath = context.asAbsolutePath("dist/renderCodex.mjs");

  const widget = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  widget.text = "$(rss) codecash";
  widget.tooltip = "codecash — get paid to vibe code";
  widget.command = "codecash.status";
  widget.show();
  context.subscriptions.push(widget);

  const service = new CodecashService(context, widget, renderScriptPath, renderCodexScriptPath);
  context.subscriptions.push({ dispose: () => service.dispose() });
  // Capture an init crash (auth load / resume) instead of leaving it an unhandled rejection.
  void service.init().catch((e) => service.reportError(e, "init"));

  // Wrap every command/URI callback so an unexpected throw is reported to Datadog (via the anonymous
  // channel) AND swallowed — a failed command must never surface as a raw error or break the CLI.
  const guard =
    (where: string, fn: () => unknown) =>
    (): unknown => {
      try {
        const r = fn();
        return r instanceof Promise ? r.catch((e) => service.reportError(e, where)) : r;
      } catch (e) {
        service.reportError(e, where);
        return undefined;
      }
    };

  context.subscriptions.push(
    vscode.commands.registerCommand("codecash.connect", guard("command:connect", () => service.connect())),
    vscode.commands.registerCommand("codecash.enable", guard("command:enable", () => service.enable())),
    vscode.commands.registerCommand("codecash.disable", guard("command:disable", () => service.disable())),
    vscode.commands.registerCommand("codecash.signIn", guard("command:signIn", () => service.signIn(true))),
    vscode.commands.registerCommand("codecash.signOut", guard("command:signOut", () => service.signOut())),
    vscode.commands.registerCommand("codecash.status", guard("command:status", () => service.showStatus())),
    vscode.commands.registerCommand("codecash.shareEarnings", guard("command:shareEarnings", () => service.share())),
    vscode.commands.registerCommand("codecash.contactSupport", guard("command:contactSupport", () => service.contactSupport())),
    // The web link-device page deep-links the token back here, e.g.
    // <uriScheme>://codecash.codecash/auth?token=<jwt>&state=<nonce>. The state is verified in
    // signInWithToken so an unsolicited link can't bind this editor to another account.
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        // Match the path leniently: when the editor's asExternalUri folds a `windowId` into the
        // callback, the path can arrive as "/auth?windowId=4" (the '?' percent-escaped), so an
        // exact "=== /auth" check would silently drop the token. Strip any embedded query first.
        if (authPath(uri.path) !== "/auth") return;
        const params = new URLSearchParams(uri.query);
        const token = params.get("token");
        if (token) void service.signInWithToken(token, params.get("state")).catch((e) => service.reportError(e, "uri:auth"));
      },
    }),
  );

  // First run: open the Getting Started walkthrough once so a fresh install has an obvious next
  // step instead of a silent status-bar icon. Gated on globalState so it never nags returning users.
  const WELCOMED_KEY = "codecash.welcomed";
  if (!context.globalState.get<boolean>(WELCOMED_KEY)) {
    void context.globalState.update(WELCOMED_KEY, true);
    // First activation on this machine: the top of the pre-auth funnel (install → connect → enable),
    // so the installed-but-never-signed-in cohort is finally visible.
    service.signalInstall();
    void vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      `${context.extension.id}#codecashStart`,
      false,
    );
  }
}

/**
 * Normalize a deep-link path to compare against "/auth". Tolerates an embedded (percent-escaped)
 * query the editor may fold into the path — e.g. "/auth%3FwindowId=4" → "/auth" — and a trailing
 * slash. decodeURIComponent is guarded so a malformed path can never throw out of the URI handler.
 */
function authPath(rawPath: string): string {
  let p = rawPath;
  try {
    p = decodeURIComponent(rawPath);
  } catch {
    /* keep the raw path */
  }
  return (p.split("?")[0] ?? "").replace(/\/+$/, "");
}

export function deactivate(): void {
  // Intentionally do NOT auto-restore here: deactivate runs on every shutdown/disable, so restoring
  // would drop the ad on each reload. The two real teardowns are handled elsewhere: `codecash.disable`
  // (explicit, in-process) and the `vscode:uninstall` hook (src/uninstall.ts → dist/uninstall.mjs),
  // which runs as plain node on a genuine uninstall and restores both surfaces from the ~/.codecash
  // captures.
}
