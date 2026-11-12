import { decodePreparingRunAdmission } from "../../contracts/runs";
import { connectorRunEvent, type ConnectorRunStreamEvent } from "./runEvents";
import { CONNECTOR_TERMINAL_RUN_STATUSES, type ConnectorRunOperations } from "./runGateway";
import { createRunStreamReader, RUN_STREAM_IDLE_MS, type RunStreamReader } from "./sse";

/**
 * What a connector makes of the send handler's answer to its message: a
 * refusal with its code and facts, or the admitted run as a stream of typed
 * events. The run is recorded (`recordRun`) the moment it is known, while it
 * goes on, so whatever the run does next can already tell where it came from.
 * A run that streams nothing here (a deferred admission, or a stream lost or
 * silent before its end) is followed through its state until it settles.
 */

/** Why a message was not admitted, as the send handler (or the connector before it) answered. */
export type ConnectorSendRefusal = Readonly<{
  status: number;
  code: string;
  /** From `retry-after`, for usage limits. */
  retryAfterSeconds?: number;
  usageLimit?: Readonly<{ limit: number | null; window: string | null }>;
  /** The run that holds the chat (`active_run_in_progress`). */
  activeRunId?: string;
}>;

export type ConnectorSendFollowed =
  | Readonly<{
    kind: "admitted";
    runId: string;
    assistantMessageId: string | null;
    userMessageId: string | null;
    /** Whether `recordRun` recorded the run, so its delivery is claimed exactly once. */
    runLinked: boolean;
    /** Admitted for later (PDF or Workspace preparation): nothing streams here. */
    deferred: boolean;
    events: AsyncIterable<ConnectorRunStreamEvent>;
  }>
  | Readonly<{ kind: "refused"; refusal: ConnectorSendRefusal }>;

/** How often a run that streams nothing here is read: from 1 s, doubling up to 15 s. */
export const CONNECTOR_RUN_POLL_MIN_MS = 1_000;
export const CONNECTOR_RUN_POLL_MAX_MS = 15_000;
/** How long a run that streams nothing here is followed before the connector stops watching it. */
export const CONNECTOR_RUN_FOLLOW_MS = 6 * 3_600_000;

export type ConnectorRunWait = (input: Readonly<{ runId: string; userId: string; deadline: number }>) =>
  Promise<"complete" | "error" | "cancelled" | "gone" | null>;

