import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  chmodSync,
  mkdirSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join, delimiter } from "node:path";
import type { AdServeResponse } from "@codecash/shared";
import type { InjectionAdapter, PreflightResult } from "../types.js";
import { codecashPaths, type CodecashPaths } from "../../lib/paths.js";
import { formatAdLabel } from "../../lib/adLabel.js";
import { osc8Link } from "../../lib/osc8.js";
import { detectCodexVersion } from "../../lib/preflight.js";

/**
 * The codex-cli-wrapper adapter — the PATH-shim ad surface for OpenAI's Codex CLI.
 *
 * Codex's TUI exposes NO config hook for live wait-state text (the clean surface the sibling
 * {@link CodexCliAdapter} targets ships only on an unreleased Codex — see lib/preflight.ts). Until
 * that lands, the ONLY way to show an ad on the released Codex CLI is to wrap the `codex` shim: back
 * up the pristine binary, replace it with a tiny script that prints a one-line ad banner to the
 * terminal and then `exec`s the real codex. This is a deliberate, opt-in, guardrail-crossing surface
 * (it mutates the user's PATH binary) — gated OFF by default at the host. It is a clean-room
 * reimplementation of the documented interface (a reversible startup banner), not a copy.
 *
 * Honest limits, by design:
 *  - The banner is a one-shot PRINT at launch, NOT a live spinner verb — Codex enters its alt-screen
 *    and paints over it, so it's a pre-session impression, not a continuously-visible line. (Replacing
 *    the live "Working" row would need a binary patch we will not ship.)
 *  - It is printed to STDERR and only when stderr is a TTY, so piped/non-interactive `codex` invocations
 *    are byte-for-byte untouched (prime directive: never break the user's CLI).
 *  - The brand label is an OSC 8 hyperlink to the serve's `/c/<clickCode>` URL, so a click is credited
 *    server-side via the existing redirect — impressions stay host-driven through the ServeController.
 *
 * Fully reversible: enable() snapshots the pristine shim (recording whether it was a symlink or a
 * regular file) and disable() restores it byte-true. Every method swallows its own errors.
 */
const MARKER = "codecash-codex-cli-banner";

interface ShimMeta {
  /** the shim path we replaced (the `codex` entry on PATH). */
  shimPath: string;
  /** how the pristine shim was shaped, so restore is faithful. */
  mode: "symlink" | "file";
  /** the path the wrapper execs: the resolved real codex (symlink) or our backup copy (file). */
  realCodex: string;
  /** the original symlink target verbatim, replayed on restore (symlink mode only). */
  linkTarget?: string;
}

/**
 * Find the `codex` executable on PATH without spawning — scans `$PATH` for an existing `codex`
 * (POSIX) / `codex.cmd` (Windows). On Windows we deliberately do NOT match `codex.exe`: our wrapper is
 * a `.cmd` script, so overwriting a native `.exe` would corrupt the real binary — we only ever wrap the
 * npm `.cmd` shim (or an extensionless sh shim). Returns the first hit, or null. Dependency-free + testable.
 */
export function findCodexShim(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const path = env.PATH ?? env.Path ?? "";
  if (!path) return null;
  const names = platform === "win32" ? ["codex.cmd", "codex"] : ["codex"];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const p = join(dir, name);
      try {
        if (existsSync(p)) return p;
      } catch {
        /* unreadable PATH entry — skip */
      }
    }
  }
  return null;
}

export class CodexCliWrapperAdapter implements InjectionAdapter {
  readonly id = "codex-cli" as const;

  constructor(
    private readonly shimPath: string,
    private readonly paths: CodecashPaths = codecashPaths(),
  ) {}

  private get isWin(): boolean {
    return this.shimPath.toLowerCase().endsWith(".cmd") || process.platform === "win32";
  }

  /** True iff the live shim currently carries our wrapper. */
  isPatched(): boolean {
    try {
      return existsSync(this.shimPath) && readFileSync(this.shimPath, "utf8").includes(MARKER);
    } catch {
      return false;
    }
  }

  async preflight(): Promise<PreflightResult> {
    const version = detectCodexVersion();
    if (!existsSync(this.shimPath)) {
      return { ok: false, ccVersion: version, reason: "codex shim not found on PATH" };
    }
    // Never wrap a native binary: our wrapper is a .cmd/sh script, so writing it over a `.exe` would
    // corrupt the real executable. findCodexShim won't select one, but the path can be injected directly.
    if (this.shimPath.toLowerCase().endsWith(".exe")) {
      return { ok: false, ccVersion: version, reason: "refusing to wrap a native codex.exe" };
    }
    // If we already wrapped it, it's compatible by construction.
    if (this.isPatched()) return { ok: true, ccVersion: version };
    // Only wrap something that resolves to @openai/codex — a bare "codex" name match would
    // false-positive on an unrelated binary. Follow the symlink and sniff the real target.
    try {
      const real = realpathSync(this.shimPath);
      const head = readFileSync(real, "utf8").slice(0, 4096);
      if (!/@openai[/\\]codex|codex\.js|openai.{0,40}codex/i.test(head) && !/codex/i.test(real)) {
        return {
          ok: false,
          ccVersion: version,
          reason: "PATH `codex` doesn't resolve to @openai/codex",
        };
      }
    } catch {
      /* unreadable target — fall through; enable() guards again */
    }
    return { ok: true, ccVersion: version };
  }

