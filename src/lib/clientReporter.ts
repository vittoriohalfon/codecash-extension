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

function trunc(s: string | undefined, max: number): string | undefined {
  if (s == null) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

export interface ClientEventSink {
  /** POST a batch to /api/events/client. Should be fire-and-forget and never reject. */
  postClientEvents(batch: ClientEventBatch): Promise<void> | void;
}

export class ClientReporter {
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
    this.send({
      kind: "error",
      occurredAt: this.now(),
      message: trunc(e?.message ?? String(error), MSG_MAX) || "unknown error",
      name: trunc(e?.name, NAME_MAX),
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
