import { describe, expect, it } from "vitest";
import { decodeAdminSystemModelPolicyResponse, initialChatTitleReasoningEffort } from "./adminSystemModelPolicy";

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
    titleCandidates: [], documentCandidates: [],
    imageCandidates: [],
    verificationCandidates: [],
    ineligible: { chat_titles: [], direct_pdf: [], memory: [], vision: [] },
    rerankerCandidates: [],
    policy: {
      chatTitleModel: null, chatTitleReasoningEffort: null, chatPdfModel: null,
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

  it.each([
    { chatPdfProcessingMode: "invalid" }, { chatPdfFallbackMethod: "invalid" },
    { chatPdfProcessingMode: null }, { chatPdfFallbackMethod: null },
    { chatPdfNativeModel: null, chatPdfNativeReasoningEffort: "low" },
    { chatPdfNativeModel: { ...response.systemModelPolicy.candidates[0], available: "yes" } }
  ])("rejects invalid PDF policy instead of selecting a default: %j", (patch) => {
    expect(decodeAdminSystemModelPolicyResponse({ systemModelPolicy: { ...response.systemModelPolicy,
      policy: { ...response.systemModelPolicy.policy, ...patch } } })).toBeNull();
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
        ineligible: { chat_titles: [],
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
      systemModelPolicy: { ...legacyCatalog, ineligible: { chat_titles: [], memory: [] } }
    })).toEqual(response);

    expect(decodeAdminSystemModelPolicyResponse({
      systemModelPolicy: {
        ...response.systemModelPolicy,
        ineligible: { chat_titles: [], memory: [{ ...ineligibleModel, reason: "unknown" }] }
      }
    })).toBeNull();
    expect(decodeAdminSystemModelPolicyResponse({
      systemModelPolicy: { ...response.systemModelPolicy, ineligible: [] }
    })).toBeNull();
  });
});

it("accepts title-only structured candidates and chooses only an advertised reasoning disable", () => {
  const model = { ...response.systemModelPolicy.candidates[0]!, forcedToolCall: "unsupported" };
  const catalog = { ...response.systemModelPolicy, titleCandidates: [model], policy: {
    ...response.systemModelPolicy.policy, chatTitleModel: { ...model, available: true }, chatTitleReasoningEffort: "low"
  } };
  expect(decodeAdminSystemModelPolicyResponse({ systemModelPolicy: catalog })?.systemModelPolicy.titleCandidates).toEqual([model]);
  expect(decodeAdminSystemModelPolicyResponse({ systemModelPolicy: { ...catalog, titleCandidates: [{ ...model, structuredOutput: "not_verified" }] } })).toBeNull();
  expect(initialChatTitleReasoningEffort({ reasoningEfforts: ["none", "low"] })).toBe("none");
  expect(initialChatTitleReasoningEffort({ reasoningEfforts: ["low", "high"] })).toBeNull();
  expect(initialChatTitleReasoningEffort({ reasoningEfforts: [] })).toBeNull();
});
