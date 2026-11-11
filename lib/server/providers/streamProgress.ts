/**
 * How far a provider stream had got when a timeout ended it: milliseconds since
 * its last received byte and since its last parsed event (an SSE comment, such
 * as a gateway's keepalive, or an empty data frame is no event), and whether any event had arrived, so
 * the response had started. Numbers and a flag, never content (decision
 * 2026-11-07: a long timeout's record says whether the upstream was stuck or the
 * model was reasoning silently). Only the flag decides anything: a request
 * deadline whose response had not started is sent again (`modelCall.ts`,
 * decision 2026-11-11); a request's owner names the start when no stream did
 * (`runtimeFactory.ts`).
 */
export type ProviderStreamProgress = Readonly<{
  last_byte_ms?: number;
  last_event_ms?: number;
  response_started: boolean;
}>;

const progressKey = Symbol.for("aiqsa.providerStreamProgress");

function age(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/** Bounded facts from what a reader measured; an absent age stays absent. */
export function providerStreamProgressFacts(input: Readonly<{ lastByteMs?: number; lastEventMs?: number; responseStarted: boolean }>):
  ProviderStreamProgress {
  const lastByte = age(input.lastByteMs);
  const lastEvent = age(input.lastEventMs);
  return Object.freeze({ ...(lastByte !== undefined ? { last_byte_ms: lastByte } : {}),
    ...(lastEvent !== undefined ? { last_event_ms: lastEvent } : {}), response_started: input.responseStarted });
}

/** Names the progress on the failure itself, as a non-enumerable own property, once; a value that cannot carry it stays unmarked. */
export function markProviderStreamProgress<T>(error: T, progress: ProviderStreamProgress): T {
  if (typeof error === "object" && error !== null && providerStreamProgress(error) === null) {
    try {
      Object.defineProperty(error, progressKey, { configurable: true, value: progress });
    } catch {
      // A frozen foreign value keeps its identity unmarked.
    }
  }
  return error;
}

export function providerStreamProgress(error: unknown): ProviderStreamProgress | null {
  try {
    if (typeof error !== "object" || error === null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, progressKey);
    const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    return typeof record.response_started === "boolean"
      ? providerStreamProgressFacts({ lastByteMs: record.last_byte_ms as number | undefined,
        lastEventMs: record.last_event_ms as number | undefined, responseStarted: record.response_started })
      : null;
  } catch {
    return null;
  }
}
