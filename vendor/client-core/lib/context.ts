import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, extname } from "node:path";
import {
  sanitizeTags,
  nodeDepTag,
  pythonDepTag,
  manifestFileTag,
  extensionLangTag,
  type TargetingTag,
} from "@codecash/shared";

/**
 * Derive the coarse, allowlisted stack tags for a workspace — the ONLY thing the opt-in "relevant ads"
 * path sends to the server (docs/targeting-plan.md Layer 3). It reads a handful of manifest files plus a
 * CAPPED file-extension histogram, maps them to tags via the shared allowlist (so a tag is emitted ONLY
 * if it's in TARGETING_TAXONOMY), and transmits NOTHING ELSE — never raw dependency names, file contents
 * beyond manifest keys, paths, repo names, or identifiers.
 *
 * Prime directive (CLAUDE.md): read-only, bounded by a hard file-count cap AND a wall-clock budget,
 * skips heavy/vendored dirs, NEVER throws (returns [] on anything unexpected), cached per workspace.
 * It does NO network I/O — the consent gate and the decision to send these tags live one level up in
 * the host (Layer 6); this is pure local derivation.
 */

/** Hard cap on files visited by the language histogram — bounds cost on a huge monorepo. */
const MAX_SCAN_FILES = 4000;
/** Wall-clock budget for the histogram walk; we bail gracefully (return what we have) past it. */
const SCAN_BUDGET_MS = 250;
/** Skip a manifest larger than this — a generated/huge file isn't worth reading for coarse tags. */
const MAX_MANIFEST_BYTES = 512 * 1024;

/** Directories never worth walking for a language histogram (vendored, build output, VCS). */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".turbo",
  "target", "vendor", ".venv", "venv", "__pycache__", "coverage", ".cache", "tmp", ".idea", ".vscode",
]);

export interface DeriveOptions {
  /** Adapter id → an `agent:*` tag (e.g. "claude-cli" → "agent:claude-cli"). Dropped if off-taxonomy. */
  adapter?: string;
  /** Bypass the per-workspace cache (default false). */
  force?: boolean;
  /** Override the wall-clock budget for the histogram walk, in ms. */
  budgetMs?: number;
}

/** Per-workspace cache — a workspace's stack rarely changes mid-session; pass `force` to re-derive. */
const cache = new Map<string, TargetingTag[]>();

/**
 * Derive the device's coarse stack tags. Safe to call on the hot path: bounded, cached, never throws.
 * Returns a clean, deduped, capped, allowlist-only tag list (possibly empty).
 */
export function deriveDeviceTags(
  workspaceRoot: string | null | undefined,
  opts: DeriveOptions = {},
): TargetingTag[] {
  const adapterTag = opts.adapter ? (`agent:${opts.adapter}` as TargetingTag) : null;
  try {
    if (!workspaceRoot) return finalize([], adapterTag);
    const cacheKey = `${workspaceRoot}|${opts.adapter ?? ""}`;
    if (!opts.force) {
      const hit = cache.get(cacheKey);
      if (hit) return hit;
    }

    let isDir = false;
    try {
      isDir = statSync(workspaceRoot).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return finalize([], adapterTag);

    const deadline = Date.now() + (opts.budgetMs ?? SCAN_BUDGET_MS);
    const raw: TargetingTag[] = [
      ...scanFsTags(workspaceRoot, deadline),
      ...nodeDepTags(workspaceRoot),
      ...pythonDepTags(workspaceRoot),
    ];
    const result = finalize(raw, adapterTag);
    cache.set(cacheKey, result);
    return result;
  } catch {
    return finalize([], adapterTag); // prime directive: never throw
  }
}

/** Clear the per-workspace derivation cache (tests / an explicit re-scan). */
export function clearDeriveCache(): void {
  cache.clear();
}

function finalize(tags: TargetingTag[], adapterTag: TargetingTag | null): TargetingTag[] {
  // sanitizeTags dedupes, drops anything off-taxonomy (incl. an unknown adapter), and caps the count.
  return sanitizeTags(adapterTag ? [...tags, adapterTag] : tags);
}

function readManifestText(file: string): string | null {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** package.json dependency NAMES (keys only — never values/contents) → tags via the shared allowlist. */
function nodeDepTags(root: string): TargetingTag[] {
  const text = readManifestText(join(root, "package.json"));
  if (!text) return [];
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const deps = {
    ...(pkg.dependencies as Record<string, unknown> | undefined),
    ...(pkg.devDependencies as Record<string, unknown> | undefined),
    ...(pkg.peerDependencies as Record<string, unknown> | undefined),
    ...(pkg.optionalDependencies as Record<string, unknown> | undefined),
  };
  const out: TargetingTag[] = [];
  for (const name of Object.keys(deps)) {
    const t = nodeDepTag(name);
    if (t) out.push(t);
  }
  return out;
}

/**
 * python dependency tags. Tokenize requirements.txt / pyproject.toml on non-name chars and map each
 * token through the allowlist — a non-allowlisted token maps to null and is ignored, so we only ever
 * emit a known tag (and never transmit the raw token). Robust to either file format without a TOML dep.
 */
function pythonDepTags(root: string): TargetingTag[] {
  const out: TargetingTag[] = [];
  for (const f of ["requirements.txt", "pyproject.toml"]) {
    const text = readManifestText(join(root, f));
    if (!text) continue;
    for (const token of text.split(/[^A-Za-z0-9_.-]+/)) {
      const t = pythonDepTag(token);
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * One bounded, read-only walk yielding BOTH (a) the dominant language(s) from a file-extension
 * histogram — the top language plus any other within 50% of it (a polyglot repo legitimately has two
 * primaries, e.g. ts + py) — AND (b) any manifest-implied tags found ANYWHERE in the tree (go.mod,
 * Dockerfile, *.tf, Gemfile, …), since those are commonly NESTED (e.g. infra/*.tf) and a root-only
 * check would miss them. Coarse by design (a count + a presence set, never a file list). Iterative,
 * skips vendored/build/VCS dirs and dotfolders, doesn't follow symlinks (Dirent.isDirectory() is false
 * for them → no cycles), and stops at the file cap or wall-clock budget.
 */
function scanFsTags(root: string, deadline: number): TargetingTag[] {
  const langCounts = new Map<TargetingTag, number>();
  const manifestTags = new Set<TargetingTag>();
  let scanned = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (scanned >= MAX_SCAN_FILES || Date.now() > deadline) break;
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (scanned >= MAX_SCAN_FILES || Date.now() > deadline) break;
      const name = e.name;
      if (e.isDirectory()) {
        if (!name.startsWith(".") && !SKIP_DIRS.has(name.toLowerCase())) stack.push(join(dir, name));
      } else if (e.isFile()) {
        scanned++;
        const m = manifestFileTag(name);
        if (m) manifestTags.add(m);
        const tag = extensionLangTag(extname(name));
        if (tag) langCounts.set(tag, (langCounts.get(tag) ?? 0) + 1);
      }
    }
  }
  const out: TargetingTag[] = [...manifestTags];
  if (langCounts.size > 0) {
    const sorted = [...langCounts.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted[0]![1];
    for (const [t, n] of sorted) if (n >= top * 0.5) out.push(t);
  }
  return out;
}
