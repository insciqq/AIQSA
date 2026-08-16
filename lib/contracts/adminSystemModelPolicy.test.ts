import { describe, expect, it } from "vitest";
import { decodeAdminSystemModelPolicyResponse } from "./adminSystemModelPolicy";

const response = {
  systemModelPolicy: {
    candidates: [{
      connectionDisplayName: "Provider",
      connectionId: "connection-1",
      defaultReasoningEffort: "medium",
      displayName: "Model",
      id: "model-1",
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      structuredOutput: "verified"
    }],
    policy: {
      reasoningEffort: null,
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
});
