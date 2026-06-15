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

  const widget = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  widget.text = "$(rss) codecash";
  widget.tooltip = "codecash — get paid for waiting";
  widget.command = "codecash.status";
  widget.show();
  context.subscriptions.push(widget);

  const service = new CodecashService(context, widget, renderScriptPath);
  context.subscriptions.push({ dispose: () => service.dispose() });
  void service.init();

  context.subscriptions.push(
    vscode.commands.registerCommand("codecash.connect", () => service.connect()),
    vscode.commands.registerCommand("codecash.enable", () => service.enable()),
    vscode.commands.registerCommand("codecash.disable", () => service.disable()),
    vscode.commands.registerCommand("codecash.signIn", () => service.signIn(true)),
    vscode.commands.registerCommand("codecash.signOut", () => service.signOut()),
    vscode.commands.registerCommand("codecash.status", () => service.showStatus()),
    vscode.commands.registerCommand("codecash.shareEarnings", () => service.share()),
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
        if (token) void service.signInWithToken(token, params.get("state"));
      },
    }),
  );

  // First run: open the Getting Started walkthrough once so a fresh install has an obvious next
  // step instead of a silent status-bar icon. Gated on globalState so it never nags returning users.
  const WELCOMED_KEY = "codecash.welcomed";
  if (!context.globalState.get<boolean>(WELCOMED_KEY)) {
    void context.globalState.update(WELCOMED_KEY, true);
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
  // Intentionally do NOT auto-restore here: disabling is an explicit user action so the ad keeps
  // serving across reloads. `codecash.disable` performs the clean restore.
}
