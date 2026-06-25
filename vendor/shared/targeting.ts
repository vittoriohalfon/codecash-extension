import { z } from "zod";
import { CountryCodeSchema, normalizeCountry } from "./countries.js";

/**
 * Stack-aware ad targeting — the ONE shared module (docs/targeting-plan.md). The taxonomy, the
 * predicate, the match function, AND the dep→tag mapping rules all live here so the THREE consumers
 * stay provably consistent:
 *   - the client (apps/cli, apps/extension via @codecash/client-core) DERIVES tags locally from the
 *     workspace and sends ONLY those tags — never code — see client-core/lib/context.ts;
 *   - the serving API (apps/web) MATCHES a creative's predicate against the tags and ranks bid × score;
 *   - the advertiser portal renders the include/exclude knobs FROM this taxonomy.
 * Same single-source-of-truth pattern as pricing.ts / schemas.ts.
 *
 * Privacy invariant (the whole point): the vocabulary is a CLOSED, coarse allowlist. The client maps
 * raw signals (dependency names, file extensions) to these tags ON-DEVICE and transmits ONLY the
 * resulting tags — never raw dependency names, file contents, paths, identifiers, or anything typed.
 */

// ── taxonomy ─────────────────────────────────────────────────────────────────────────────────────

/** Closed, namespaced targeting vocabulary. Every derivable/servable tag must live here. */
export const TARGETING_TAXONOMY = {
  lang: [
    "typescript",
    "javascript",
    "python",
    "go",
    "rust",
    "java",
    "ruby",
    "php",
    "csharp",
    "cpp",
    "swift",
    "kotlin",
  ],
  fw: [
    "next",
    "react",
    "vue",
    "svelte",
    "angular",
    "express",
    "nest",
    "django",
    "flask",
    "fastapi",
    "rails",
    "spring",
    "laravel",
  ],
  db: ["postgres", "mysql", "mongodb", "redis", "supabase", "prisma", "sqlite", "dynamodb"],
  cloud: ["aws", "gcp", "azure", "vercel", "cloudflare", "netlify", "fly", "docker", "kubernetes", "terraform"],
  agent: ["claude-cli", "claude-code", "codex-cli", "codex"],
} as const;

export type TargetingNamespace = keyof typeof TARGETING_TAXONOMY;
export const TARGETING_NAMESPACES = Object.keys(TARGETING_TAXONOMY) as TargetingNamespace[];
const NAMESPACE_SET: ReadonlySet<string> = new Set(TARGETING_NAMESPACES);

/** The flat `ns:value` tag union, e.g. "fw:next" | "lang:python" | … — derived from the taxonomy. */
export type TargetingTag = {
  [NS in TargetingNamespace]: `${NS}:${(typeof TARGETING_TAXONOMY)[NS][number]}`;
}[TargetingNamespace];

/** Every valid tag as a runtime array, e.g. ["lang:typescript", …, "agent:codex"]. */
export const TARGETING_TAGS: readonly TargetingTag[] = TARGETING_NAMESPACES.flatMap((ns) =>
  (TARGETING_TAXONOMY[ns] as readonly string[]).map((v) => `${ns}:${v}` as TargetingTag),
);

const TAG_SET: ReadonlySet<string> = new Set<string>(TARGETING_TAGS);

export const TargetingTagSchema = z.enum(TARGETING_TAGS as [TargetingTag, ...TargetingTag[]]);

/** True iff `s` is an allowlisted tag. Untrusted input is checked against this — never trusted blindly. */
export function isTargetingTag(s: unknown): s is TargetingTag {
  return typeof s === "string" && TAG_SET.has(s);
}

/** The namespace of a tag (the segment before the first ":"), or null if it isn't a valid tag. */
export function tagNamespace(tag: string): TargetingNamespace | null {
  if (!isTargetingTag(tag)) return null;
  return tag.slice(0, tag.indexOf(":")) as TargetingNamespace;
}

