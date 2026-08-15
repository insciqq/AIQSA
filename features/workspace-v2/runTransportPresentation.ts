import type {
  RunLifecycleStateV2,
  RunLifecycleStatusV2
} from "@/features/run-lifecycle-v2/runPresentation";

/**
 * The run-lifecycle store's record of a stream whose transport failed without
 * a terminal frame (`ambiguousFailures[chatId]`). It exists only after a real
 * client transport error — a rejected reader or a stream that ended without a
 * terminal event — never from elapsed time on a healthy connection.
 */
export type InterruptedRunV2 = Readonly<{
  assistantMessageId: string;
  runId: string | null;
}>;

type TransportMessageV2 = Readonly<{
  id: string;
  runId: string | null;
  status: "cancelled" | "complete" | "error" | "streaming";
}>;

/** True when the recorded transport loss belongs to this exact answer. */
export function transportLostForMessageV2(
  interruptedRun: InterruptedRunV2 | null,
  message: Readonly<{ id: string; runId?: string | null }>
): boolean {
  if (!interruptedRun) return false;
  return (
    interruptedRun.assistantMessageId === message.id ||
    (interruptedRun.runId !== null && interruptedRun.runId === message.runId)
  );
}

/**
 * Builds the transport-status slice of `RunLifecycleStateV2` for one answer.
 *
 * While a genuine transport loss is recorded for this answer, the locally
 * written post-loss message status is not server truth: the unknown outcome
 * must not masquerade as error or complete (addendum §4.2), so the slice
 * suppresses it and reports `connectionLost` until the user-owned refresh
 * reconciles with durable server state. Every other path passes the existing
 * persisted run and message state through unchanged.
 */
export function runTransportStateV2(input: Readonly<{
  activeChatStreaming: boolean;
  interruptedRun: InterruptedRunV2 | null;
  message: TransportMessageV2;
  persistedRunStatus: RunLifecycleStatusV2 | null;
}>): Pick<
  RunLifecycleStateV2,
  "authoritativeMessageStatus" | "connectionLost" | "status"
> {
  if (transportLostForMessageV2(input.interruptedRun, input.message)) {
    return {
      authoritativeMessageStatus: null,
      connectionLost: true,
      status: null
    };
  }

  return {
    authoritativeMessageStatus:
      input.message.status === "streaming" ? null : input.message.status,
    connectionLost:
      input.message.status === "streaming" &&
      !input.activeChatStreaming &&
      input.persistedRunStatus !== null,
    status:
      input.persistedRunStatus ??
      (input.message.status === "streaming" ? "streaming" : input.message.status)
  };
}
