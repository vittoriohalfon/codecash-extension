# Changelog

All notable changes to the **codecash** extension are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the [Keep a Changelog](https://keepachangelog.com/)
format.

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
