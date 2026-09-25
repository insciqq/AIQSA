import { workspaceImageTokenReserve } from "../workspace/directImageEvidence";
import {
  applyContextBudget,
  calculateContextBudgetLimits,
  estimateApproxTokens,
  type ContextTruncationSummary
} from "../../domain/contextBudget";
import { maxOutputTokensFromParams } from "../../domain/providerParams";
import { takeUtf16SafePrefix } from "../../domain/utf16";
import {
  usesNativePdfInput,
  providerAttachmentBudgetTokens,
  providerAttachmentTextLabel,
  truncateProviderAttachmentText
} from "../providers/attachmentPayload";
import {
  KNOWLEDGE_ANSWER_CONTRACT_V1,
  KNOWLEDGE_TOOL_LOOP_CONTRACT_V2,
  MEMORY_READER_CONTRACT_CURRENT,
  MEMORY_READER_FINALIZATION_CONTRACT_V1,
  knowledgeToolLoopContract
} from "../providers/personalContext";
import { memoryActionAnswerContract } from "../providers/memoryActionAnswer";
import {
  KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V7,
  KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V8
} from "../knowledge/answerGroundingV5";
import type {
  NormalizedRunRequest,
  ProviderConversationMessage,
  ProviderModelCapabilities,
  ProviderRunRequest
} from "../providers/types";
import type { ProviderToolBridge } from "../tools/types";
import type { SessionContextStatus } from "../../contracts/sessionStatus";
import { getAttachmentTextConfig } from "../uploads/attachmentTextConfig";
import type { SkillBudgetFacts } from "../../contracts/skills";
import type { ContextObservation } from "./contextCompactionContract";
import {
  contextCompactionMeasurementWithBudget,
  contextHistory,
  planContextCompaction,
  type ContextCompactionPlan,
  type ContextOverflow
} from "./contextCompactionPlanner";

// Matches the former 20,000-character ASCII ceiling under the shared
// estimator, but applies once across every selected text attachment and is
// therefore conservative for multilingual text and multi-file requests.
export const UNKNOWN_CONTEXT_ATTACHMENT_TEXT_BUDGET_TOKENS = 5_000;

function knowledgeAnswerDraftContractText(version: 7 | 8 | undefined): string | null {
  return version === 8
    ? KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V8
    : version === 7
      ? KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V7
      : null;
}

function maxOutputTokensForBudget(
  params: Readonly<Record<string, unknown>>,
  capabilities: ProviderModelCapabilities,
  provider: string
): number {
  let selectedMaxOutputTokens = capabilities.defaultMaxOutputTokens ?? 0;

  const requestedMaxOutputTokens = maxOutputTokensFromParams(params);
  if (requestedMaxOutputTokens !== undefined) {
    selectedMaxOutputTokens = Math.floor(requestedMaxOutputTokens);
  }

  if (
    provider === "fake" &&
    typeof capabilities.contextWindow === "number" &&
    capabilities.contextWindow > 0 &&
    selectedMaxOutputTokens >= capabilities.contextWindow
  ) {
    return 0;
  }

  return selectedMaxOutputTokens;
}

export type RunContextBudgetResult =
  | Readonly<{
      context: NonNullable<NormalizedRunRequest["context"]>;
      contextTruncation: ContextTruncationSummary | null;
      ok: true;
    }>
  | Readonly<{
      error: Readonly<{
        code: "context_too_large";
        message: string;
      }>;
      ok: false;
      status: 400;
    }>;

function contextBudgetPrompt(prompt: NormalizedRunRequest["prompt"]) {
  return {
    developer: [
      prompt.developer,
      // Fixed request overhead, never a trimmable conversation turn. Its wire
      // role remains user; adapters append it after the current attachments.
      prompt.responseReminder ? `Response reminder:\n${prompt.responseReminder}` : null,
      prompt.memoryActionAnswerResult ? memoryActionAnswerContract(prompt.memoryActionAnswerResult) : null,
      prompt.knowledgeAnswerContract === 1 ? KNOWLEDGE_ANSWER_CONTRACT_V1 : null,
      knowledgeAnswerDraftContractText(prompt.knowledgeAnswerDraftContract)
    ].filter((value): value is string => Boolean(value?.trim())).join("\n\n") || null,
    system: [prompt.system, prompt.personalInstructions].filter(Boolean).join("\n\n") || null
  };
}

