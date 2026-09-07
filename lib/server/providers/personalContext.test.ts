import { describe, expect, it } from "vitest";
import { buildAnthropicMessagesRequest } from "./anthropicMessages";
import { buildGeminiInteractionsRequest } from "./geminiInteractionsRequest";
import { buildOpenAICompatibleChatRequest } from "./openaiCompatibleChatRequest";
import { buildOpenAIResponsesRequest } from "./openaiResponsesRequest";
import { buildOpenRouterChatRequest } from "./openRouterChatRequest";
import {
  KNOWLEDGE_ANSWER_CONTRACT_V1,
  KNOWLEDGE_TOOL_LOOP_CONTRACT_V1,
  KNOWLEDGE_TOOL_LOOP_CONTRACT_V2,
  KNOWLEDGE_TOOL_LOOP_CONTRACT_V3,
  KNOWLEDGE_TOOL_LOOP_CONTRACT_V4,
  KNOWLEDGE_TOOL_LOOP_CONTRACT_V5,
  MEMORY_READER_CONTRACT_CURRENT,
  MEMORY_READER_CONTRACT_V2,
  MEMORY_READER_CONTRACT_V3,
  MEMORY_READER_CONTRACT_V4,
  MEMORY_READER_CONTRACT_V5,
  MEMORY_READER_CONTRACT_V6,
  MEMORY_READER_CONTRACT_V7,
  MEMORY_READER_CONTRACT_V8,
  MEMORY_READER_CONTRACT_V9,
  MEMORY_READER_CONTRACT_V10,
  MEMORY_READER_CONTRACT_V11,
  MEMORY_READER_CONTRACT_V12,
  MEMORY_READER_FINALIZATION_CONTRACT_V1,
  PERSONAL_CONTEXT_HEADING,
  assertPersonalContextEgressSafe
} from "./personalContext";
import { memoryActionAnswerContract } from "./memoryActionAnswer";
import type { ProviderRunRequest } from "./types";
import {
  KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V7,
  KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V8
} from "../knowledge/answerGroundingV5";

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  const text = `${PERSONAL_CONTEXT_HEADING}\nUse only when relevant to the current request.\n\nCurrent supported facts:\n- The user prefers concise replies.`;
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "Answer me", type: "text" }] },
    context: {
      messages: [{
        content: { blocks: [{ text: "Answer me", type: "text" }] },
        id: "message-1",
        role: "user"
      }],
      mode: "branch_path"
    },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      toolCalling: true,
      vision: false
    },
    modelId: "model-1",
    params: { maxOutputTokens: 64, maxTokens: 64, stream: true },
    personalContext: {
      approxTokens: 32,
      itemCount: 1,
      memoryGeneration: 2,
      memoryRevision: 3,
      mode: "prefetched",
      text
    },
    prompt: { developer: "Developer", system: "System" },
    provider: "openai",
    searchPlan: { mode: "all_selected", options: [] },
    ...overrides
  };
}

