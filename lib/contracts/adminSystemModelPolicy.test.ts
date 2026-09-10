import { describe, expect, it } from "vitest";
import { decodeAdminSystemModelPolicyResponse } from "./adminSystemModelPolicy";

const response = {
  systemModelPolicy: {
    candidates: [{
      connectionDisplayName: "Provider",
      connectionId: "connection-1",
      defaultReasoningEffort: "medium",
      displayName: "Model",
      forcedToolCall: "verified",
      id: "model-1",
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      structuredOutput: "verified"
    }],
    documentCandidates: [],
    imageCandidates: [],
    verificationCandidates: [],
    ineligible: { direct_pdf: [], memory: [], vision: [] },
    rerankerCandidates: [],
    policy: {
      chatPdfModel: null,
      chatPdfReasoningEffort: null,
      imageModel: null,
      imageParameters: {},
      reasoningEffort: null,
      rerankerModel: null,
      systemModel: null,
      updatedAt: "2026-08-08T00:00:00.000Z",
      updatedBy: null,
      version: 1
    }
  }
};

describe("administrator system model policy contract", () => {
  it("decodes the catalog-safe policy projection", () => {
    expect(decodeAdminSystemModelPolicyResponse(response)).toEqual(response);
  });

  it("rejects malformed availability and principal fields", () => {
    expect(decodeAdminSystemModelPolicyResponse({
      systemModelPolicy: {
        ...response.systemModelPolicy,
        policy: {
          ...response.systemModelPolicy.policy,
          systemModel: { ...response.systemModelPolicy.candidates[0], available: "yes" }
        }
      }
    })).toBeNull();
    expect(decodeAdminSystemModelPolicyResponse({
      systemModelPolicy: {
        ...response.systemModelPolicy,
        candidates: [{
          ...response.systemModelPolicy.candidates[0],
          defaultReasoningEffort: "max"
        }]
      }
    })).toBeNull();
    expect(decodeAdminSystemModelPolicyResponse({
      systemModelPolicy: {
        ...response.systemModelPolicy,
        policy: {
          ...response.systemModelPolicy.policy,
          updatedBy: { displayName: "", id: "admin-1" }
        }
      }
    })).toBeNull();
    expect(decodeAdminSystemModelPolicyResponse({
      systemModelPolicy: {
        ...response.systemModelPolicy,
        policy: {
          ...response.systemModelPolicy.policy,
          reasoningEffort: "xhigh"
        }
      }
    })).toBeNull();
  });

  it("decodes per-role ineligibility with reasons and tolerates an absent list", () => {
    const ineligibleModel = {
      ...response.systemModelPolicy.candidates[0],
      forcedToolCall: "not_verified",
      id: "model-2",
      structuredOutput: "not_verified"
    };
    const withReasons = {
      systemModelPolicy: {
        ...response.systemModelPolicy,
        ineligible: {
          direct_pdf: [{ ...ineligibleModel, reason: "adapter_unsupported" }],
          memory: [{ ...ineligibleModel, reason: "not_checked" }],
          vision: [{ ...ineligibleModel, reason: "no_default_credential" }]
        }
      }
    };
    expect(decodeAdminSystemModelPolicyResponse(withReasons)).toEqual(withReasons);

    const { ineligible: _ineligible, ...legacyCatalog } = response.systemModelPolicy;
    expect(decodeAdminSystemModelPolicyResponse({ systemModelPolicy: legacyCatalog }))
      .toEqual(response);
    expect(decodeAdminSystemModelPolicyResponse({
      systemModelPolicy: { ...legacyCatalog, ineligible: { memory: [] } }
    })).toEqual(response);

    expect(decodeAdminSystemModelPolicyResponse({
      systemModelPolicy: {
        ...response.systemModelPolicy,
        ineligible: { memory: [{ ...ineligibleModel, reason: "unknown" }] }
      }
    })).toBeNull();
    expect(decodeAdminSystemModelPolicyResponse({
      systemModelPolicy: { ...response.systemModelPolicy, ineligible: [] }
    })).toBeNull();
  });
});