export function applyRunContextBudget(input: Readonly<{
  contextMessages: ProviderConversationMessage[];
  messageExtraTokens?: Record<string, number>;
  modelCapabilities: ProviderModelCapabilities;
  params: Readonly<Record<string, unknown>>;
  prompt: NormalizedRunRequest["prompt"];
  provider: string;
}>): RunContextBudgetResult {
  const internalContextMessages = input.contextMessages.filter(
    (message) => message.purpose !== undefined
  );
  const budgetMessages = input.contextMessages.filter(
    (message) => message.purpose === undefined
  );
  const currentMessage = budgetMessages.at(-1);
  const internalContextTokens = internalContextMessages.reduce((total, message) => {
    const extra = input.messageExtraTokens?.[message.id] ?? 0;
    return total + estimateApproxTokens(message.content) +
      (Number.isFinite(extra) && extra > 0 ? Math.ceil(extra) : 0);
  }, 0);
  const messageExtraTokens = currentMessage && internalContextTokens > 0
    ? {
        ...input.messageExtraTokens,
        [currentMessage.id]:
          (Number.isFinite(input.messageExtraTokens?.[currentMessage.id]) &&
          (input.messageExtraTokens?.[currentMessage.id] ?? 0) > 0
            ? Math.ceil(input.messageExtraTokens![currentMessage.id]!)
            : 0) + internalContextTokens
      }
    : input.messageExtraTokens;
  const budget = applyContextBudget({
    contextWindow: input.modelCapabilities.contextWindow ?? 0,
    maxOutputTokens: maxOutputTokensForBudget(input.params, input.modelCapabilities, input.provider),
    messageExtraTokens,
    messages: budgetMessages,
    prompt: contextBudgetPrompt(input.prompt)
  });

  if (!budget.ok) {
    return {
      error: {
        code: "context_too_large",
        message: internalContextMessages.length > 0
          ? `Prompt, selected private context, and current message exceed the model context budget (${budget.budgetTokens} estimated tokens available). Reduce selected context or choose a model with a larger context window.`
          : `Prompt and current message exceed the model context budget (${budget.budgetTokens} estimated tokens available).`
      },
      ok: false,
      status: 400
    };
  }

  const messages = internalContextMessages.length > 0 && budget.messages.length > 0
    ? [
        ...budget.messages.slice(0, -1),
        ...internalContextMessages,
        budget.messages.at(-1)!
      ]
    : budget.messages;
  const truncation = budget.truncation
    ? {
        ...budget.truncation,
        keptMessages: budget.truncation.keptMessages + internalContextMessages.length
      }
    : null;
  const context: NonNullable<NormalizedRunRequest["context"]> = {
    messages,
    mode: "branch_path"
  };

  if (truncation) {
    context.summary = {
      truncation
    };
  }

  return {
    context,
    contextTruncation: truncation,
    ok: true
  };
}

/** Returns the bounded room for a future Personal Memory block after the
 * admitted model's output reserve, safety margin, trusted prompt, current
 * message, and non-droppable internal context. Provider-specific attachments
 * and serialized tools remain subject to the final exact request budget. */
export function normalizedRequestPersonalContextTokenLimit(
  request: NormalizedRunRequest
): number | null {
  const contextWindow = request.modelCapabilities.contextWindow;
  if (!Number.isFinite(contextWindow) || Number(contextWindow) <= 0) return null;
  const limits = calculateContextBudgetLimits({
    contextWindow: Number(contextWindow),
    maxOutputTokens: maxOutputTokensForBudget(
      request.params,
      request.modelCapabilities,
      request.provider
    ),
    provider: request.provider
  });
  const promptTokens = estimateApproxTokens(request.prompt.system ?? "") +
    estimateApproxTokens(request.prompt.developer ?? "") +
    estimateApproxTokens(MEMORY_READER_CONTRACT_CURRENT) +
    estimateApproxTokens(MEMORY_READER_FINALIZATION_CONTRACT_V1) +
    (request.prompt.memoryActionAnswerResult
      ? estimateApproxTokens(memoryActionAnswerContract(
          request.prompt.memoryActionAnswerResult
        ))
      : 0) +
    (request.prompt.knowledgeAnswerContract === 1
      ? estimateApproxTokens(KNOWLEDGE_ANSWER_CONTRACT_V1)
      : 0) +
    estimateApproxTokens(
      knowledgeAnswerDraftContractText(request.prompt.knowledgeAnswerDraftContract) ?? ""
    ) +
    (request.knowledgePlan.mode !== "none"
      ? estimateApproxTokens(KNOWLEDGE_TOOL_LOOP_CONTRACT_V2)
      : 0);
  const contextMessages = request.context?.messages ?? [];
  const internalTokens = contextMessages
    .filter((message) => message.purpose !== undefined)
    .reduce((total, message) => total + estimateApproxTokens(message.content), 0);
  const currentMessage = contextMessages
    .filter((message) => message.purpose === undefined)
    .at(-1);
  const currentTokens = estimateApproxTokens(currentMessage?.content ?? request.content);
  return Math.max(0, limits.budgetTokens - promptTokens - internalTokens - currentTokens - (request.followupContextReserveTokens ?? 0));
}

