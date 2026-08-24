import { describe, expect, it } from "vitest";
import type { MemoryActionIntent } from "../../../contracts/memoryActionIntent";
import {
  MEMORY_CONTROL_PIPELINE_VERSION,
  MEMORY_CONTROL_VERSIONS,
  MEMORY_READ_ONLY_CONTROL_REUSE_VERSION,
  createMemoryReadOnlyControlReuseProof,
  decodeMemoryReadOnlyControlReuseProof
} from "./controlRuntime";

const profileIntent: MemoryActionIntent = {
  action: "NONE",
  applyResponsePreferences: false,
  category: null,
  categoryHint: null,
  confidenceBand: "HIGH",
  memoryUseful: true,
  pastChatsUseful: false,
  profileRequested: true,
  queryText: "current Saved and learned facts about the user",
  reasonCode: "no_memory_request",
  recencyRequested: false,
  retrievalMode: "CURRENT_PROFILE",
  referencedMemoryRef: null,
  replacementStatement: null,
  responsePreference: false,
  sensitiveDomainHint: null,
  sensitivity: "NORMAL",
  statement: null,
  targetQuery: null,
  temporalAsOf: null,
  temporalFrom: null,
  temporalIntent: "CURRENT",
  temporalTo: null,
  thisChatOnly: false
};

describe("Memory control runtime contract", () => {
  it("binds the profile decision to the current control contract versions", () => {
    expect(MEMORY_CONTROL_PIPELINE_VERSION).toBe("memory-control-v8");
    expect(MEMORY_CONTROL_VERSIONS).toMatchObject({
      pipelineVersion: "memory-control-v8",
      policyVersion: "memory-control-policy-v8",
      promptVersion: "memory-control-prompt-v11",
      schemaVersion: "memory-action-intent-v5"
    });
    expect(MEMORY_READ_ONLY_CONTROL_REUSE_VERSION).toBe(4);
  });

  it("round-trips the exact broad-profile decision and rejects a legacy proof version", () => {
    const proof = createMemoryReadOnlyControlReuseProof({
      inputHash: "a".repeat(64),
      result: {
        bindingId: "control-binding",
        intent: profileIntent,
        status: "READY"
      },
      sourceAttemptId: "source-attempt"
    });

    expect(proof).not.toBeNull();
    expect(decodeMemoryReadOnlyControlReuseProof(proof)).toMatchObject({
      intent: { profileRequested: true },
      version: 4
    });
    expect(decodeMemoryReadOnlyControlReuseProof({ ...proof, version: 1 })).toBeNull();
  });
});
