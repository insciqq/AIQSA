import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStructuredOutputRequest } from "../../providers/structuredOutput";
import { memorySha256 } from "../persistence/lexical";
import type { MemoryHistoryPreparedRound } from "./contract";
import { createPrismaMemoryContextualKeyGenerator } from "./contextualKeys";
import {
  applyMemoryRecallRoundContextualKeysWithDiagnostics,
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  MEMORY_RECALL_ROUND_PROJECTION_VERSION
} from "./rounds";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "./sourceProjection";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../execution", async (importOriginal) => ({
  ...await importOriginal<typeof import("../execution")>(),
  executeGovernedMemoryStructuredOutput: execute
}));

function round(text: string, languageCode: string): MemoryHistoryPreparedRound {
  const rawSafeText = "User: " + text;
  return {
    approxTokens: 32,
    branchGeneration: 1,
    chatId: "private-contextual-chat",
    contextualKeyPolicyVersion: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
    contextualKeyState: "RAW_FALLBACK",
    contextualNarrativeText: rawSafeText,
    contextualSearchHash: memorySha256(rawSafeText),
    contextualSearchText: rawSafeText,
    contentHash: memorySha256(rawSafeText),
    evidenceRootHash: "e".repeat(64),
    folderId: null,
    groupId: "private-contextual-group",
    groupKind: "STANDALONE",
    id: "private-contextual-round",
    languageCode,
    messageJoins: [],
    occurredFrom: "2026-09-01T12:00:00.000Z",
    occurredTo: "2026-09-01T12:00:00.000Z",
    ordinal: 0,
    parentChunkId: "private-contextual-chunk",
    projectionVersion: MEMORY_RECALL_ROUND_PROJECTION_VERSION,
    publicationState: "ACTIVE",
    rawSafeText,
    redactionReasonCodes: [],
    redactionState: "NOT_NEEDED",
    safetyClass: "NORMAL",
    sourceAssistantId: null,
    sourceContentHash: "c".repeat(64),
    sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
    sourceRevision: 1,
    supportingRoundIds: [],
    userId: "private-contextual-owner"
  };
}

async function generate(
  source: MemoryHistoryPreparedRound,
  statement: string,
  support: "SUPPORTED" | "UNSUPPORTED" | "UNCERTAIN",
  review?: Readonly<{ error?: Error; output?: unknown }>
) {
  execute.mockImplementation(async (input: {
    decode(value: unknown): unknown;
    ordinal: number;
    request: ProviderStructuredOutputRequest;
  }) => {
    if (input.request.name === "memory_contextual_grounding_v1" && review?.error) {
      throw review.error;
    }
    const response = input.request.name === "memory_contextual_grounding_v1"
      ? review?.output ?? { decisions: [{ handle: "s0", support }] }
      : {
        rounds: [{
          handle: "r0",
          language_code: source.languageCode,
          statements: [{ source_refs: ["r0c"], text: statement }]
        }]
      };
    const value = input.decode(response);
    return {
      acceptedOutputHash: memorySha256(value),
      bindingId: "execution-" + input.ordinal,
      value
    };
  });
  const client = {
    memoryExecutionBinding: {
      aggregate: vi.fn(async () => ({ _max: { ordinal: null } }))
    }
  } as unknown as PrismaClient;
  return createPrismaMemoryContextualKeyGenerator(client).generate(
    [source],
    [source.id],
    {
      jobId: "private-contextual-job",
      signal: new AbortController().signal,
      userId: source.userId
    }
  );
}