function cumulativeTruncationSummary(
  previous: ContextTruncationSummary | undefined,
  current: ContextTruncationSummary
): ContextTruncationSummary {
  if (!previous) return current;
  return {
    ...current,
    approxDroppedTokens: previous.approxDroppedTokens + current.approxDroppedTokens,
    approxOriginalTokens: previous.approxDroppedTokens + current.approxOriginalTokens,
    droppedMessages: previous.droppedMessages + current.droppedMessages
  };
}

export function providerFacingSerializedTools(
  request: ProviderRunRequest,
  bridge?: ProviderToolBridge
): Record<string, unknown>[] {
  if (!bridge) return [];
  return [
    ...(bridge.serializeHostedTools?.(request) ?? []),
    ...(request.tools ?? []).map((tool) => bridge.serializeTool(tool).tool)
  ];
}

function providerRequestFixedExtraTokens(request: ProviderRunRequest, bridge?: ProviderToolBridge): number {
  return (request.followupContextReserveTokens ?? 0) + estimateApproxTokens(providerFacingSerializedTools(request, bridge)) +
    estimateApproxTokens(request.providerToolMessages ?? []) + workspaceImageTokenReserve(request.providerToolMessages) +
    estimateApproxTokens(request.personalContext?.text ?? "") +
    (request.personalContext
      ? estimateApproxTokens(MEMORY_READER_CONTRACT_CURRENT) +
        estimateApproxTokens(MEMORY_READER_FINALIZATION_CONTRACT_V1) : 0) +
    estimateApproxTokens(knowledgeToolLoopContract(request) ?? "");
}

function contextCompactionBudgetLimits(request: ProviderRunRequest) {
  const contextWindow = request.modelCapabilities.contextWindow;
  return Number.isFinite(contextWindow) && Number(contextWindow) > 0
    ? calculateContextBudgetLimits({
        contextWindow: Number(contextWindow),
        maxOutputTokens: maxOutputTokensForBudget(request.params, request.modelCapabilities, request.provider),
        provider: request.provider
      })
    : null;
}

/** Share of the admitted input budget one observed MCP/Workspace result may
 * take whole. A larger result would leave the newest batch, which masking
 * never replaces, irreducible on a small window; it keeps its bounded preview. */
const OBSERVATION_WHOLE_RESULT_BUDGET_SHARE = 0.25;

/** Estimated tokens for that share. An unknown window has no budget that
 * masking could apply, so only the ordinary persisted result bound (Off) applies. */
export function observationWholeResultTokens(request: ProviderRunRequest): number {
  const limits = contextCompactionBudgetLimits(request);
  return limits ? Math.floor(limits.budgetTokens * OBSERVATION_WHOLE_RESULT_BUDGET_SHARE) : Number.POSITIVE_INFINITY;
}

function approximateProviderRequestTokens(request: ProviderRunRequest, bridge?: ProviderToolBridge): number {
  const messages = request.context?.messages;
  const contextTokens = messages?.length
    ? messages.reduce((total, message) => total + estimateApproxTokens(message.content), 0)
    : estimateApproxTokens(request.content);
  const prompt = contextBudgetPrompt(request.prompt);
  return contextTokens + estimateApproxTokens(prompt.system ?? "") + estimateApproxTokens(prompt.developer ?? "") +
    providerRequestFixedExtraTokens(request, bridge) +
    providerAttachmentBudgetTokens({ attachments: request.attachments, modelCapabilities: request.modelCapabilities });
}

type TextAttachmentCandidate = Readonly<{
  index: number;
  labelTokens: number;
  minimumTokens: number;
  source: string;
  sourceTokens: number;
}>;

function clampedProviderAttachments(request: ProviderRunRequest): ProviderRunRequest["attachments"] {
  const operatorMaxChars = getAttachmentTextConfig().extractedTextMaxChars;
  return request.attachments.map((attachment) => ({
    ...attachment,
    extractedText: attachment.extractedText
      ? truncateProviderAttachmentText(attachment.extractedText, operatorMaxChars)
      : null
  }));
}

