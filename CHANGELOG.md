# Changelog

All notable changes to the **codecash** extension are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the [Keep a Changelog](https://keepachangelog.com/)
format.

## [0.1.6] — 2026-06-16

### Changed
- **Coexists with the codecash command-line app.** If you also run the standalone `codecash` CLI on the
  same machine, the extension now automatically steps aside while the CLI is serving (and takes back over
  if you stop it), so the two never double-count or fight over your Claude Code settings.
- First release published to **Open VSX** as well as the VS Code Marketplace, so Cursor, Windsurf, and
  VSCodium users can install codecash too.

### Internal
- The status-line ad cache is now keyed per Claude Code session, so two terminals in the same project
  each show their own ad.

## [0.1.5] — 2026-06-15

### Changed
- **Ads now lead with the advertiser's name.** The ad line reads `Brand · message`
  (e.g. `Ramp · save time and money`) on the Claude Code spinner, the terminal status line, and the
  Claude Code panel — so you can always see who's sponsoring.
- **Cleaner click link.** Clicking an ad in the terminal now opens a short, tidy link instead of a
  long token URL, so VS Code's "open external website?" prompt is easy to read. Clicks are still
  tracked through the same secure redirect.

### Notes
- No change to how earnings work, and your `~/.claude/settings.json` is still backed up on enable and
  restored exactly on disable.

## [0.1.1] – [0.1.4] — 2026-06-15

Initial public releases on the VS Code Marketplace and Open VSX.

- One tasteful sponsored ad injected into Claude Code's wait states — the spinner "thinking" verb and
  a clickable status-line hyperlink — paying you a revenue share.
- One-click **Connect & start earning** browser handoff; status-bar earnings widget; full
  backup/restore of your Claude Code settings.
- **Claude Code panel** surface: the ad also shows as the panel's "thinking" spinner verb
  (config-bridge via the `claudeCode.spinnerVerbs` setting; spinner-verb only, no in-panel link).
- "Never break your CLI" guarantees: the status-line renderer is dependency-free, never throws, makes
  no network calls, and chain-captures any existing status line instead of clobbering it.