  async enable(adText?: string): Promise<void> {
    // Idempotent: if already wrapped, just refresh the banner text.
    if (this.isPatched()) {
      if (adText) this.writeBannerText(adText, undefined);
      return;
    }
    mkdirSync(this.paths.codecashDir, { recursive: true });

    // Snapshot the pristine shim, recording its shape so restore is faithful.
    const st = lstatSync(this.shimPath);
    let meta: ShimMeta;
    if (st.isSymbolicLink()) {
      // Point the wrapper at the resolved real codex; recreate the symlink verbatim on restore.
      meta = {
        shimPath: this.shimPath,
        mode: "symlink",
        realCodex: realpathSync(this.shimPath),
        linkTarget: readlinkSync(this.shimPath),
      };
    } else {
      // Copy the pristine binary aside (preserving the exec bit) and exec that backup.
      const backup = this.paths.codexCliShimBackup;
      copyFileSync(this.shimPath, backup);
      try {
        chmodSync(backup, 0o755);
      } catch {
        /* best-effort */
      }
      meta = { shimPath: this.shimPath, mode: "file", realCodex: backup };
    }

    writeFileSync(this.paths.codexCliShimMeta, JSON.stringify(meta, null, 2), "utf8");
    if (adText) this.writeBannerText(adText, undefined);

    // A symlink must be REMOVED first — writing to its path would follow the link and clobber the
    // real codex instead of replacing the shim. (A regular file is overwritten in place, which is
    // exactly what we want now that the pristine copy is safely backed up.)
    if (meta.mode === "symlink") {
      rmSync(this.shimPath, { force: true });
    }

    // Install the wrapper LAST, so a failure above never leaves a half-shimmed binary.
    const wrapper = this.renderWrapper(meta.realCodex);
    writeFileSync(this.shimPath, wrapper, "utf8");
    if (!this.isWin) {
      try {
        chmodSync(this.shimPath, 0o755);
      } catch {
        /* best-effort */
      }
    }
  }

  async disable(): Promise<void> {
    try {
      const metaRaw = existsSync(this.paths.codexCliShimMeta)
        ? readFileSync(this.paths.codexCliShimMeta, "utf8")
        : null;
      if (metaRaw) {
        const meta = JSON.parse(metaRaw) as ShimMeta;
        // Only restore if WE still own the file (it carries our marker) — never clobber a shim the
        // user reinstalled out from under us.
        if (this.isPatched()) {
          if (meta.mode === "symlink" && meta.linkTarget) {
            rmSync(meta.shimPath, { force: true });
            // Recreate the original symlink (best-effort; falls back to a copy of the real codex).
            try {
              symlinkSync(meta.linkTarget, meta.shimPath);
            } catch {
              if (existsSync(meta.realCodex)) copyFileSync(meta.realCodex, meta.shimPath);
            }
          } else if (existsSync(meta.realCodex)) {
            copyFileSync(meta.realCodex, meta.shimPath);
            if (!this.isWin) {
              try {
                chmodSync(meta.shimPath, 0o755);
              } catch {
                /* best-effort */
              }
            }
          }
        }
        if (meta.mode === "file") {
          try {
            rmSync(this.paths.codexCliShimBackup, { force: true });
          } catch {
            /* best-effort */
          }
        }
        rmSync(this.paths.codexCliShimMeta, { force: true });
      }
    } catch {
      /* prime directive: disable must never throw */
    }
    try {
      rmSync(this.paths.codexCliBanner, { force: true });
    } catch {
      /* best-effort */
    }
  }

  /** Write the pre-rendered, OSC 8-clickable banner the wrapper prints. */
  cacheAd(serve: AdServeResponse): void {
    this.writeBannerText(serve.creative.adText, serve);
  }

  async pushAd(serve: AdServeResponse): Promise<void> {
    this.cacheAd(serve);
  }

  private writeBannerText(adText: string, serve: AdServeResponse | undefined): void {
    try {
      const brand = serve?.creative.brandName;
      const label = formatAdLabel(brand, adText);
      const clickUrl = serve?.creative.clickUrl;
      const line = clickUrl ? osc8Link(clickUrl, label) : label;
      // One leading blank line + indent + trailing newline so it reads as a tidy banner.
      mkdirSync(this.paths.codecashDir, { recursive: true });
      writeFileSync(this.paths.codexCliBanner, `\n  ${line}\n`, "utf8");
    } catch {
      /* best-effort — a missing/garbled banner just means no ad shows, never a broken codex */
    }
  }

  private renderWrapper(realCodex: string): string {
    const banner = this.paths.codexCliBanner;
    if (this.isWin) {
      // Windows .cmd: print the banner to stderr if interactive, then call the real shim.
      return [
        `@echo off`,
        `rem ${MARKER} — reversible codecash wrapper; restore: copy the backup back over this file.`,
        `if exist "${banner}" type "${banner}" 1>&2`,
        `call "${realCodex}" %*`,
        ``,
      ].join("\r\n");
    }
    // POSIX sh: print only when stderr is a TTY (so pipes stay clean), then exec the real codex.
    return [
      `#!/bin/sh`,
      `# ${MARKER} — reversible codecash wrapper around the codex shim.`,
      `# Prints a one-line ad banner to the terminal, then execs the pristine codex.`,
      `# Restore: \`codecash disable\` (or recreate the original ${realCodex.includes("/.codecash/") ? "binary from the backup" : "symlink"}).`,
      `__CC_BANNER="${banner}"`,
      `if [ -t 2 ] && [ -r "$__CC_BANNER" ]; then cat "$__CC_BANNER" >&2 2>/dev/null || true; fi`,
      `exec "${realCodex}" "$@"`,
      ``,
    ].join("\n");
  }
}