function textAttachmentCandidates(
  attachments: ProviderRunRequest["attachments"],
  capabilities: ProviderModelCapabilities
): TextAttachmentCandidate[] {
  return attachments.flatMap((attachment, index) => {
    if (!textModeAttachment(attachment, capabilities) || !attachment.extractedText?.trim()) return [];
    return [{
      index,
      labelTokens: estimateApproxTokens(`[${providerAttachmentTextLabel(attachment)}]\n`),
      minimumTokens: estimateApproxTokens(String.fromCodePoint(attachment.extractedText.codePointAt(0)!)),
      source: attachment.extractedText,
      sourceTokens: estimateApproxTokens(attachment.extractedText)
    }];
  });
}

function withoutAttachmentText(request: ProviderRunRequest): ProviderRunRequest {
  return { ...request, attachments: request.attachments.map((attachment) =>
    textModeAttachment(attachment, request.modelCapabilities) ? { ...attachment, extractedText: null } : attachment) };
}

/** Hybrid measures extracted attachment text at its minimum share: the text is
 * elastic and receives only the room left after exact context and history.
 * It cannot by itself trigger masking, a summary purchase, or overflow. */
function hybridRequestTokens(request: ProviderRunRequest, bridge?: ProviderToolBridge): number {
  const text = textAttachmentCandidates(clampedProviderAttachments(request), request.modelCapabilities);
  return approximateProviderRequestTokens(withoutAttachmentText(request), bridge) +
    text.reduce((total, candidate) => total + candidate.labelTokens + candidate.minimumTokens, 0);
}

function usesHybridBudget(request: ProviderRunRequest): boolean {
  return request.contextCompactionPolicy?.mode === "hybrid" && !request.agent &&
    contextCompactionBudgetLimits(request) !== null;
}

function planProviderRequestContext(input: Readonly<{
  bridge?: ProviderToolBridge;
  observations?: readonly ContextObservation[];
  request: ProviderRunRequest;
}>): Readonly<{
  limits: ReturnType<typeof contextCompactionBudgetLimits>;
  planned: ContextCompactionPlan;
}> {
  const limits = contextCompactionBudgetLimits(input.request);
  return {
    limits,
    planned: planContextCompaction({
      ...input,
      assembledTokens: usesHybridBudget(input.request)
        ? hybridRequestTokens(input.request, input.bridge)
        : approximateProviderRequestTokens(input.request, input.bridge),
      budgetTokens: limits?.budgetTokens ?? null
    })
  };
}

/** Reads the same contributors as the budget guard, without changing a request. */
export function measureSessionContext(input: Readonly<{
  answerText?: string;
  bridge?: ProviderToolBridge;
  observations?: readonly ContextObservation[];
  request: ProviderRunRequest;
}>): SessionContextStatus {
  const { limits, planned } = planProviderRequestContext(input);
  const { request } = planned;
  const prompt = contextBudgetPrompt(request.prompt);
  const messages = request.context?.messages;
  const contextTokens = messages?.length
    ? messages.reduce((total, message) => total + estimateApproxTokens(message.content), 0)
    : estimateApproxTokens(request.content);
  const contextWindow = request.modelCapabilities.contextWindow;
  const measuredLimits = limits ?? calculateContextBudgetLimits({
    contextWindow: contextWindow ?? 0,
    maxOutputTokens: maxOutputTokensForBudget(request.params, request.modelCapabilities, request.provider),
    provider: request.provider
  });
  return {
    approximateInputTokens: contextTokens +
      estimateApproxTokens(prompt.system ?? "") + estimateApproxTokens(prompt.developer ?? "") +
      providerRequestFixedExtraTokens(request, input.bridge) +
      providerAttachmentBudgetTokens({ attachments: request.attachments, modelCapabilities: request.modelCapabilities }) +
      estimateApproxTokens(input.answerText ?? ""),
    contextWindow: Number.isFinite(contextWindow) && Number(contextWindow) > 0 ? Math.floor(contextWindow!) : null,
    droppedMessages: request.context?.summary?.truncation?.droppedMessages ?? 0,
    loadedTools: providerFacingSerializedTools(request, input.bridge).length,
    maxOutputTokens: measuredLimits.maxOutputTokens,
    modelId: request.modelId,
    phase: input.answerText === undefined ? "request" : "after_answer",
    provider: request.provider,
    safetyMarginTokens: measuredLimits.safetyMarginTokens,
    version: 1
  };
}

