import type { Adapter, ClientEvent, ClientEventBatch, ClientSignalType } from "@codecash/shared";

/**
 * The ANONYMOUS, pre-auth client reporter (CLAUDE.md "Observability"). It emits the funnel signals
 * the device-authed telemetry can't see — install → connect_started → connected → enabled, with
 * preflight_failed as the branch — and forwards extension-HOST crashes, all before (or independent
 * of) any device token. Keyed by a random per-install `anonId`, never a user identity.
 *
 * Best-effort and vscode-free: it never throws into the CLI and swallows every sink failure, so a
 * telemetry blip can't disturb the money loop. Sent un-batched (these are low-frequency, unlike the
 * per-second view funnel), with every field truncated to the server schema's caps so an over-long
 * stack can't get the whole report rejected.
 *
 * NOTE: only the extension host reports here. The standalone render script never phones home
 * (CLAUDE.md "Never break the user's CLI"), so it is deliberately NOT wired to this.
 */

const MSG_MAX = 1000;
const STACK_MAX = 8000;
const NAME_MAX = 120;
const WHERE_MAX = 120;
const REASON_MAX = 200;
const CC_VERSION_MAX = 64;

/**
 * Cap on distinct error signatures deduped per session. A guard against unbounded Set growth from a
 * pathological variety of one-off errors — past it we stop deduping (let reports through) rather than
 * risk hiding a genuinely new fault. 200 distinct signatures in one host session is already unheard-of.
 */
const MAX_DEDUP_KEYS = 200;

function trunc(s: string | undefined, max: number): string | undefined {
  if (s == null) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Expected, non-fault conditions that must stay OUT of `codecash_client_error` — they're normal user
 * states, not crashes, and were polluting the error-spike signal:
 *   - host/user cancellation (VS Code `CancellationError`, or a bare `Canceled`);
 *   - the VS Code constraint that user settings can't be written while settings.json has unsaved edits
 *     (thrown as a `CodeExpectedError` — the user just needs to save; codecash retries on the next tick).
 */
function isExpectedError(name: string | undefined, message: string): boolean {
  if (name === "Canceled" || name === "CancellationError") return true;
  if (message.includes("has unsaved changes")) return true;
  return false;
}

export interface ClientEventSink {
  /** POST a batch to /api/events/client. Should be fire-and-forget and never reject. */
  postClientEvents(batch: ClientEventBatch): Promise<void> | void;
}

export class ClientReporter {
  /** Signatures (`where`+name+message) already reported this session — see {@link reportError}. */
  private readonly reportedErrors = new Set<string>();

  constructor(
    private readonly sink: ClientEventSink,
    private readonly anonId: string,
    private readonly meta: { adapter: Adapter; platform?: string; extVersion?: string },
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Record a funnel milestone (install / connect_started / connected / preflight_failed / enabled). */
  signal(type: ClientSignalType, extra?: { reason?: string; ccVersion?: string }): void {
    this.send({
      kind: "signal",
      type,
      occurredAt: this.now(),
      reason: trunc(extra?.reason, REASON_MAX),
      ccVersion: trunc(extra?.ccVersion, CC_VERSION_MAX),
    });
  }

  /** Forward an extension-host error to Datadog (via the server). `where` is a logical location. */
  reportError(error: unknown, where: string): void {
    const e = error instanceof Error ? error : undefined;
    const name = e?.name;
    const message = e?.message ?? String(error);

    // Expected user conditions are not faults — never report them (keeps codecash_client_error clean).
    if (isExpectedError(name, message)) return;

    // Dedup identical failures per session: ONE stuck install (e.g. an unparseable settings.json that
    // re-fails on every enable retry, or an ad-cache rename that keeps ENOENT-ing) would otherwise
    // report the same error dozens-to-hundreds of times a day and trip the error-spike alert on its
    // own. Collapse to the first occurrence — distinct `where`/message still report, so the count
    // reflects distinct faults, not retry volume. A window reload starts a fresh session (re-reports).
    const key = JSON.stringify([where, name ?? "", message]);
    if (this.reportedErrors.has(key)) return;
    if (this.reportedErrors.size < MAX_DEDUP_KEYS) this.reportedErrors.add(key);

    this.send({
      kind: "error",
      occurredAt: this.now(),
      message: trunc(message, MSG_MAX) || "unknown error",
      name: trunc(name, NAME_MAX),
      stack: trunc(e?.stack, STACK_MAX),
      where: trunc(where, WHERE_MAX),
    });
  }

  private send(event: ClientEvent): void {
    try {
      void Promise.resolve(
        this.sink.postClientEvents({
          anonId: this.anonId,
          adapter: this.meta.adapter,
          platform: this.meta.platform,
          extVersion: this.meta.extVersion,
          events: [event],
        }),
      ).catch(() => {});
    } catch {
      /* best-effort: a synchronous sink throw must never reach the CLI */
    }
  }
}
