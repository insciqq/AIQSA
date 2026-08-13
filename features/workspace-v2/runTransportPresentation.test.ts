import { describe, expect, it } from "vitest";
import { presentRunLifecycleV2 } from "@/features/run-lifecycle-v2/runPresentation";
import {
  runTransportEvidenceV2,
  transportLostForMessageV2
} from "./runTransportPresentation";

const streamingMessage = {
  id: "assistant-1",
  runId: "run-1",
  status: "streaming" as const
};

function present(
  slice: ReturnType<typeof runTransportEvidenceV2>,
  content = "Частичный ответ"
) {
  return presentRunLifecycleV2({
    ...slice,
    content,
    events: [{ data: { delta: content }, type: "token" }],
    runId: "run-1"
  });
}

describe("Run transport presentation v2", () => {
  it("matches a recorded transport loss by assistant message id or run id", () => {
    const interrupted = { assistantMessageId: "assistant-1", runId: null };
    expect(transportLostForMessageV2(interrupted, { id: "assistant-1" })).toBe(true);
    expect(transportLostForMessageV2(interrupted, { id: "assistant-2" })).toBe(false);
    expect(
      transportLostForMessageV2(
        { assistantMessageId: "optimistic-1", runId: "run-1" },
        { id: "assistant-1", runId: "run-1" }
      )
    ).toBe(true);
    expect(transportLostForMessageV2(null, { id: "assistant-1" })).toBe(false);
  });

  it("presents a genuine transport error as connection_lost, never as error", () => {
    // After a dropped stream the lifecycle store marks the chat ambiguous and
    // the local message was stamped "error" — that stamp is not server
    // evidence and must not masquerade as a terminal failure.
    const slice = runTransportEvidenceV2({
      activeChatStreaming: false,
      interruptedRun: { assistantMessageId: "assistant-1", runId: "run-1" },
      message: { ...streamingMessage, status: "error" },
      persistedRunStatus: null
    });

    expect(slice).toEqual({
      authoritativeMessageStatus: null,
      connectionLost: true,
      status: null
    });
    expect(present(slice).kind).toBe("connection_lost");
  });

  it("never reports connection loss while the transport is healthy", () => {
    const slice = runTransportEvidenceV2({
      activeChatStreaming: true,
      interruptedRun: null,
      message: streamingMessage,
      persistedRunStatus: "streaming"
    });

    expect(slice.connectionLost).toBe(false);
    expect(present(slice).kind).toBe("streaming");
  });

  it("clears the indicator once refresh reconciles with server truth", () => {
    // refreshInterruptedRun clears the ambiguity record and replaces the
    // message with durable server state; the presentation follows it.
    const recovered = runTransportEvidenceV2({
      activeChatStreaming: false,
      interruptedRun: null,
      message: { ...streamingMessage, status: "complete" },
      persistedRunStatus: "complete"
    });

    expect(recovered.connectionLost).toBe(false);
    expect(present(recovered).kind).toBe("complete");
  });

  it("keeps the honest resume-orphan derivation for persisted streaming runs", () => {
    // A persisted run still reports streaming but no client stream exists:
    // the existing derivation shows connection loss rather than fake activity.
    const slice = runTransportEvidenceV2({
      activeChatStreaming: false,
      interruptedRun: null,
      message: streamingMessage,
      persistedRunStatus: "streaming"
    });

    expect(slice.connectionLost).toBe(true);
    expect(present(slice).kind).toBe("connection_lost");
  });
});