export type ProviderRequestContextBudgetResult =
  | Readonly<{
      contextTruncation: ContextTruncationSummary | null;
      ok: true;
      request: ProviderRunRequest;
    }>
  | Readonly<{
      error: Readonly<{ code: "context_too_large" | "skills_budget_exceeded"; message: string; skillBudget?: SkillBudgetFacts }>;
      ok: false;
      status: 400;
    }>;

function textModeAttachment(
  attachment: ProviderRunRequest["attachments"][number],
  capabilities: ProviderModelCapabilities
): boolean {
  return attachment.kind === "document" ||
    (attachment.kind === "pdf" && !usesNativePdfInput(attachment, capabilities));
}

function fitTextToTokenBudget(text: string, tokenBudget: number): string {
  if (estimateApproxTokens(text) <= tokenBudget) return text;
  const marker = "\n[truncated for model context]";
  const firstCharacter = String.fromCodePoint(text.codePointAt(0)!);
  const candidate = (length: number, withMarker: boolean) =>
    `${takeUtf16SafePrefix(text, length)}${withMarker ? marker : ""}`;
  const useMarker = estimateApproxTokens(`${firstCharacter}${marker}`) <= tokenBudget;
  let low = firstCharacter.length;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateApproxTokens(candidate(middle, useMarker)) <= tokenBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return candidate(low, useMarker);
}

type AttachmentTextFitResult =
  | Readonly<{ attachments: ProviderRunRequest["attachments"]; ok: true }>
  | Readonly<{ ok: false }>;

function fitProviderAttachmentText(input: Readonly<{
  /** Exact room for extracted text after labels, from a caller that already
   * measured every other retained contributor. */
  availableTextTokens?: number;
  fixedExtraTokens: number;
  request: ProviderRunRequest;
}>): AttachmentTextFitResult {
  const attachments = clampedProviderAttachments(input.request);
  const textCandidates = textAttachmentCandidates(attachments, input.request.modelCapabilities);
  if (textCandidates.length === 0) return { attachments, ok: true };

  const contextWindow = input.request.modelCapabilities.contextWindow ?? 0;
  const labelTokens = textCandidates.reduce((total, candidate) => total + candidate.labelTokens, 0);
  let availableTextTokens: number;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    availableTextTokens = UNKNOWN_CONTEXT_ATTACHMENT_TEXT_BUDGET_TOKENS - labelTokens;
  } else if (input.availableTextTokens !== undefined) {
    availableTextTokens = input.availableTextTokens;
  } else {
    const limits = calculateContextBudgetLimits({
      contextWindow,
      maxOutputTokens: maxOutputTokensForBudget(
        input.request.params,
        input.request.modelCapabilities,
        input.request.provider
      ),
      provider: input.request.provider
    });
    const currentContent = input.request.context?.messages.at(-1)?.content ?? input.request.content;
    const promptTokens = estimateApproxTokens(input.request.prompt.system ?? "") +
      estimateApproxTokens(input.request.prompt.developer ?? "") +
      (input.request.prompt.memoryActionAnswerResult
        ? estimateApproxTokens(memoryActionAnswerContract(
            input.request.prompt.memoryActionAnswerResult
          ))
        : 0) +
      (input.request.prompt.knowledgeAnswerContract === 1
        ? estimateApproxTokens(KNOWLEDGE_ANSWER_CONTRACT_V1)
        : 0) +
      estimateApproxTokens(
        knowledgeAnswerDraftContractText(
          input.request.prompt.knowledgeAnswerDraftContract
        ) ?? ""
      );
    const internalContextTokens = (input.request.context?.messages ?? [])
      .filter((message) => message.purpose !== undefined)
      .reduce((total, message) => total + estimateApproxTokens(message.content), 0);
    const fixedAttachments = attachments.map((attachment) =>
      textModeAttachment(attachment, input.request.modelCapabilities)
        ? { ...attachment, extractedText: null }
        : attachment
    );
    const fixedTokens = promptTokens +
      estimateApproxTokens(currentContent) +
      internalContextTokens +
      input.fixedExtraTokens +
      providerAttachmentBudgetTokens({
        attachments: fixedAttachments,
        modelCapabilities: input.request.modelCapabilities
      });
    availableTextTokens = limits.budgetTokens - fixedTokens - labelTokens;
  }
  const minimumTokens = textCandidates.reduce(
    (total, candidate) => total + candidate.minimumTokens,
    0
  );
  if (availableTextTokens < minimumTokens) return { ok: false };

  const allocations = new Map(
    textCandidates.map((candidate) => [candidate.index, candidate.minimumTokens])
  );
  let remaining = availableTextTokens - minimumTokens;
  let active = textCandidates.filter(
    (candidate) => candidate.sourceTokens > candidate.minimumTokens
  );
  while (active.length > 0) {
    const share = Math.floor(remaining / active.length);
    if (share <= 0) break;
    const complete = active.filter(
      (candidate) => candidate.sourceTokens - allocations.get(candidate.index)! <= share
    );
    if (complete.length === 0) {
      for (const candidate of active) {
        allocations.set(candidate.index, allocations.get(candidate.index)! + share);
      }
      break;
    }
    for (const candidate of complete) {
      const previous = allocations.get(candidate.index)!;
      allocations.set(candidate.index, candidate.sourceTokens);
      remaining -= candidate.sourceTokens - previous;
    }
    const completedIndexes = new Set(complete.map((candidate) => candidate.index));
    active = active.filter((candidate) => !completedIndexes.has(candidate.index));
  }

  return {
    attachments: attachments.map((attachment, index) => {
      const allocated = allocations.get(index);
      return allocated === undefined || !attachment.extractedText
        ? attachment
        : { ...attachment, extractedText: fitTextToTokenBudget(attachment.extractedText, allocated) };
    }),
    ok: true
  };
}

