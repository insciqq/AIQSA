import { describe, expect, it } from "vitest";
import {
  buildMemoryReclassificationRequest,
  createMemoryReclassificationProvider,
  decodeMemoryReclassificationDecision,
  MemoryReclassificationError
} from "./classifier";

const role = {
  credentialSource: "default" as const,
  modelConfiguration: {
    capabilities: { structuredOutput: true }
  },
  snapshot: { providerFamily: "openai" }
};

describe("memory reclassification classifier", () => {
  it("accepts the exact strict decision shape", () => {
    expect(decodeMemoryReclassificationDecision({
      category: "sensitive",
      reason_code: "private_personal",
      response_preference: false,
      sensitivity: "SENSITIVE",
      subject_scope: "USER",
      storage_decision: "ALLOW"
    })).toEqual({
      category: "about_you",
      reasonCode: "private_personal",
      responsePreference: false,
      sensitivity: "NORMAL",
      subjectScope: "USER",
      storageDecision: "ALLOW"
    });
  });

  it("rejects semantic mismatch and extra fields", () => {
    expect(() => decodeMemoryReclassificationDecision({
      category: "about_you",
      reason_code: "ordinary_personal",
      response_preference: false,
      sensitivity: "SECRET",
      subject_scope: "USER",
      storage_decision: "REJECT_SECRET"
    })).toThrowError(MemoryReclassificationError);
    expect(() => decodeMemoryReclassificationDecision({
      category: "about_you",
      reason_code: "uncertain",
      response_preference: false,
      sensitivity: "UNCERTAIN",
      subject_scope: "UNCERTAIN",
      storage_decision: "REJECT_UNSUITABLE",
      text: "leak"
    })).toThrowError(MemoryReclassificationError);
    expect(() => decodeMemoryReclassificationDecision({
      category: "other",
      reason_code: "third_party_rejected",
      response_preference: false,
      sensitivity: "NORMAL",
      subject_scope: "THIRD_PARTY",
      storage_decision: "ALLOW"
    })).toThrowError(MemoryReclassificationError);
    expect(decodeMemoryReclassificationDecision({
      category: "other",
      reason_code: "allegation_rejected",
      response_preference: false,
      sensitivity: "SENSITIVE",
      subject_scope: "THIRD_PARTY",
      storage_decision: "REJECT_ALLEGATION"
    }).storageDecision).toBe("REJECT_ALLEGATION");
  });

  it("keeps the statement quoted in a bounded strict request", () => {
    const request = buildMemoryReclassificationRequest("Я люблю чай", "AUTOMATIC");
    expect(request.name).toBe("memory_safety_reclassification_v1");
    expect(request.schema).toMatchObject({ additionalProperties: false });
    expect(request.userPrompt).toContain("Я люблю чай");
    expect(request.userPrompt).toContain("AUTOMATIC");
    expect(request.systemPrompt).toContain("otherwise storable first-party personal fact");
    expect(() => buildMemoryReclassificationRequest("\u0000")).toThrow();
  });

  it("records provider, model, and policy metadata from the resolved System Model", async () => {
    const result = await createMemoryReclassificationProvider({
      executeStructuredOutput: async () => ({
        category: "about_you",
        reason_code: "ordinary_personal",
        response_preference: false,
        sensitivity: "NORMAL",
        subject_scope: "USER",
        storage_decision: "ALLOW"
      }),
      resolveSystemModel: async () => ({
        credentialScope: "installation",
        ok: true,
        policyVersion: 7,
        providerModelId: "model-1",
        reasoningEffort: null,
        role
      } as never)
    }).classify("I prefer tea");
    expect(result).toEqual({
      decision: {
        category: "about_you",
        reasonCode: "ordinary_personal",
        responsePreference: false,
        sensitivity: "NORMAL",
        subjectScope: "USER",
        storageDecision: "ALLOW"
      },
      modelId: "model-1",
      policyVersion: "memory-safety-policy-v2:7",
      providerId: "openai"
    });
  });
});