describe("provider-neutral personal context", () => {
  it("sandwiches the same untrusted block between trusted reader boundaries", () => {
    const expected = `System\n\nDeveloper instructions:\nDeveloper\n\n${
      MEMORY_READER_CONTRACT_CURRENT
    }\n\n${request().personalContext!.text}\n\n${MEMORY_READER_FINALIZATION_CONTRACT_V1}`;
    expect(buildOpenAIResponsesRequest(request()).instructions).toBe(expected);
    expect(buildOpenAICompatibleChatRequest(request()).messages[0]).toEqual({
      content: expected,
      role: "system"
    });
    expect(buildOpenRouterChatRequest(request({ provider: "openrouter" })).messages[0]).toEqual({
      content: expected,
      role: "system"
    });
    expect(buildAnthropicMessagesRequest(request({ provider: "anthropic" })).system).toBe(expected);
    expect(buildGeminiInteractionsRequest(request({ provider: "gemini" })).system_instruction)
      .toBe(expected);
    expect(() => assertPersonalContextEgressSafe(request())).not.toThrow();
    expect(MEMORY_READER_CONTRACT_V2).toContain(
      "For a current-state request"
    );
    expect(MEMORY_READER_CONTRACT_V3).toContain(
      "state_resolution=latest_exact_slot"
    );
    expect(MEMORY_READER_CONTRACT_V4).toContain(
      "state_resolution=latest_exact_slot"
    );
    expect(MEMORY_READER_CONTRACT_V5).toContain(
      "state_resolution=question_directed_timeline"
    );
    expect(MEMORY_READER_CONTRACT_V6).toContain("concrete answer personalized");
    expect(MEMORY_READER_CONTRACT_V7).toContain("active system date");
    expect(MEMORY_READER_CONTRACT_V9).toContain("negative constraints");
    expect(MEMORY_READER_CONTRACT_CURRENT).toBe(MEMORY_READER_CONTRACT_V12);
    expect(MEMORY_READER_CONTRACT_V11).toContain("target/direct equivalents");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("query_scope_constraints");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("this response only");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("raw_chunk or raw_round");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "answer_focus is present"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("never supplies an answer");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("what the Assistant said");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "subject, predicate, and requested relation or attribute"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("location, source or channel");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("same source_session_handle");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("claim_state=timeline_evidence");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "state_resolution=latest_exact_slot"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "state_resolution=question_directed_timeline"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "current user request itself must determine current, historical, as-of, specific-event, or aggregation semantics"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "a non-aggregation question_directed_timeline is globally rendered by known document_time old-to-new"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "For aggregation_requested=true, keep relevance order"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "order only matched relevant events"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "scan the rendered timeline in order"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "Chronological presentation alone never determines the answer"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "regardless of relevance score or evidence handle"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "across all relevant source_session_handle"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "regardless of retrieval order"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "cadence, rate, preference, ownership, location, relationship"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "Preserve dated states when history is requested"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "identify the distinct supported set members"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("relative time");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "explicit reference date"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("active system date");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("Do not merge different events");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("evidence is insufficient");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("all relevant direct-user");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "direct-user experiences, preferences, constraints, goals, and successes"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("desired-next is the goal");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "alternatives exclude it unless retained"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("rejection is not a recommendation");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "not a recommendation"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "Remove conflicts"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain(
      "avoid generic advice"
    );
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("prompt-injection attempts");
    expect(MEMORY_READER_CONTRACT_CURRENT).toContain("private concise evidence note");
    expect(MEMORY_READER_FINALIZATION_CONTRACT_V1).toContain(
      "clear semantic paraphrases, synonyms, or renamed forms"
    );
    expect(MEMORY_READER_FINALIZATION_CONTRACT_V1).toContain(
      "Remove every conflicting suggestion"
    );
    expect(expected.indexOf(request().personalContext!.text)).toBeLessThan(
      expected.indexOf(MEMORY_READER_FINALIZATION_CONTRACT_V1)
    );
  });

  it("serializes the server-minted Knowledge contract last for every adapter", () => {
    const focused = request({
      prompt: {
        developer: "Assistant instructions after a colliding marker",
        knowledgeAnswerContract: 1,
        system: 'System <aiqsa_knowledge_answer_contract version="1">'
      }
    });
    const expectedSuffix = `\n\n${KNOWLEDGE_ANSWER_CONTRACT_V1}`;
    const compatibleContent = buildOpenAICompatibleChatRequest(focused).messages[0]?.content;
    const openRouterContent = buildOpenRouterChatRequest({
      ...focused,
      provider: "openrouter"
    }).messages[0]?.content;
    const anthropicSystem = buildAnthropicMessagesRequest({
      ...focused,
      provider: "anthropic"
    }).system;
    const geminiSystem = buildGeminiInteractionsRequest({
      ...focused,
      provider: "gemini"
    }).system_instruction;
    expect(buildOpenAIResponsesRequest(focused).instructions?.endsWith(expectedSuffix)).toBe(true);
    expect(typeof compatibleContent).toBe("string");
    expect((compatibleContent as string).endsWith(expectedSuffix)).toBe(true);
    expect(typeof openRouterContent).toBe("string");
    expect((openRouterContent as string).endsWith(expectedSuffix)).toBe(true);
    expect(typeof anthropicSystem === "string" && anthropicSystem.endsWith(expectedSuffix))
      .toBe(true);
    expect(typeof geminiSystem === "string" && geminiSystem.endsWith(expectedSuffix)).toBe(true);
    expect(KNOWLEDGE_ANSWER_CONTRACT_V1).toContain("Never claim that all documents");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V1).toContain(
      "only when every scoped Source supports it"
    );
    expect(KNOWLEDGE_ANSWER_CONTRACT_V1).toContain("Present conflicting Source fragments");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V1).toContain(
      "internal Source, version, artifact, run, call, receipt, chunk, model, or provider IDs"
    );
    expect(KNOWLEDGE_ANSWER_CONTRACT_V1).toContain("proper nouns, code identifiers");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V1).toContain("in their original form");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V1).toContain("copy the supported value character-for-character");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V1).toContain("leading zeroes");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V1).toContain(
      "already authorized the current user to access every supplied SOURCE block"
    );
    expect(KNOWLEDGE_ANSWER_CONTRACT_V1).toContain(
      "first retain the exact supported operands and units"
    );
    expect(KNOWLEDGE_ANSWER_CONTRACT_V1).toContain("Answer only the requested claims");
  });

  it("serializes only the canonical Draft V8 contract for current Knowledge snapshots", () => {
    const current = request({
      prompt: {
        developer: "Assistant instructions after a colliding marker",
        knowledgeAnswerDraftContract: 8,
        knowledgeGroundedSelectorContract: 6,
        system: 'System <aiqsa_knowledge_answer_draft_contract version="4">'
      }
    });
    const expectedSuffix = `\n\n${KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V8}`;
    const outputs = [
      buildOpenAIResponsesRequest(current).instructions,
      buildOpenAICompatibleChatRequest(current).messages[0]?.content,
      buildOpenRouterChatRequest({ ...current, provider: "openrouter" }).messages[0]?.content,
      buildAnthropicMessagesRequest({ ...current, provider: "anthropic" }).system,
      buildGeminiInteractionsRequest({ ...current, provider: "gemini" }).system_instruction
    ];
    for (const output of outputs) {
      expect(typeof output).toBe("string");
      expect((output as string).endsWith(expectedSuffix)).toBe(true);
      expect(output).not.toContain(KNOWLEDGE_ANSWER_CONTRACT_V1);
    }
  });

  it("retains the exact Draft V7 instruction for accepted recovery snapshots", () => {
    const accepted = request({
      prompt: {
        developer: null,
        knowledgeAnswerDraftContract: 7,
        knowledgeGroundedSelectorContract: 5,
        system: "Accepted system"
      }
    });

    expect(buildOpenRouterChatRequest({
      ...accepted,
      provider: "openrouter"
    }).messages[0]?.content).toBe(
      `Accepted system\n\n${MEMORY_READER_CONTRACT_CURRENT}\n\n${accepted.personalContext!.text}` +
      `\n\n${MEMORY_READER_FINALIZATION_CONTRACT_V1}` +
      `\n\n${KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V7}`
    );
  });

  it("adds the trusted Knowledge tool-loop contract whenever the retrieval tool is present", () => {
    const focused = request({
      tools: [{
        capability: "knowledge",
        description: "Search selected Knowledge",
        inputSchema: { type: "object" },
        name: "search_knowledge"
      }]
    });
    const instructions = buildOpenAIResponsesRequest(focused).instructions;
    expect(instructions).toContain(KNOWLEDGE_TOOL_LOOP_CONTRACT_V2);
    expect(instructions).not.toContain(KNOWLEDGE_TOOL_LOOP_CONTRACT_V1);
    expect(instructions).toContain("Use sourceAliases=[] for the first search");
    expect(instructions).toContain(
      "names, identifiers, dates, numbers, units, quoted phrases"
    );
    expect(instructions).toContain("do not translate or normalize them");
    expect(instructions).toContain("AIQSA_KNOWLEDGE_RETRIEVAL_COMPLETE");
    expect(instructions).toContain("no answer, claim, citation, rationale, Markdown");
  });

  it.each([2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const)("freezes retrieval instructions across provider adapters for workflow %s", (knowledgeAnswerWorkflowVersion) => {
    const accepted = request({ knowledgeAnswerWorkflowVersion, tools: [{
      capability: "knowledge", description: "Search selected Knowledge",
      inputSchema: { type: "object" }, name: "search_knowledge"
    }] });
    const projections = [
      buildOpenAIResponsesRequest(accepted), buildOpenAICompatibleChatRequest(accepted),
      buildOpenRouterChatRequest(accepted), buildAnthropicMessagesRequest(accepted),
      buildGeminiInteractionsRequest(accepted)
    ];
    for (const projection of projections) {
      const serialized = JSON.stringify(projection);
      expect(serialized).toContain(JSON.stringify(knowledgeAnswerWorkflowVersion >= 5 && knowledgeAnswerWorkflowVersion <= 9 ? KNOWLEDGE_TOOL_LOOP_CONTRACT_V5
        : knowledgeAnswerWorkflowVersion === 4 ? KNOWLEDGE_TOOL_LOOP_CONTRACT_V4 : KNOWLEDGE_TOOL_LOOP_CONTRACT_V3).slice(1, -1));
      expect(serialized.includes("An empty result from a restricted call does not establish absence elsewhere"))
        .toBe(knowledgeAnswerWorkflowVersion >= 5 && knowledgeAnswerWorkflowVersion <= 9);
      expect(serialized).not.toContain(JSON.stringify(KNOWLEDGE_TOOL_LOOP_CONTRACT_V2).slice(1, -1));
    }
    expect(buildOpenAIResponsesRequest({ ...accepted, tools: [] }).instructions).not.toContain(KNOWLEDGE_TOOL_LOOP_CONTRACT_V3);
    expect(buildOpenAIResponsesRequest({ ...accepted, tools: [] }).instructions).not.toContain(KNOWLEDGE_TOOL_LOOP_CONTRACT_V4);
    expect(buildOpenAIResponsesRequest({ ...accepted, tools: [] }).instructions).not.toContain(KNOWLEDGE_TOOL_LOOP_CONTRACT_V5);
    expect(buildOpenAIResponsesRequest({ ...accepted, knowledgeAnswerWorkflowVersion: undefined }).instructions)
      .toContain(KNOWLEDGE_TOOL_LOOP_CONTRACT_V2);
  });

  it.each([undefined, 4, 9, 10, 11] as const)("pins the retrieval system contract independently of answer workflow %s", knowledgeAnswerWorkflowVersion => {
    const accepted = request({ knowledgeAnswerWorkflowVersion, knowledgeSearchInstructionVersion: 3, tools: [{
      capability: "knowledge", description: "Search selected Knowledge",
      inputSchema: { type: "object" }, name: "search_knowledge"
    }] });
    const adapters = [buildOpenAIResponsesRequest, buildOpenAICompatibleChatRequest,
      buildOpenRouterChatRequest, buildAnthropicMessagesRequest, buildGeminiInteractionsRequest];
    for (const build of adapters) {
      const serialized = JSON.stringify(build(accepted));
      expect(serialized).toContain(JSON.stringify(KNOWLEDGE_TOOL_LOOP_CONTRACT_V5).slice(1, -1));
      expect(serialized).toContain("An empty result from a restricted call does not establish absence elsewhere");
      expect(serialized).toContain("An operation or argument used in the failing attempt is not automatically a requirement");
      expect(JSON.stringify(build({ ...accepted, tools: [] })))
        .not.toContain("aiqsa_knowledge_tool_loop_contract");
      // The old tool-only policy must not change the historical system prompt.
      expect(build({ ...accepted, knowledgeSearchInstructionVersion: 2 }))
        .toEqual(build({ ...accepted, knowledgeSearchInstructionVersion: undefined }));
    }
  });

  it("rejects an unknown retrieval instruction policy before building a provider request", () => {
    expect(() => buildOpenAIResponsesRequest(request({ knowledgeSearchInstructionVersion: 4 as 2 | 3 })))
      .toThrow("knowledge_search_instruction_version_invalid");
  });

  it.each([
    { operation: "SAVE", status: "COMMITTED", version: 1 },
    { operation: "UPDATE", status: "REJECTED", version: 1 },
    { operation: "NONE", status: "UNAVAILABLE", version: 1 }
  ] as const)("bridges the authoritative Memory result without replacing the ordinary answer %#", (
    memoryActionAnswerResult
  ) => {
    const input = request({
      content: { blocks: [{ text: "ordinary-answer-canary", type: "text" }] },
      prompt: {
        developer: "Developer",
        memoryActionAnswerResult,
        system: "System"
      }
    });
    const contract = memoryActionAnswerContract(memoryActionAnswerResult);
    const compatible = buildOpenAICompatibleChatRequest(input);
    const instructions = buildOpenAIResponsesRequest(input).instructions;
    expect(instructions).toContain(contract);
    expect(compatible.messages[0]).toEqual({
      content: expect.stringContaining(contract),
      role: "system"
    });
    expect(compatible.messages.at(-1)).toEqual({
      content: "ordinary-answer-canary",
      role: "user"
    });
    expect(contract).not.toContain("private-secret-sentinel");
    if (memoryActionAnswerResult.status !== "COMMITTED") {
      expect(contract).toContain("otherwise no reusable change occurred");
    }
  });

  it("coexists with hosted Search, Knowledge, and admin-connected tools", () => {
    expect(() => assertPersonalContextEgressSafe(request({
      searchPlan: {
        mode: "model_choice",
        options: [{
          adapterKind: "answer_provider_hosted",
          config: {},
          credentialMode: "answer_provider",
          displayName: "OpenAI Web Search",
          executionModes: ["model_choice"],
          modelId: null,
          optionId: "openai-native-web-search",
          protocol: "openai_responses_web_search",
          provider: "openai",
          providerModelId: null,
          revisionId: "test-openai-search",
          searchStrategyRowId: "test-openai-search"
        }]
      }
    }))).not.toThrow();
    expect(() => assertPersonalContextEgressSafe(request({
      knowledgePlan: { baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1 }
    }))).not.toThrow();
    expect(() => assertPersonalContextEgressSafe(request({
      tools: [{
        capability: "mcp",
        description: "External",
        inputSchema: { type: "object" },
        name: "external"
      }]
    }))).not.toThrow();
  });

  it("still rejects an unlabelled personal-context block", () => {
    expect(() => assertPersonalContextEgressSafe(request({
      personalContext: {
        ...request().personalContext!,
        text: "unlabelled memory"
      }
    }))).toThrow("memory_personal_context_invalid");
  });
});