type ProviderRequestBudgetInput = Readonly<{
  bridge?: ProviderToolBridge;
  /** Server-minted descriptors of this run's settled calls. They are the only
   * authority for replacing a provider result with a reader reference. */
  observations?: readonly ContextObservation[];
  request: ProviderRunRequest;
}>;

function skillsBudgetExceeded(
  request: ProviderRunRequest,
  pinned: readonly ProviderConversationMessage[],
  catalog: readonly ProviderConversationMessage[]
): ProviderRequestContextBudgetResult {
  const skillLimits = calculateContextBudgetLimits({
    contextWindow: request.modelCapabilities.contextWindow ?? 0,
    maxOutputTokens: maxOutputTokensForBudget(request.params, request.modelCapabilities, request.provider),
    provider: request.provider
  });
  return { ok: false, status: 400, error: {
    code: "skills_budget_exceeded", message: "Pinned Skills exceed the model context budget. Unpin Skills or choose a model with a larger context window.",
    skillBudget: { pinnedTokens: pinned.reduce((sum, message) => sum + estimateApproxTokens(message.content), 0),
      catalogTokens: catalog.reduce((sum, message) => sum + estimateApproxTokens(message.content), 0), budgetTokens: skillLimits.budgetTokens }
  } };
}

function withoutSkillPins(request: ProviderRunRequest): Readonly<{
  catalog: ProviderConversationMessage[];
  pinned: ProviderConversationMessage[];
  request: ProviderRunRequest;
}> {
  const messages = request.context?.messages ?? [];
  return {
    catalog: messages.filter((message) => message.purpose === "skill_catalog"),
    pinned: messages.filter((message) => message.purpose === "skill_context"),
    request: request.context ? { ...request, context: { ...request.context, messages: messages.filter((message) =>
      message.purpose !== "skill_context" && message.purpose !== "skill_catalog") } } : request
  };
}

/** Budgets the exact provider-facing client tools and retained tool transcript. */
export function applyProviderRequestContextBudget(input: ProviderRequestBudgetInput): ProviderRequestContextBudgetResult {
  if (usesHybridBudget(input.request)) return applyHybridProviderRequestContextBudget(input);
  const { limits, planned } = planProviderRequestContext(input);
  const plannedInput = { bridge: input.bridge, request: planned.request };
  const result = applyProviderRequestContextBudgetCore(plannedInput);
  const withMeasurement = (value: ProviderRequestContextBudgetResult): ProviderRequestContextBudgetResult => {
    const next = contextCompactionMeasurementWithBudget(planned.measurement, limits?.budgetTokens ?? null, value.ok);
    if (value.ok) return { ...value, request: { ...value.request, contextCompaction: next } };
    return value;
  };
  if (result.ok || input.request.agent) return withMeasurement(result);
  const skills = withoutSkillPins(planned.request);
  if (!skills.pinned.length && !skills.catalog.length) return withMeasurement(result);
  const withoutSkills = applyProviderRequestContextBudgetCore({ ...plannedInput, request: skills.request });
  if (!withoutSkills.ok) return withMeasurement(result);
  return skillsBudgetExceeded(input.request, skills.pinned, skills.catalog);
}

/** Same provider order as the legacy guard: exact pins directly precede the
 * current message, also after a summary rebuilt the prior context. */