// ── what the client sends ──────────────────────────────────────────────────────────────────────

/** Hard cap on tags per request — bounds the payload and a (tiny) re-identification surface. */
export const MAX_DEVICE_TAGS = 24;

/**
 * Coerce arbitrary input into a clean, bounded, deduped tag list: drop anything off-taxonomy (NEVER
 * trusted), dedupe, cap at MAX_DEVICE_TAGS. Lenient by design — a newer client may send a tag an
 * older server doesn't know, and one junk tag must not 400 the whole ad request. Returns [] for
 * non-arrays. This is the ingestion gate on the serving side.
 */
export function sanitizeTags(input: unknown): TargetingTag[] {
  if (!Array.isArray(input)) return [];
  const out: TargetingTag[] = [];
  const seen = new Set<string>();
  for (const v of input) {
    if (isTargetingTag(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
      if (out.length >= MAX_DEVICE_TAGS) break;
    }
  }
  return out;
}

/**
 * The body the client POSTs to /api/ads/next. `tags` is sanitized to the allowlist (off-taxonomy
 * dropped, deduped, capped), so a malformed or stale client can never inject untrusted segments.
 */
export const DeviceContextSchema = z.object({
  tags: z.preprocess(sanitizeTags, z.array(TargetingTagSchema)),
});
export type DeviceContext = z.infer<typeof DeviceContextSchema>;

// ── advertiser-side predicate + matching ─────────────────────────────────────────────────────────

/**
 * A creative's targeting predicate (stored on creatives.targeting). `include` is a SOFT relevance
 * boost (ranks a match above an untargeted ad at equal bid); `exclude` is a HARD filter (never serve
 * to a device carrying an excluded tag). Empty {} = untargeted, matches everyone at the baseline.
 * Keys are namespaces; values are full `ns:tag` strings (e.g. include.fw = ["fw:next"]).
 *
 * `countries` is a separate, orthogonal GEO dimension: an allowlist of ISO alpha-2 codes the creative
 * may serve in. Unlike the stack tags (client-derived, privacy-gated, SOFT include), country is
 * RESOLVED SERVER-SIDE from the request and is a HARD filter — a non-empty list serves ONLY to a
 * viewer in one of those countries; empty/absent = worldwide. It does NOT participate in matchScore
 * (it's a gate, not a relevance weight) and is enforced by `matchesGeo` + the SQL eligibility filter.
 */
export type TargetingPredicate = {
  include?: Record<string, TargetingTag[]>;
  exclude?: Record<string, TargetingTag[]>;
  countries?: string[];
};

/**
 * Namespace→tags map with a coherence check (the fail-closed write guard, Codex C1/C9): every key must
 * be a real namespace AND every tag under it must belong to that namespace, else validation fails with
 * a readable message. So `include.db: ["lang:python"]` (a valid tag filed under the wrong namespace) is
 * rejected on write rather than silently stored as incoherent, gameable targeting.
 */
const NamespaceTagMap = z
  .record(z.string(), z.array(TargetingTagSchema))
  .superRefine((map, ctx) => {
    for (const [ns, tags] of Object.entries(map)) {
      if (!NAMESPACE_SET.has(ns)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown targeting namespace "${ns}"`, path: [ns] });
        continue;
      }
      for (const t of tags) {
        if (tagNamespace(t) !== ns) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `tag "${t}" does not belong to namespace "${ns}"`,
            path: [ns],
          });
        }
      }
    }
  });
/**
 * Country allowlist field. Preprocessed to UPPERCASE + deduped before validation so an advertiser can
 * pass "il" / "IL" interchangeably; each code is then checked against the closed country allowlist
 * (CountryCodeSchema), so an off-list code fails the write (fail-closed) rather than being stored as a
 * geo nobody can ever match. An empty array is dropped to `undefined` so a "select none" is stored as
 * untargeted (worldwide), keeping `{}` the canonical untargeted predicate.
 */
const CountryListSchema = z.preprocess(
  (v) =>
    Array.isArray(v)
      ? Array.from(new Set(v.map((c) => (typeof c === "string" ? c.trim().toUpperCase() : c))))
      : v,
  z.array(CountryCodeSchema).transform((arr) => (arr.length > 0 ? arr : undefined)),
);

export const TargetingPredicateSchema = z
  .object({
    include: NamespaceTagMap.optional(),
    exclude: NamespaceTagMap.optional(),
    countries: CountryListSchema.optional(),
  })
  .strict();

/**
 * Parse a stored/untrusted predicate (creatives.targeting is `Json`) into a safe shape. Returns an
 * empty (untargeted) predicate on anything invalid — the serving path must NEVER throw on a malformed
 * predicate; a bad row simply behaves as untargeted rather than taking down the auction.
 */
export function parsePredicate(input: unknown): TargetingPredicate {
  const parsed = TargetingPredicateSchema.safeParse(input ?? {});
  return parsed.success ? parsed.data : {};
}

export type PredicateValidation =
  | { ok: true; value: TargetingPredicate }
  | { ok: false; errors: string[] };

/**
 * WRITE path (fail-CLOSED). Validate an advertiser-supplied predicate, returning the parsed predicate
 * or human-readable errors — the caller MUST reject the write on `ok:false` rather than persist
 * incoherent targeting. We never silently coerce a bad predicate to "matches everyone": spending an
 * advertiser's budget on an audience they didn't choose is a money-correctness bug. (The advertiser
 * bid/admin schemas embed TargetingPredicateSchema, so their writes are already fail-closed; this is
 * the same guarantee as a standalone helper for any other write path.)
 */
export function validatePredicate(input: unknown): PredicateValidation {
  const parsed = TargetingPredicateSchema.safeParse(input ?? {});
  if (parsed.success) return { ok: true, value: parsed.data as TargetingPredicate };
  return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
}

/**
 * Is a predicate actually targeting anyone — i.e. does it carry at least one non-empty `include` OR
 * `exclude` namespace? An empty/absent predicate (`{}`, `{ include: {} }`) is "untargeted, matches
 * everyone." Used to gate the targeted bid floor (MIN_BID_USD_TARGETED) and the form's "you're
 * targeting" UI. Treats any non-empty predicate (include-boost OR exclude-filter) as targeted.
 */
export function isTargetedPredicate(predicate: TargetingPredicate | null | undefined): boolean {
  const hasTags = (m: Record<string, TargetingTag[]> | undefined): boolean =>
    !!m && Object.values(m).some((tags) => (tags?.length ?? 0) > 0);
  return hasTags(predicate?.include) || hasTags(predicate?.exclude);
}

/** Baseline match score for an untargeted (or non-matching) creative — servable, but loses to a real match. */
export const MATCH_BASELINE = 0.5;

/**
 * Relevance score in [0, 1] for a creative's predicate against a device's tags:
 *   - 0  if ANY exclude tag is present (hard filter — drop it).
 *   - baseline (0.5) if there's no include predicate (untargeted matches everyone).
 *   - else baseline + (1-baseline) × (fraction of include NAMESPACES satisfied) — so a 3-of-3 match
 *     (→ 1.0) outranks a 1-of-3 match, and a targeted-but-irrelevant creative falls back to baseline
 *     (stays servable so fill never drops; only `exclude` truly removes inventory).
 * Pure + deterministic. The single tunable knob is `baseline`.
 */
export function matchScore(
  predicate: TargetingPredicate | null | undefined,
  deviceTags: readonly string[],
  baseline: number = MATCH_BASELINE,
): number {
  const tags = new Set(deviceTags);

  const exclude = predicate?.exclude;
  if (exclude) {
    for (const ns of Object.keys(exclude)) {
      for (const t of exclude[ns] ?? []) {
        if (tags.has(t)) return 0;
      }
    }
  }

  const include = predicate?.include;
  const includeNamespaces = include
    ? Object.keys(include).filter((ns) => (include[ns]?.length ?? 0) > 0)
    : [];
  if (includeNamespaces.length === 0) return baseline;

  let satisfied = 0;
  for (const ns of includeNamespaces) {
    if ((include![ns] ?? []).some((t) => tags.has(t))) satisfied++;
  }
  const fraction = satisfied / includeNamespaces.length;
  return baseline + (1 - baseline) * fraction;
}

// ── geo (country) hard filter ─────────────────────────────────────────────────────────────────────

/**
 * HARD geo gate, separate from the tag relevance score. Returns whether a creative is SERVABLE to a
 * viewer in `viewerCountry` (a normalized ISO alpha-2, or null when the request's country can't be
 * resolved):
 *   - no country restriction (empty/absent `countries`) → true (worldwide, matches everyone);
 *   - restricted → true ONLY if `viewerCountry` is one of the listed countries.
 * Fail-CLOSED: an UNKNOWN viewer country (null) NEVER matches a geo-restricted creative, so a
 * country-targeted ad can never leak outside its target when we can't prove the viewer's location —
 * the advertiser paid to reach Israel, so an unknown viewer is not Israel. Pure + deterministic;
 * comparison is case-insensitive on the listed codes (stored uppercase, but normalized here anyway).
 */
export function matchesGeo(
  predicate: TargetingPredicate | null | undefined,
  viewerCountry: string | null | undefined,
): boolean {
  const countries = predicate?.countries;
  if (!countries || countries.length === 0) return true; // untargeted geo → everyone
  const viewer = normalizeCountry(viewerCountry ?? null);
  if (!viewer) return false; // restricted, but we can't prove the viewer's country → fail closed
  return countries.some((c) => c.toUpperCase() === viewer);
}

// ── dep / file → tag mapping (the curated allowlist the client derives from) ──────────────────────
// These rules are the ONLY knowledge of "this raw signal means this tag". They live here (not in the
// client) so they're unit-tested once and shared. Start coarse; expand from advertiser demand.

interface DepRule {
  /** Exact dependency name, or a regex for scoped/prefixed families (e.g. /^@supabase\//). */
  match: string | RegExp;
  tag: TargetingTag;
}

/** node (package.json) dependency → tag. */
export const NODE_DEP_RULES: readonly DepRule[] = [
  { match: "next", tag: "fw:next" },
  { match: "react", tag: "fw:react" },
  { match: "react-dom", tag: "fw:react" },
  { match: "vue", tag: "fw:vue" },
  { match: "svelte", tag: "fw:svelte" },
  { match: "@sveltejs/kit", tag: "fw:svelte" },
  { match: "@angular/core", tag: "fw:angular" },
  { match: "express", tag: "fw:express" },
  { match: "@nestjs/core", tag: "fw:nest" },
  { match: "pg", tag: "db:postgres" },
  { match: "postgres", tag: "db:postgres" },
  { match: "mysql", tag: "db:mysql" },
  { match: "mysql2", tag: "db:mysql" },
  { match: "mongodb", tag: "db:mongodb" },
  { match: "mongoose", tag: "db:mongodb" },
  { match: "redis", tag: "db:redis" },
  { match: "ioredis", tag: "db:redis" },
  { match: /^@supabase\//, tag: "db:supabase" },
  { match: "@prisma/client", tag: "db:prisma" },
  { match: "prisma", tag: "db:prisma" },
  { match: "better-sqlite3", tag: "db:sqlite" },
  { match: /^@aws-sdk\/client-dynamodb/, tag: "db:dynamodb" },
  { match: /^@aws-sdk\//, tag: "cloud:aws" },
  { match: "aws-sdk", tag: "cloud:aws" },
  { match: /^@google-cloud\//, tag: "cloud:gcp" },
  { match: /^@azure\//, tag: "cloud:azure" },
  { match: "@vercel/node", tag: "cloud:vercel" },
  { match: /^@cloudflare\//, tag: "cloud:cloudflare" },
  { match: "wrangler", tag: "cloud:cloudflare" },
];

/** python (requirements.txt / pyproject.toml) dependency → tag. */
export const PYTHON_DEP_RULES: readonly DepRule[] = [
  { match: "django", tag: "fw:django" },
  { match: "flask", tag: "fw:flask" },
  { match: "fastapi", tag: "fw:fastapi" },
  { match: "psycopg2", tag: "db:postgres" },
  { match: "psycopg2-binary", tag: "db:postgres" },
  { match: "psycopg", tag: "db:postgres" },
  { match: "pymysql", tag: "db:mysql" },
  { match: "pymongo", tag: "db:mongodb" },
  { match: "redis", tag: "db:redis" },
  { match: "boto3", tag: "cloud:aws" },
];

/** A manifest/lockfile filename (lowercased) → a tag it directly implies. */
export const MANIFEST_FILE_RULES: ReadonlyArray<{ match: string | RegExp; tag: TargetingTag }> = [
  { match: "go.mod", tag: "lang:go" },
  { match: "cargo.toml", tag: "lang:rust" },
  { match: "gemfile", tag: "lang:ruby" },
  { match: "requirements.txt", tag: "lang:python" },
  { match: "pyproject.toml", tag: "lang:python" },
  { match: "composer.json", tag: "lang:php" },
  { match: "pom.xml", tag: "lang:java" },
  { match: "build.gradle", tag: "lang:java" },
  { match: "dockerfile", tag: "cloud:docker" },
  { match: /\.tf$/, tag: "cloud:terraform" },
];

/** A source-file extension (with leading dot, lowercased) → its language tag, for the histogram. */
export const EXTENSION_LANG: Readonly<Record<string, TargetingTag>> = {
  ".ts": "lang:typescript",
  ".tsx": "lang:typescript",
  ".js": "lang:javascript",
  ".jsx": "lang:javascript",
  ".mjs": "lang:javascript",
  ".cjs": "lang:javascript",
  ".py": "lang:python",
  ".go": "lang:go",
  ".rs": "lang:rust",
  ".java": "lang:java",
  ".rb": "lang:ruby",
  ".php": "lang:php",
  ".cs": "lang:csharp",
  ".cpp": "lang:cpp",
  ".cc": "lang:cpp",
  ".hpp": "lang:cpp",
  ".swift": "lang:swift",
  ".kt": "lang:kotlin",
};

function applyDepRules(rules: readonly DepRule[], dep: string): TargetingTag | null {
  const name = dep.trim().toLowerCase();
  if (!name) return null;
  for (const r of rules) {
    if (typeof r.match === "string" ? r.match === name : r.match.test(name)) return r.tag;
  }
  return null;
}

/** Map a single node dependency name to a tag (or null). Never throws. */
export function nodeDepTag(dep: string): TargetingTag | null {
  return applyDepRules(NODE_DEP_RULES, dep);
}

/** Map a single python dependency name to a tag (or null). Never throws. */
export function pythonDepTag(dep: string): TargetingTag | null {
  return applyDepRules(PYTHON_DEP_RULES, dep);
}

/** Map a manifest filename (any case) to the tag it implies (or null). Never throws. */
export function manifestFileTag(filename: string): TargetingTag | null {
  const name = filename.trim().toLowerCase();
  if (!name) return null;
  for (const r of MANIFEST_FILE_RULES) {
    if (typeof r.match === "string" ? r.match === name : r.match.test(name)) return r.tag;
  }
  return null;
}

/** Map a source-file extension (with or without leading dot, any case) to a language tag (or null). */
export function extensionLangTag(ext: string): TargetingTag | null {
  const e = ext.trim().toLowerCase();
  const key = e.startsWith(".") ? e : `.${e}`;
  return EXTENSION_LANG[key] ?? null;
}
