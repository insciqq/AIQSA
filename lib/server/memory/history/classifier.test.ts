import { describe, expect, it, vi } from "vitest";
import type { SystemModelRoleResolution } from "../../providerRuntime/systemModelRole";
import {
  buildMemoryHistoryClassificationRequest,
  createMemoryHistorySafetyClassifier,
  decodeMemoryHistoryClassifications,
  MemoryHistoryClassificationError
} from "./classifier";

function resolution(): SystemModelRoleResolution {
  return {
    credentialScope: "installation",
    ok: true,
    policyVersion: 9,
    providerModelId: "system-model",
    reasoningEffort: "low",
    role: {
      modelConfiguration: {
        capabilities: { structuredOutput: true }
      }
    }
  } as unknown as SystemModelRoleResolution;
}

describe("Memory history System Model safety classifier", () => {
  it("uses opaque handles and a forced strict batch schema", () => {
    const built = buildMemoryHistoryClassificationRequest([{
      id: "private-database-id",
      safeProjectedText: "Мои медицинские данные относятся к прошлому разговору."
    }], "low");

    expect(built.handles).toEqual(["h0"]);
    expect(built.request).toMatchObject({
      name: "memory_history_safety_classification_v1",
      reasoningEffort: "low",
      schema: {
        additionalProperties: false,
        properties: {
          decisions: { maxItems: 1, minItems: 1, type: "array" }
        },
        type: "object"
      }
    });
    expect(built.request.userPrompt).not.toContain("private-database-id");
    expect(built.request.userPrompt).toContain("h0");
    expect(built.request.systemPrompt).toContain("across languages");
  });

  it("rejects missing, reordered, or inconsistent decisions", () => {
    const chunks = [{ id: "chunk-1" }, { id: "chunk-2" }];
    const handles = ["h0", "h1"];
    expect(() => decodeMemoryHistoryClassifications({
      decisions: [
        { handle: "h1", reason_code: "ordinary", sensitivity: "NORMAL" },
        { handle: "h0", reason_code: "ordinary", sensitivity: "NORMAL" }
      ]
    }, chunks, handles)).toThrowError(new MemoryHistoryClassificationError(
      "memory_history_classification_invalid"
    ));
    expect(() => decodeMemoryHistoryClassifications({
      decisions: [
        { handle: "h0", reason_code: "ordinary", sensitivity: "SECRET" },
        { handle: "h1", reason_code: "ordinary", sensitivity: "NORMAL" }
      ]
    }, chunks, handles)).toThrowError(new MemoryHistoryClassificationError(
      "memory_history_classification_invalid"
    ));
  });

  it("classifies a bounded sequence in batches and rejoins exact chunk identities", async () => {
    const executeStructuredOutput = vi.fn(async (_role, request) => {
      const payload = JSON.parse(request.userPrompt) as {
        chunks: Array<{ handle: string }>;
      };
      return {
        decisions: payload.chunks.map(({ handle }, index) => ({
          handle,
          reason_code: index === 0 ? "sensitive_personal" : "ordinary",
          sensitivity: index === 0 ? "SENSITIVE" : "NORMAL"
        }))
      };
    });
    const resolveSystemModel = vi.fn(async () => resolution());
    const classifier = createMemoryHistorySafetyClassifier({
      executeStructuredOutput,
      resolveSystemModel
    });
    const chunks = Array.from({ length: 13 }, (_, index) => ({
      id: `chunk-${index}`,
      safeProjectedText: `Past chat ${index}`
    }));

    const result = await classifier.classify(chunks);

    expect(resolveSystemModel).toHaveBeenCalledTimes(1);
    expect(executeStructuredOutput).toHaveBeenCalledTimes(2);
    expect(result.policyVersion).toBe("memory-history-safety-policy-v2:system-9");
    expect(result.decisions).toHaveLength(13);
    expect(result.decisions[0]).toEqual({
      chunkId: "chunk-0",
      sensitivity: "NORMAL"
    });
    expect(result.decisions[12]).toEqual({
      chunkId: "chunk-12",
      sensitivity: "NORMAL"
    });
  });

  it("fails closed when the System Model is unavailable", async () => {
    const classifier = createMemoryHistorySafetyClassifier({
      executeStructuredOutput: vi.fn(),
      resolveSystemModel: async () => ({ code: "system_model_absent", ok: false })
    });
    await expect(classifier.classify([{
      id: "chunk-1",
      safeProjectedText: "ordinary"
    }])).rejects.toEqual(new MemoryHistoryClassificationError(
      "memory_history_classification_unavailable"
    ));
  });
});
