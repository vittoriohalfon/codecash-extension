/**
 * `vscode:uninstall` hook — VS Code runs this as PLAIN node (`node ./dist/uninstall.mjs`; no `vscode`
 * API, no `globalState`) when the user uninstalls the extension, while `dist/` still exists. VS Code
 * has no in-process uninstall callback — `deactivate()` runs on every shutdown/disable, NOT on
 * uninstall — so this is the one deterministic moment to undo what we injected. Without it, an
 * uninstall strands our `statusLine` (now pointing at the about-to-be-deleted `dist/render.mjs`) and a
 * frozen spinner ad. (VS Code does NOT run this on an extension UPDATE, only a real uninstall — so
 * updating the extension never turns ads off.)
 *
 * The restore itself lives in `lib/restoreSurfaces.ts`, shared with the sunset build's `activate()`:
 * both undo the same two surfaces from the `~/.codecash` captures (globalState is unreadable here,
 * which is why we mirror it to disk), including the CLI-ownership carve-out for the terminal surface.
 *
 * Never throws; always exits 0 so a hiccup can't wedge the uninstall — and the originals also remain
 * in the `~/.codecash` backups for a manual restore.
 */
import { homedir } from "node:os";
import { restoreAllSurfaces } from "./lib/restoreSurfaces.js";

restoreAllSurfaces(homedir());
process.exit(0);
