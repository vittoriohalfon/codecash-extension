# Changelog

All notable changes to the **codecash** extension are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the [Keep a Changelog](https://keepachangelog.com/)
format.

## [0.1.11] — 2026-06-18

### Added
- **Relevant ads — opt-in, off by default.** Turn on the `codecash.relevantAds` setting to match ads
  to your tech stack and earn the premium rate. codecash reads only your project's dependency
  manifests (like `package.json`, `go.mod`, `requirements.txt`) **locally** and sends ~a dozen coarse
  tags such as `fw:next` — never your code, file names, or prompts. It stays off until you enable it,
  and you can turn it back off in one click.

## [0.1.10] — 2026-06-17

### Fixed
- The "thinking" spinner ad could show a **different advertiser** than the clickable status-line ad
  beneath it when you ran several Claude Code sessions or VS Code windows at once. The spinner is one
  machine-wide setting while each window earns on its own status line, so they could drift apart. The
  spinner now shows an ad only when every active window agrees on one; the moment they differ it
  reverts to your own spinner — so the two surfaces can never contradict each other.

## [0.1.9] — 2026-06-17

### Changed
- Refreshed the tagline to **"get paid to vibe code"** across the extension name, the onboarding
  walkthrough, and the status-bar tooltip. No behavior change — same one-ad-in-your-wait-states loop.

## [0.1.8] — 2026-06-16

### Changed
- **Developer revenue share raised to 70%** (from 50%). You now keep **70%** of the revenue from
  every ad you show. The split is applied server-side, so it takes effect on your next earned
  impression — nothing to update.

## [0.1.7] — 2026-06-16

### Fixed
- **Never leaves your Claude Code status line pointing at a removed install.** If the extension was
  uninstalled or updated while a window was still open, the old in-memory copy could keep rewriting
  `~/.claude/settings.json` to its own (now-deleted) render script — blanking the status-line ad (and
  its clickable link). The self-healing reassert now stops as soon as its own render script is gone,
  so a stale copy can't fight a healthy install (CLI or extension) for the status line.

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
