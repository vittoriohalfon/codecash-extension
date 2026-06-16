/**
 * The extension's status-line render entry — esbuild bundles this to a ZERO-dependency `dist/render.mjs`
 * that `~/.claude/settings.json` `statusLine` points at. It just reads the local ad cache and prints
 * the clickable ad line; the display logic + the shared `workspaceKey` are pulled from
 * `@codecash/client-core/render` and INLINED by esbuild (so the bundle stays dependency-free).
 *
 * PRIME DIRECTIVE: never break the user's CLI. Everything is wrapped so it always exits 0, prints
 * nothing on any failure, and never phones home (it only reads files under ~/.codecash).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { renderStatusLine, readStatusLineStdin } from "@codecash/client-core/render";

// `.codecash` is mirrored as a literal (not imported from @codecash/shared) so esbuild never pulls
// the rest of shared — incl. its `jose` signing dep — into this zero-dependency bundle.
const CODECASH_DIR = ".codecash";

try {
  const out = renderStatusLine({
    codecashDir: join(homedir(), CODECASH_DIR),
    stdin: readStatusLineStdin(),
    now: Date.now(),
  });
  if (out) process.stdout.write(out + "\n");
} catch {
  // swallow — never break the CLI
}
