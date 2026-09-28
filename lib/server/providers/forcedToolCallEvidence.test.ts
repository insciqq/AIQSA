import { describe, expect, it } from "vitest";
import {
  decodeForcedToolCallVerificationEvidence,
  forcedToolCallVerificationEvidence,
  forcedToolCallVerificationStatus,
  hasVerifiedForcedToolCall,
  hasVerifiedToolChoiceMode
} from "./forcedToolCallEvidence";

const model = {
  adapterKind: "openrouter_chat_completions" as const,
  capabilities: { toolCalling: true },
  upstreamModelId: "vendor/model"
};

describe("forced strict tool-call evidence", () => {
  it("requalifies the configured automatic mode without invalidating legacy native proof", () => {
    const deepseek = { adapterKind: "deepseek_responses_native", upstreamModelId: "deepseek-flash",
      capabilities: { toolCalling: true }, defaultParams: { reasoning: { effort: "high" } } };
    const evidence = { forcedToolCall: { adapterKind: deepseek.adapterKind, upstreamModelId: deepseek.upstreamModelId,
      probeVersion: 1, verified: true } };
    expect(forcedToolCallVerificationStatus(evidence, deepseek)).toBe("not_verified");
    expect(hasVerifiedToolChoiceMode(evidence, deepseek, "native")).toBe(true);
    expect(forcedToolCallVerificationStatus(evidence, { ...deepseek, defaultParams: { reasoning: { effort: "none" } } })).toBe("verified");
    expect(forcedToolCallVerificationStatus({ compatibility: { forcedToolCall: "not_supported" } }, deepseek)).toBe("not_verified");
  });

  it("binds evidence to the exact adapter and upstream model", () => {
    const forcedToolCall = forcedToolCallVerificationEvidence(
      model.adapterKind,
      model.upstreamModelId
    );
    expect(forcedToolCall).toEqual({
      adapterKind: "openrouter_chat_completions",
      probeVersion: 2,
      upstreamModelId: "vendor/model",
      verified: true,
      verifiedModes: ["native"]
    });
    expect(hasVerifiedForcedToolCall({ forcedToolCall }, model)).toBe(true);
    expect(hasVerifiedToolChoiceMode({ forcedToolCall }, model, "native")).toBe(true);
    expect(hasVerifiedToolChoiceMode({ forcedToolCall }, model, "validated_auto")).toBe(false);
    expect(hasVerifiedForcedToolCall({ forcedToolCall }, {
      ...model,
      upstreamModelId: "vendor/other"
    })).toBe(false);
  });

  it("fails closed for stale, malformed, and proven-unsupported evidence", () => {
    expect(decodeForcedToolCallVerificationEvidence({
      adapterKind: model.adapterKind,
      probeVersion: 1,
      upstreamModelId: model.upstreamModelId,
      verified: true
    })).toMatchObject({ verifiedModes: ["native"] });
    expect(hasVerifiedToolChoiceMode({ forcedToolCall: {
      adapterKind: model.adapterKind,
      probeVersion: 1,
      upstreamModelId: model.upstreamModelId,
      verified: true
    } }, model, "validated_auto")).toBe(false);
    expect(decodeForcedToolCallVerificationEvidence({
      adapterKind: model.adapterKind,
      probeVersion: 0,
      upstreamModelId: model.upstreamModelId,
      verified: true
    })).toBeNull();
    expect(forcedToolCallVerificationStatus({}, model)).toBe("not_verified");
    expect(forcedToolCallVerificationStatus({ compatibility: {
      toolCalling: "verified", structuredOutput: "verified"
    } }, model)).toBe("not_verified");
    expect(forcedToolCallVerificationStatus({
      compatibility: { forcedToolCall: "not_supported" }
    }, model)).toBe("unsupported");
    expect(forcedToolCallVerificationStatus({}, {
      ...model,
      capabilities: { toolCalling: false }
    })).toBe("unsupported");
  });
});
