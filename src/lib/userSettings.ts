import { dirname, join, basename } from "node:path";
import { modify, applyEdits, type FormattingOptions } from "jsonc-parser";
import { readTextFileTolerant, writeFileAtomic } from "@codecash/client-core";

/**
 * vscode-free helpers for editing the editor's USER settings.json (a JSONC file). Kept out of the
 * host shell so the comment-preserving edit — the part that could corrupt a user's settings if wrong
 * — is unit-tested. The Claude Code panel reads its spinner verbs from `claudeCode.spinnerVerbs` here,
 * and this key is NOT registered with VS Code (it lives in Claude's settings schema), so the config
 * API's `update()` rejects it (ERROR_UNKNOWN_KEY). A direct JSONC file edit is the supported path:
 * VS Code watches settings.json and fires `onDidChangeConfiguration` after the edit, repainting the
 * panel.
 */

const FORMATTING: FormattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" };

/**
 * Set (or delete, when `value === undefined`) a top-level dotted key in a JSONC document, preserving
 * the user's comments and existing formatting via jsonc-parser `modify`/`applyEdits` (the same
 * mechanism VS Code uses internally). An empty/whitespace document is treated as `{}`.
 */
export function setTopLevelKey(text: string, key: string, value: unknown): string {
  const src = text.trim() === "" ? "{}\n" : text;
  return applyEdits(src, modify(src, [key], value, { formattingOptions: FORMATTING }));
}

/**
 * Resolve the running editor's USER settings.json from the extension's globalStorage path.
 * `globalStorageUri` is `<userDir>/User/globalStorage/<extId>`, so the user settings file is two
 * directories up. Editor- and platform-agnostic (Code / Insiders / Cursor / Windsurf, all OSes),
 * unlike hardcoding `~/Library/Application Support/Code/...`. Returns null when the layout isn't the
 * expected `…/globalStorage/<extId>` (some remote hosts), so the caller can skip rather than guess.
 */
export function resolveUserSettingsPath(globalStoragePath: string): string | null {
  if (basename(dirname(globalStoragePath)).toLowerCase() !== "globalstorage") return null;
  return join(dirname(dirname(globalStoragePath)), "settings.json");
}

/**
 * Atomically set/delete a top-level key in a JSONC settings file. Treats a missing file as empty and
 * tolerates a BOM / non-UTF-8 user settings.json (decoded leniently rather than rejected as "binary",
 * which was aborting `enable` on the panel path — docs/BUG-settings-json-atomic-write.md). The write
 * goes through the hardened {@link writeFileAtomic} (unique temp name, Windows-lock retry, orphan
 * cleanup). Never reflows or strips comments from the rest of the file.
 */
export function writeUserSettingFile(path: string, key: string, value: unknown): void {
  const text = readTextFileTolerant(path) ?? "";
  const next = setTopLevelKey(text, key, value);
  writeFileAtomic(path, next);
}