function pinsBeforeCurrentMessage(request: ProviderRunRequest): ProviderRunRequest {
  const messages = request.context?.messages ?? [];
  const current = messages.at(-1);
  const pins = messages.filter((message) => message.purpose !== undefined && message !== current);
  if (!current || pins.length === 0) return request;
  const ordered = [...messages.filter((message) => message.purpose === undefined && message !== current), ...pins, current];
  return ordered.every((message, index) => message === messages[index])
    ? request
    : { ...request, context: { ...request.context!, messages: ordered } };
}

/** Names the part of the irreducible minimum that does not fit: the fixed
 * request alone, or the newest tool batch beside it. Earlier tool rounds and
 * prior history are never the cause; a summary can always stand for them. */
function hybridOverflowMessage(overflow: ContextOverflow | undefined, budgetTokens: number): string {
  const fixed = overflow?.notes
    ? "Prompt, pinned context, current message, tools, and context notes"
    : "Prompt, pinned context, current message, and tools";
  if (!overflow || overflow.transcriptTokens === 0 || overflow.fixedTokens > budgetTokens) {
    return `${fixed} exceed the model context budget (${budgetTokens} estimated tokens available).`;
  }
  return `The newest tool results (about ${overflow.transcriptTokens} estimated tokens) do not fit beside the ${fixed.charAt(0).toLowerCase()}${fixed.slice(1)} (about ${overflow.fixedTokens} estimated tokens) in the model context budget (${budgetTokens} estimated tokens available).`;
}

/**
 * Accepted hybrid runs never use the legacy whole-turn trimmer on unsummarized
 * history. The planner owns the outcome; this applies it to the exact request:
 * an irreducible minimum is rejected here (before a run exists at admission),
 * a pending summary keeps its source intact for the execution consumer, and a
 * fitting projection gives extracted attachment text only the remaining room.
 */
function applyHybridProviderRequestContextBudget(input: ProviderRequestBudgetInput): ProviderRequestContextBudgetResult {
  const { limits, planned } = planProviderRequestContext(input);
  const budget = limits!;
  if (planned.measurement.outcome === "irreducible_overflow") {
    const skills = withoutSkillPins(input.request);
    if ((skills.pinned.length || skills.catalog.length) &&
      applyHybridProviderRequestContextBudget({ ...input, request: skills.request }).ok) {
      return skillsBudgetExceeded(input.request, skills.pinned, skills.catalog);
    }
    return {
      error: { code: "context_too_large", message: hybridOverflowMessage(planned.overflow, budget.budgetTokens) },
      ok: false,
      status: 400
    };
  }
  const request = planned.request;
  const text = textAttachmentCandidates(clampedProviderAttachments(request), request.modelCapabilities);
  // A pending summary replaces prior history before any answer request, and
  // truncated text cannot grow back, so reserve the text's pre-summary share.
  const releasedHistoryTokens = planned.measurement.outcome === "needs_summary" ? contextHistory(request).priorTokens : 0;
  const attachmentFit = fitProviderAttachmentText({
    availableTextTokens: budget.budgetTokens + releasedHistoryTokens -
      approximateProviderRequestTokens(withoutAttachmentText(request), input.bridge) -
      text.reduce((total, candidate) => total + candidate.labelTokens, 0),
    fixedExtraTokens: providerRequestFixedExtraTokens(request, input.bridge),
    request
  });
  if (!attachmentFit.ok) {
    return {
      error: {
        code: "context_too_large",
        message: "Prompt, current message, tools, and selected attachments exceed the model context budget."
      },
      ok: false,
      status: 400
    };
  }
  const fitted: ProviderRunRequest = {
    ...pinsBeforeCurrentMessage(request),
    attachments: attachmentFit.attachments,
    contextCompaction: planned.measurement
  };
  if (!planned.historyTrim || !fitted.context) return { contextTruncation: null, ok: true, request: fitted };
  const finalTokens = approximateProviderRequestTokens(fitted, input.bridge);
  const contextTruncation = cumulativeTruncationSummary(request.context?.summary?.truncation, {
    approxDroppedTokens: planned.historyTrim.droppedTokens,
    approxFinalTokens: finalTokens,
    approxOriginalTokens: finalTokens + planned.historyTrim.droppedTokens,
    budgetTokens: budget.budgetTokens,
    contextWindow: budget.contextWindow,
    droppedMessages: planned.historyTrim.droppedMessages,
    keptMessages: fitted.context.messages.length,
    maxOutputTokens: budget.maxOutputTokens,
    safetyMarginTokens: budget.safetyMarginTokens
  });
  return {
    contextTruncation,
    ok: true,
    request: { ...fitted, context: { ...fitted.context, summary: { truncation: contextTruncation } } }
  };
}

