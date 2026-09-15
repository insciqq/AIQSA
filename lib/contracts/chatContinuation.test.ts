import { describe, expect, it } from "vitest";
import { decodeChatContinuationRequest } from "./chatContinuation";

const request = { expectedLeafMessageId: "answer", requestId: "00000000-0000-4000-8000-000000000001" };

describe("continuation model selection", () => {
  it("accepts the existing request and an explicit provider/model pair", () => {
    expect(decodeChatContinuationRequest(request)).toEqual(request);
    const selected = { ...request, modelSelection: { provider: "connection", modelId: "deployment" } };
    expect(decodeChatContinuationRequest(selected)).toEqual(selected);
  });

  it.each([null, [], {}, { provider: "connection" }, { modelId: "deployment" },
    { provider: "", modelId: "deployment" }, { provider: "connection", modelId: "" },
    { provider: "connection", modelId: "x".repeat(257) },
    { provider: "x".repeat(257), modelId: "deployment" },
    { provider: "connection", modelId: "deployment", extra: true }
  ])("rejects a malformed selection: %j", (modelSelection) => {
    expect(decodeChatContinuationRequest({ ...request, modelSelection })).toBeNull();
  });

  it("rejects unknown top-level fields", () => {
    expect(decodeChatContinuationRequest({ ...request, defaultProviderModelId: "unvalidated" })).toBeNull();
  });
});
