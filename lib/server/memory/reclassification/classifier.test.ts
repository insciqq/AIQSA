import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  buildMemoryReclassificationRequest,
  createMemoryReclassificationProvider,
  createPrismaMemoryReclassificationProvider,
  decodeMemoryReclassificationDecision,
  MemoryReclassificationError
} from "./classifier";

const governed = vi.hoisted(() => vi.fn());
vi.mock("../execution", async (importOriginal) => ({
  ...await importOriginal<typeof import("../execution")>(),
  executeGovernedMemoryStructuredOutput: governed
}));

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

  it("allows safe relationship context with the existing sensitive normalization", () => {
    expect(decodeMemoryReclassificationDecision({
      category: "sensitive",
      reason_code: "private_personal",
      response_preference: false,
      sensitivity: "SENSITIVE",
      subject_scope: "USER_RELATIONSHIP_CONTEXT",
      storage_decision: "ALLOW"
    })).toMatchObject({
      subjectScope: "USER_RELATIONSHIP_CONTEXT",
      sensitivity: "NORMAL",
      storageDecision: "ALLOW"
    });
  });

  it("keeps the statement quoted in a bounded strict request", () => {
    const request = buildMemoryReclassificationRequest("Я люблю чай", "AUTOMATIC");
    expect(request.name).toBe("memory_safety_reclassification_v1");
    expect(request.schema).toMatchObject({ additionalProperties: false });
    expect(request.userPrompt).toContain("Я люблю чай");
    expect(request.userPrompt).toContain("AUTOMATIC");
    expect(request.systemPrompt).toContain("otherwise storable first-party personal fact");
    expect(request.systemPrompt).toContain("direct user-authored USER_RELATIONSHIP_CONTEXT");
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
      policyVersion: "memory-safety-policy-v3:7",
      providerId: "openai"
    });
  });

  it("opts in to bounded validation retries on the job's next durable ordinal", async () => {
    const highest = [1, 4];
    const aggregate = vi.fn(async () => ({ _max: { ordinal: highest.shift() ?? null } }));
    governed.mockImplementation(async (call: {
      ordinal: number;
      validationRetry: { allocateOrdinal(attempt: number): Promise<number>; maxAttempts: number };
    }) => {
      expect(call.ordinal).toBe(4);
      expect(call.validationRetry.maxAttempts).toBe(3);
      await expect(call.validationRetry.allocateOrdinal(1)).resolves.toBe(5);
      throw new Error("provider_unavailable");
    });
    await expect(createPrismaMemoryReclassificationProvider(
      { memoryExecutionBinding: { aggregate } } as unknown as PrismaClient,
      { provider: { run: vi.fn() } }
    ).classify("Synthetic statement.", undefined, "EXPLICIT", { jobId: "job-1", ordinal: 4, userId: "owner-1" }))
      .rejects.toEqual(new MemoryReclassificationError("memory_reclassification_unavailable"));
    expect(governed).toHaveBeenCalledOnce();
  });
});