/**
 * A bounded summary that could cover only the newest span leaves the older
 * prior turns out exactly like the legacy whole-turn guard: ordinary
 * truncation evidence, cumulative with earlier trimming, and a measurement
 * marked as the legacy fallback. It never hides lost coverage.
 */
export function withSummaryHistoryOmission(input: Readonly<{
  bridge?: ProviderToolBridge;
  omitted: Readonly<{ messages: number; tokens: number }>;
  result: Extract<ProviderRequestContextBudgetResult, { ok: true }>;
}>): Extract<ProviderRequestContextBudgetResult, { ok: true }> {
  const { request } = input.result;
  const limits = contextCompactionBudgetLimits(request);
  if (!limits || !request.context || input.omitted.messages === 0) return input.result;
  const finalTokens = approximateProviderRequestTokens(request, input.bridge);
  const contextTruncation = cumulativeTruncationSummary(input.result.contextTruncation ?? request.context.summary?.truncation, {
    approxDroppedTokens: input.omitted.tokens,
    approxFinalTokens: finalTokens,
    approxOriginalTokens: finalTokens + input.omitted.tokens,
    budgetTokens: limits.budgetTokens,
    contextWindow: limits.contextWindow,
    droppedMessages: input.omitted.messages,
    keptMessages: request.context.messages.length,
    maxOutputTokens: limits.maxOutputTokens,
    safetyMarginTokens: limits.safetyMarginTokens
  });
  return {
    contextTruncation,
    ok: true,
    request: {
      ...request,
      context: { ...request.context, summary: { truncation: contextTruncation } },
      ...(request.contextCompaction ? { contextCompaction: { ...request.contextCompaction, legacyFallback: true } } : {})
    }
  };
}

function applyProviderRequestContextBudgetCore(input: Readonly<{
  bridge?: ProviderToolBridge;
  request: ProviderRunRequest;
}>): ProviderRequestContextBudgetResult {
  // Agent turns retain their accepted branch. Codex owns compaction; deferred
  // PDF/Workspace continuations must not apply a second, app-side truncation.
  if (input.request.agent) return { ok: true, request: { ...input.request, tools: [] }, contextTruncation: null };
  const contextMessages = input.request.context?.messages ?? [];
  const syntheticCurrentMessageId = "__provider-current-message__";
  const budgetMessages = contextMessages.length > 0
    ? contextMessages
    : [{
        content: input.request.content,
        id: syntheticCurrentMessageId,
        role: "user" as const
      }];
  const currentMessageId = budgetMessages.at(-1)?.id;
  const fixedExtraTokens = providerRequestFixedExtraTokens(input.request, input.bridge);
  const attachmentFit = fitProviderAttachmentText({ fixedExtraTokens, request: input.request });
  if (!attachmentFit.ok) {
    return {
      error: {
        code: "context_too_large",
        message: "Prompt, current message, tools, and selected attachments exceed the model context budget."
      },
      ok: false,
      status: 400
    };
  }
  const fittedRequest = { ...input.request, attachments: attachmentFit.attachments };
  const providerExtras =
    providerAttachmentBudgetTokens({
      attachments: fittedRequest.attachments,
      modelCapabilities: fittedRequest.modelCapabilities
    }) + fixedExtraTokens;
  const budget = applyRunContextBudget({
    contextMessages: budgetMessages,
    messageExtraTokens:
      currentMessageId && providerExtras > 0
        ? { [currentMessageId]: providerExtras }
        : undefined,
    modelCapabilities: fittedRequest.modelCapabilities,
    params: fittedRequest.params,
    prompt: fittedRequest.prompt,
    provider: fittedRequest.provider
  });
  if (!budget.ok) return budget;

  if (contextMessages.length === 0) {
    return { contextTruncation: null, ok: true, request: fittedRequest };
  }

  const previous = input.request.context?.summary?.truncation;
  const contextTruncation = budget.contextTruncation
    ? cumulativeTruncationSummary(previous, budget.contextTruncation)
    : null;
  const effectiveTruncation = contextTruncation ?? previous;
  return {
    contextTruncation,
    ok: true,
    request: {
      ...fittedRequest,
      context: {
        ...budget.context,
        ...(effectiveTruncation
          ? { summary: { truncation: effectiveTruncation } }
          : {})
      }
    }
  };
}
