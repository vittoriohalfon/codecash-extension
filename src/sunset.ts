/**
 * The sunset build. codecash has stopped serving ads, so this version of the extension does exactly
 * three things: put the user's settings back, tell them once what happened and where their money is,
 * and stay out of the way.
 *
 * It is a HARD disable, not a flag: the serving loop, auth, adapters, and telemetry are never
 * constructed and `host/service.ts` is never imported, so esbuild drops the entire money loop from the
 * bundle. There is no code path left that can inject an ad, and no server response that can re-enable
 * one. That's deliberate — a shutdown build that could be talked back into serving by a stale flag
 * would be worse than no shutdown build at all.
 *
 * The counterpart on the server is notice mode (`apps/web/src/lib/notice.ts`), which reaches the
 * installs that never receive THIS release. The two are complementary and mutually exclusive in
 * practice: a client carrying this build stops calling `/api/ads/next` entirely, so it never sees a
 * notice; a client that never updates only ever sees the notice.
 *
 * Restoring on every activation (not once) is intentional. It's idempotent and cheap, and it covers
 * the window where a user updated while a previous version had ads live — the injection is undone the
 * moment this build first runs, without waiting for an uninstall.
 */
import * as vscode from "vscode";
import { homedir } from "node:os";
import { restoreAllSurfaces, type RestoreResult } from "./lib/restoreSurfaces.js";

/**
 * Where to send someone who wants their money. Overridden at build time by the same env var the
 * serving build used, but defaults to PRODUCTION rather than localhost — a sunset build only ever
 * ships to real users, and a cash-out link pointing at a dev server is worse than no link.
 */
const WEB_BASE_URL =
  (process.env.CODECASH_DEFAULT_API_BASE_URL || "").trim() || "https://www.codecash.dev";

const DASHBOARD_URL = `${WEB_BASE_URL}/app/dashboard`;
const SUNSET_URL = `${WEB_BASE_URL}/sunset`;

/** Gate the unprompted popup so it appears once per machine, not once per window. */
const NOTICE_SHOWN_KEY = "codecash.sunsetNoticeShown";

const HEADLINE = "codecash has paused ad serving.";

/**
 * Lead with what changed on their machine, because that's what they'll notice first and what they'd
 * otherwise have to investigate. Money second — it's the part people worry about. Uninstall last: it's
 * the right end state, but asking for it before answering "where are my earnings?" reads as evasive.
 */
const DETAIL =
  "Your original Claude Code settings have been restored — the ad is gone from your status line and spinner. " +
  "Any earnings you've already accrued are safe, and you can still cash out from the dashboard. " +
  "You can uninstall this extension whenever you like.";

/** Appended when the standalone CLI still owns the terminal surface, since uninstalling the
 *  extension alone would leave the CLI injecting on its own. */
const CLI_STILL_INSTALLED =
  " The codecash CLI is also installed on this machine and still owns your Claude Code status line — " +
  "remove it with `npm rm -g codecash`.";

function message(restore: RestoreResult): string {
  return HEADLINE + " " + DETAIL + (restore.terminalRestored ? "" : CLI_STILL_INSTALLED);
}

/** The one interaction this build offers: read the details, or go get paid. */
async function showNotice(restore: RestoreResult): Promise<void> {
  const CASH_OUT = "Cash out";
  const DETAILS = "What happened?";
  const choice = await vscode.window.showInformationMessage(message(restore), CASH_OUT, DETAILS);
  if (choice === CASH_OUT) await vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
  else if (choice === DETAILS) await vscode.env.openExternal(vscode.Uri.parse(SUNSET_URL));
}

export function activateSunset(context: vscode.ExtensionContext): void {
  // Undo the injection before anything else — if the rest of activation somehow fails, the user's
  // settings are already back, which is the only part of this that genuinely matters.
  const restore = restoreAllSurfaces(homedir());

  // Keep a status-bar presence. It's the affordance that leads to the cash-out link, and without it
  // the extension would go silent in a way that looks like a bug rather than a shutdown.
  const widget = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  widget.text = "$(rss) codecash (paused)";
  widget.tooltip = message(restore);
  widget.command = "codecash.status";
  widget.show();
  context.subscriptions.push(widget);

  // Every contributed command resolves to the same notice. They stay REGISTERED on purpose: a command
  // in package.json with no handler throws a raw "command not found" error at the user, which is a
  // worse ending than a clear explanation. Nothing here can serve, sign in, or inject.
  const commands = [
    "codecash.connect",
    "codecash.enable",
    "codecash.disable",
    "codecash.signIn",
    "codecash.signOut",
    "codecash.status",
    "codecash.shareEarnings",
    "codecash.contactSupport",
  ];
  for (const id of commands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => {
        // `disable` is the one command whose literal intent we can still honor, so re-run the restore
        // before explaining — it costs nothing and leaves no doubt the settings are clean.
        if (id === "codecash.disable") restoreAllSurfaces(homedir());
        void showNotice(restore);
      }),
    );
  }

  // Tell them once, unprompted. After that the status bar carries it — a popup on every window would
  // be nagging about something they can't act on twice.
  if (!context.globalState.get<boolean>(NOTICE_SHOWN_KEY)) {
    void context.globalState.update(NOTICE_SHOWN_KEY, true);
    void showNotice(restore);
  }
}