type Clock = Readonly<{ now: () => number; sleep: (ms: number) => Promise<void> }>;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Follows a run's state until it settles (`gone` when it can no longer be read), or null past the deadline. */
export function createConnectorRunWait(
  gateway: Pick<ConnectorRunOperations, "runState">, clock: Partial<Clock> = {}
): ConnectorRunWait {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? defaultSleep;
  return async ({ deadline, runId, userId }) => {
    let delay = CONNECTOR_RUN_POLL_MIN_MS;
    for (;;) {
      const state = await gateway.runState({ runId, userId }).catch(() => ({ status: "unknown" }));
      if (!state) return "gone";
      if (CONNECTOR_TERMINAL_RUN_STATUSES.has(state.status)) return state.status as "complete" | "error" | "cancelled";
      if (now() + delay > deadline) return null;
      await sleep(delay);
      delay = Math.min(delay * 2, CONNECTOR_RUN_POLL_MAX_MS);
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function terminalEvent(status: "complete" | "error" | "cancelled" | "gone"): ConnectorRunStreamEvent {
  if (status === "complete" || status === "cancelled") return { status, type: "done" };
  return { code: status === "gone" ? "model_run_not_found" : null, message: null, type: "failed" };
}

/** The send handler's refusal as its code and facts. */
export function connectorSendRefusal(response: Response, body: unknown): ConnectorSendRefusal {
  const value = isRecord(body) ? body : {};
  const code = response.status === 401 ? "unauthorized" : typeof value.error === "string" ? value.error : `http_${response.status}`;
  // An absent header is no wait at all, never a wait of zero seconds.
  const header = response.headers.get("retry-after");
  const retryAfter = header === null || header.trim() === "" ? Number.NaN : Number(header);
  const usage = isRecord(value.usageLimit) ? value.usageLimit : null;
  const run = isRecord(value.run) ? value.run : null;
  return {
    code,
    status: response.status,
    ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {}),
    ...(usage ? {
      usageLimit: { limit: typeof usage.limit === "number" ? usage.limit : null, window: typeof usage.window === "string" ? usage.window : null }
    } : {}),
    ...(run && typeof run.id === "string" ? { activeRunId: run.id } : {})
  };
}

export type ConnectorSendFollowInput = Readonly<{
  userId: string;
  /** Records the run as the connector's once it is known; true when the record exists. Never throws. */
  recordRun(runId: string): Promise<boolean>;
  waitForRun: ConnectorRunWait;
  now: () => number;
  /** How long a run that streams nothing here is followed. */
  followMs: number;
  /** How long the stream may stay silent (`RUN_STREAM_IDLE_MS`). */
  idleMs?: number;
}>;

/** The send handler's answer to a connector's message: the admitted run's events, or the refusal. */
export async function followConnectorSend(response: Response, input: ConnectorSendFollowInput): Promise<ConnectorSendFollowed> {
  async function* polled(runId: string, status: string | null): AsyncGenerator<ConnectorRunStreamEvent> {
    if (status !== null) yield { status, type: "preparing" };
    const settled = await input.waitForRun({ deadline: input.now() + input.followMs, runId, userId: input.userId });
    if (settled) yield terminalEvent(settled);
  }

  async function* streamed(
    reader: RunStreamReader, runId: string, early: readonly ConnectorRunStreamEvent[]
  ): AsyncGenerator<ConnectorRunStreamEvent> {
    try {
      for (const event of early) {
        yield event;
        if (event.type === "done" || event.type === "failed") return;
      }
      for (;;) {
        const read = await reader.next();
        if (read.kind !== "frame") break;
        const event = connectorRunEvent(read.frame);
        if (!event) continue;
        yield event;
        if (event.type === "done" || event.type === "failed") return;
      }
    } finally {
      await reader.cancel();
    }
    // The stream ended or went silent before its terminal frame: the run's state decides.
    yield* polled(runId, null);
  }

  async function admitStream(): Promise<ConnectorSendFollowed> {
    const reader = createRunStreamReader(response.body!, { idleMs: input.idleMs ?? RUN_STREAM_IDLE_MS });
    let runId: string | null = null;
    let linked: Promise<boolean> = Promise.resolve(false);
    let started: Record<string, unknown> = {};
    const early: ConnectorRunStreamEvent[] = [];
    for (;;) {
      const read = await reader.next();
      if (read.kind !== "frame") break;
      const data = isRecord(read.frame.data) ? read.frame.data : {};
      if (!runId) {
        if (read.frame.type === "run_start" && typeof data.runId === "string") {
          runId = data.runId;
          // Recorded the moment the run is known, while the run goes on: whatever the run
          // does next (its first tool call included) can already tell which connector it came from.
          linked = input.recordRun(runId);
        } else if (read.frame.type === "error") {
          await reader.cancel();
          const failed = connectorRunEvent(read.frame);
          return { kind: "refused", refusal: { code: failed?.type === "failed" && failed.code ? failed.code : "run_failed", status: 500 } };
        }
        continue;
      }
      if (read.frame.type === "message_start") {
        started = data;
        break;
      }
      const event = connectorRunEvent(read.frame);
      if (event) early.push(event);
      if (event?.type === "done" || event?.type === "failed") break;
    }
    if (!runId) {
      await reader.cancel();
      return { kind: "refused", refusal: { code: "run_stream_unavailable", status: 500 } };
    }
    return {
      assistantMessageId: typeof started.assistantMessageId === "string" ? started.assistantMessageId : null,
      deferred: false, events: streamed(reader, runId, early), kind: "admitted", runId,
      runLinked: await linked, userMessageId: typeof started.userMessageId === "string" ? started.userMessageId : null
    };
  }

  if (response.ok && response.body && response.headers.get("content-type")?.startsWith("text/event-stream")) {
    return admitStream();
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    const deferred = decodePreparingRunAdmission(body);
    if (!deferred) return { kind: "refused", refusal: { code: "run_stream_unavailable", status: 500 } };
    const runLinked = await input.recordRun(deferred.run.id);
    return {
      assistantMessageId: deferred.assistantMessageId, deferred: true,
      events: polled(deferred.run.id, deferred.run.status), kind: "admitted", runId: deferred.run.id, runLinked,
      userMessageId: deferred.userMessageId
    };
  }
  return { kind: "refused", refusal: connectorSendRefusal(response, body) };
}
