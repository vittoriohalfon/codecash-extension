/**
 * The opt-in gate for the experimental Codex ad surfaces (the `codex` panel bundle-patch + the
 * `codex-cli` PATH-shim banner). These deliberately cross codecash's "reach surfaces through config,
 * never by patching another extension's bundle / mutating a PATH binary" guardrail, so they are
 * **off by default** and never run unless explicitly turned on. Pure + injectable so the host's wiring
 * is unit-testable (handoff Phase C task #5: prove the gate is off by default).
 *
 * Two layers, BOTH required:
 *  - `buildEnabled` — a build-time master switch (esbuild `__BUILD_CODEX_SURFACES__`, default false).
 *    A published build ships with this false, so the code path is dormant for everyone regardless of
 *    settings — the ToS/brittleness risk can't be flipped on by a stray setting.
 *  - a per-user opt-in — a VS Code setting, an env var, or a marker file. Even when the build allows
 *    it, nothing Codex-injecting runs until the user opts in.
 */
export interface CodexGateInputs {
  /** baked build flag — the master switch; when false the gate is always closed. */
  buildEnabled: boolean;
  /** VS Code setting `codecash.codexSurfaces`. */
  settingEnabled?: boolean;
  /** runtime env `CODECASH_CODEX_SURFACES` (="1" to opt in). */
  envValue?: string | undefined;
  /** a `~/.codecash/codex.enabled` marker file exists. */
  optInFileExists?: boolean;
}

export function codexSurfacesEnabled(i: CodexGateInputs): boolean {
  if (!i.buildEnabled) return false; // master build kill — dormant unless the build opted in
  return i.settingEnabled === true || i.envValue === "1" || i.optInFileExists === true;
}
