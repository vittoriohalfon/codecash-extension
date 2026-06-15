# codecash — get paid for waiting

codecash shows **one** tasteful sponsored ad in the wait states of your AI coding agent — the
Claude Code spinner verb and status line — and pays you a revenue share for it. No pop-ups, no
tracking of your code, no second ad anywhere.

> **This repository is the open client** — the exact code that runs on your machine, reads and
> writes your `~/.claude/settings.json`, and renders the ad. We publish it so you can audit what
> touches your editor. It talks to the hosted codecash service over HTTPS (see
> `codecash.apiBaseUrl`); the server-side ad auction, ledger, and payouts live in a separate
> repository and are not part of this package.

## Install & connect (one click)

1. Install the extension. A **Get paid for waiting** walkthrough opens automatically.
2. Click **Connect & start earning**. Your browser opens, you sign in, and the editor is linked
   and **turned on automatically** — no copy-paste, no command palette.
3. That's it. The `codecash` status-bar item shows today's earnings; the next time your agent
   "thinks", the spinner shows the ad.

Changed your mind? **codecash: Disable ad injection** restores your original settings exactly.

## How it works

- **The spinner verb is the ad.** codecash sets `spinnerVerbs` in `~/.claude/settings.json` so Claude
  Code renders the current ad as its "thinking" verb, and points `statusLine` at a small render-only
  script that prints the ad as a clickable terminal link.
- **Your settings are safe.** The original `~/.claude/settings.json` is backed up before any edit
  and restored exactly on disable/sign-out. Any pre-existing status line is preserved (stacked
  below the ad), every edit is reversible, and the render script never throws into your CLI.
- **You're paid for attention, not noise.** An ad only credits your account after it has been
  visibly on screen long enough — accrued view time, not a fire-and-forget impression.

## Commands

| Command | What it does |
|---|---|
| **codecash: Connect & start earning** | Link this editor and turn ads on (the one-click path). |
| **codecash: Enable / Disable ad injection** | Turn the ad on or off; disable restores your settings. |
| **codecash: Sign in with a token (paste)** | Manual fallback if the browser handoff can't round-trip. |
| **codecash: Show earnings** | Today's earnings and current state. |
| **codecash: Sign out** | Disconnect this editor and restore settings. |

## Settings

- **`codecash.apiBaseUrl`** — the codecash server this extension talks to. Leave blank to use the build
  default. Self-hosting or pointing at a staging server? Set it here (takes effect on the next ad
  fetch).

## Privacy

codecash never reads or transmits your code. It fetches an ad, renders it, and reports anonymous
view/credit events tied to a per-editor device token. See the project for details.

## Build from source

Requires Node 22 (`.nvmrc`) and pnpm.

```bash
pnpm install        # install deps
pnpm build          # bundle the host + render script with esbuild → dist/
pnpm test           # run the unit tests (vitest)
pnpm typecheck      # tsc --noEmit
pnpm run package    # build a .vsix you can install locally
```

Point the build at a server with `CODECASH_DEFAULT_API_BASE_URL=https://… pnpm build`, or set
`codecash.apiBaseUrl` at runtime.

`vendor/shared/` holds a small, vendored copy of the project's shared constants, zod schemas, and
pricing helpers (the non-secret subset). The source imports it as `@codecash/shared`, aliased to
`vendor/shared/` in `esbuild.mjs`, `tsconfig.json`, and `vitest.config.ts`.

## 📜 License

Proprietary and source-available — not open source. © 2026 codecash. All rights reserved.
You may read this code; you may not use, copy, modify, distribute, or commercialize it without a
written license. See [`LICENSE.txt`](./LICENSE.txt). Commercial inquiries: vittorio@justskim.ai.