describe("contextual Memory semantic grounding", () => {
  beforeEach(() => { execute.mockReset(); });

  it.each([
    ["en", "I prefer tea.", "My preference is tea."],
    ["fr", "Je préfère le thé.", "Le thé est ma préférence."],
    ["ja", "私は紅茶を好みます。", "紅茶が好みです。"],
    ["ar", "أفضل الشاي.", "الشاي هو ما أفضله."],
    ["hi", "मुझे चाय पसंद है।", "चाय मेरी पसंद है।"]
  ])("accepts a semantically supported %s paraphrase", async (
    languageCode, text, statement
  ) => {
    const source = round(text, languageCode);
    const generated = await generate(source, statement, "SUPPORTED");
    const applied = applyMemoryRecallRoundContextualKeysWithDiagnostics(
      [source], generated.outputs, generated.policyVersion
    );

    expect(applied.rounds[0]).toMatchObject({
      contextualKeyState: "GENERATED",
      contextualNarrativeText: statement,
      rawSafeText: source.rawSafeText
    });
    expect(applied.fallbackDiagnostics).toEqual([]);
    expect(generated.providerRequests).toBe(2);
    expect(generated.executions).toHaveLength(2);
    const request = execute.mock.calls[1]![0].request as ProviderStructuredOutputRequest;
    expect(request.userPrompt).toContain(statement);
    expect(request.userPrompt).toContain(text);
    expect(request.userPrompt).not.toContain(source.id);
    expect(request.userPrompt).not.toContain(source.userId);
  });

  it.each([
    ["en", "I do not prefer tea.", "I prefer tea."],
    ["en", "Nia met Omar, but only Omar prefers tea.", "Nia prefers tea."],
    ["fr", "Le thé ne me plaît pas.", "Le thé me plaît."],
    ["en", "Mina chose 2 seats and Nora chose 4 seats.", "Mina chose 4 seats."]
  ])("rejects a contradicted %s statement even with copied vocabulary", async (
    languageCode, text, statement
  ) => {
    const source = round(text, languageCode);
    const generated = await generate(source, statement, "UNSUPPORTED");
    const applied = applyMemoryRecallRoundContextualKeysWithDiagnostics(
      [source], generated.outputs, generated.policyVersion
    );

    expect(applied.rounds[0]).toEqual(source);
    expect(generated.fallbackRoundIds).toEqual([source.id]);
    expect(generated.outputs).toEqual([]);
    expect(generated.providerRequests).toBe(2);
  });

  it.each([
    [{ error: new Error("upstream unavailable") }, "PROVIDER_UNAVAILABLE"],
    [{ output: { decisions: [] } }, "GROUNDING_INVALID"]
  ] as const)("keeps raw history when review fails %#", async (review, reason) => {
    const source = round("I prefer tea.", "en");
    const generated = await generate(source, "My preference is tea.", "SUPPORTED", review);
    expect(generated.outputs).toEqual([]);
    expect(generated.executions).toHaveLength(1);
    expect(generated.fallbackDiagnostics).toEqual([{ reason, roundId: source.id }]);
    expect(generated.providerRequests).toBe(2);
    expect(applyMemoryRecallRoundContextualKeysWithDiagnostics(
      [source], generated.outputs, generated.policyVersion
    ).rounds).toEqual([source]);
  });

  it("rejects unsafe generated text without sending a second request", async () => {
    const source = round("I prefer tea.", "en");
    const generated = await generate(source, "sk-" + "a".repeat(40), "SUPPORTED");
    expect(generated.outputs).toEqual([]);
    expect(generated.executions).toEqual([]);
    expect(generated.providerRequests).toBe(1);
    expect(generated.fallbackDiagnostics).toEqual([{
      reason: "SAFETY_REDACTED_OR_REJECTED", roundId: source.id
    }]);
  });

  it("preserves complete copied evidence without another model call", async () => {
    const source = round("I do not prefer tea.", "en");
    const generated = await generate(source, source.rawSafeText, "SUPPORTED");
    expect(generated.providerRequests).toBe(1);
    expect(generated.executions).toHaveLength(1);
    expect(applyMemoryRecallRoundContextualKeysWithDiagnostics(
      [source], generated.outputs, generated.policyVersion
    ).rounds[0]).toMatchObject({
      contextualKeyState: "GENERATED", contextualNarrativeText: source.rawSafeText
    });
  });

  it("rejects a changed source or proposal at final projection", async () => {
    const source = round("I prefer tea.", "en");
    const generated = await generate(source, "My preference is tea.", "SUPPORTED");
    const changedSource = { ...source, rawSafeText: "User: I do not prefer tea." };
    const sourceResult = applyMemoryRecallRoundContextualKeysWithDiagnostics(
      [changedSource], generated.outputs, generated.policyVersion
    );
    expect(sourceResult.rounds).toEqual([changedSource]);
    expect(sourceResult.fallbackDiagnostics).toContainEqual({
      reason: "GROUNDING_INVALID", roundId: source.id
    });
    const changedOutput = { ...generated.outputs[0]!, statements: [{
      sourceRoundIds: [source.id], text: "My preference is coffee."
    }] };
    const proposalResult = applyMemoryRecallRoundContextualKeysWithDiagnostics(
      [source], [changedOutput], generated.policyVersion
    );
    expect(proposalResult.rounds).toEqual([source]);
    expect(proposalResult.fallbackDiagnostics).toContainEqual({
      reason: "GROUNDING_INVALID", roundId: source.id
    });
  });
});
