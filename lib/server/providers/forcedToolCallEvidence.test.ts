import { describe, expect, it } from "vitest";
import {
  decodeForcedToolCallVerificationEvidence,
  forcedToolCallVerificationEvidence,
  forcedToolCallVerificationStatus,
  hasVerifiedForcedToolCall
} from "./forcedToolCallEvidence";

const model = {
  adapterKind: "openrouter_chat_completions" as const,
  capabilities: { toolCalling: true },
  upstreamModelId: "vendor/model"
};

describe("forced strict tool-call evidence", () => {
  it("binds evidence to the exact adapter and upstream model", () => {
    const forcedToolCall = forcedToolCallVerificationEvidence(
      model.adapterKind,
      model.upstreamModelId
    );
    expect(forcedToolCall).toEqual({
      adapterKind: "openrouter_chat_completions",
      probeVersion: 1,
      upstreamModelId: "vendor/model",
      verified: true
    });
    expect(hasVerifiedForcedToolCall({ forcedToolCall }, model)).toBe(true);
    expect(hasVerifiedForcedToolCall({ forcedToolCall }, {
      ...model,
      upstreamModelId: "vendor/other"
    })).toBe(false);
  });

  it("fails closed for stale, malformed, and proven-unsupported evidence", () => {
    expect(decodeForcedToolCallVerificationEvidence({
      adapterKind: model.adapterKind,
      probeVersion: 0,
      upstreamModelId: model.upstreamModelId,
      verified: true
    })).toBeNull();
    expect(forcedToolCallVerificationStatus({}, model)).toBe("not_verified");
    expect(forcedToolCallVerificationStatus({
      compatibility: { forcedToolCall: "not_supported" }
    }, model)).toBe("unsupported");
    expect(forcedToolCallVerificationStatus({}, {
      ...model,
      capabilities: { toolCalling: false }
    })).toBe("unsupported");
  });
});
