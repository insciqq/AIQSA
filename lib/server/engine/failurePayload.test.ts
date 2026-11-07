import { describe, expect, it } from "vitest";
import { ProviderRequestTimeoutError } from "../providers/network";
import { markProviderStreamDrop } from "../providers/streamDrop";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import { EngineFailure, failurePayload } from "./execution";

const names = { connection: "OpenAI (CodexLB)", model: "GPT-6-Astra" };
const TRANSIENT = "This is a problem on the provider's side, not in AIQSA. Try again in a few minutes, or choose another model.";

describe("a run's terminal failure text", () => {
  it("names the run's model and connection for a provider's failure, and keeps the answer so far", () => {
    expect(failurePayload(markProviderStreamDrop(new Error("stream_incomplete"), "truncated"), false, false, names)).toEqual({
      code: "provider_stream_failed",
      message: `GPT-6-Astra via OpenAI (CodexLB) kept failing before the response was complete. ${TRANSIENT} The answer so far is kept.`
    });
    expect(failurePayload(new ProviderRequestTimeoutError(900_000), true, false, names)).toEqual({
      code: "provider_request_timed_out",
      message: `GPT-6-Astra via OpenAI (CodexLB) did not answer in time. ${TRANSIENT} Its Workspace files and the answer so far are kept.`
    });
    expect(failurePayload(Object.assign(new Error("x"), { code: "provider_capability_unsupported" }), false, false, names).message)
      .toMatch(/^GPT-6-Astra via OpenAI \(CodexLB\) does not support part of this request.*sending it again will not help/u);
  });

  it("keeps the Workspace's and AIQSA's own wording", () => {
    const workspace = new WorkspaceRuntimeError("workspace_storage_full");
    expect(failurePayload(workspace, true, false, names)).toEqual({ code: workspace.code, message: "The Workspace could not complete this turn." });
    expect(failurePayload(new Error("bookkeeping"), false, false, names)).toEqual({
      code: "run_execution_failed", message: "The answer could not be completed. The answer so far is kept." });
    expect(failurePayload(new Error("bookkeeping"), true, false, names).message)
      .toBe("The answer could not be completed. Its Workspace files and the answer so far are kept.");
    expect(failurePayload(new EngineFailure("run_time_limit", "Own words."), false, false, names)).toEqual({ code: "run_time_limit", message: "Own words." });
  });
});
