import { describe, expect, it } from "vitest";
import { presentRunLifecycleV2 } from "@/features/run-lifecycle-v2/runPresentation";
import { MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE, MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE, mcpAutoDiscoveryFailure } from "@/lib/contracts/runs";
import { TOOL_SYNTHESIS_FAILURE } from "@/lib/contracts/runs";
import {
  runTransportStateV2,
  transportLostForMessageV2
} from "./runTransportPresentation";

const streamingMessage = {
  id: "assistant-1",
  runId: "run-1",
  status: "streaming" as const
};

function present(
  slice: ReturnType<typeof runTransportStateV2>,
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
  it("restores deterministic Gemini routing rejection without a blind retry after reload", () => {
    const failure = mcpAutoDiscoveryFailure("mcp_router_gemini_invalid_request");
    const slice = runTransportStateV2({ activeChatStreaming: false, interruptedRun: null,
      message: { ...streamingMessage, errorMessage: failure.message, status: "error" }, persistedRunStatus: "error" });
    expect(present(slice)).toMatchObject({ kind: "terminal_error", failure: { ...failure, recovery: "change_parameters" } });
  });
  it.each([TOOL_SYNTHESIS_FAILURE.message, "Provider returned a tool call from a no-tool synthesis request."])(
    "restores a safe final synthesis failure from its persisted message", (errorMessage) => {
      const slice = runTransportStateV2({ activeChatStreaming: false, interruptedRun: null,
        message: { ...streamingMessage, errorMessage, status: "error" }, persistedRunStatus: "error" });
      expect(present(slice)).toMatchObject({ kind: "terminal_error",
        failure: { ...TOOL_SYNTHESIS_FAILURE, recovery: "regenerate" } });
    }
  );

  it.each(["mcp_router_output_limit", "mcp_router_timeout", "mcp_router_output_invalid"])("restores the exact safe %s cause after reload", (reason) => {
    const failure = mcpAutoDiscoveryFailure(reason);
    const slice = runTransportStateV2({ activeChatStreaming: false, interruptedRun: null,
      message: { ...streamingMessage, errorMessage: failure.message, status: "error" }, persistedRunStatus: "error" });
    expect(slice.failure).toEqual({ ...failure, recovery: "retry" });
  });

  it("restores Auto recovery from the exact persisted discovery failure after reload", () => {
    const slice = runTransportStateV2({
      activeChatStreaming: false,
      interruptedRun: null,
      message: { ...streamingMessage, status: "error", errorMessage: MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE },
      persistedRunStatus: null
    });
    expect(presentRunLifecycleV2({ ...slice, content: "", events: [], runId: "run-1" })).toMatchObject({
      kind: "terminal_error",
      failure: { code: MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE, recovery: "retry", message: MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE }
    });
  });

  it.each(["complete", "streaming"] as const)("ignores a stale failure message while %s", (status) => {
    const slice = runTransportStateV2({
      activeChatStreaming: status === "streaming", interruptedRun: null,
      message: { ...streamingMessage, status, errorMessage: MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE },
      persistedRunStatus: null
    });
    expect(slice.failure).toBeUndefined();
  });

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
    // server truth and must not masquerade as a terminal failure.
    const slice = runTransportStateV2({
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
    const slice = runTransportStateV2({
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
    const recovered = runTransportStateV2({
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
    const slice = runTransportStateV2({
      activeChatStreaming: false,
      interruptedRun: null,
      message: streamingMessage,
      persistedRunStatus: "streaming"
    });

    expect(slice.connectionLost).toBe(true);
    expect(present(slice).kind).toBe("connection_lost");
  });
});
