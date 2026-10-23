import { workspaceImageTokenReserve } from "../workspace/directImageEvidence";
import { calculateContextBudgetLimits, type ContextTruncationSummary } from "../../domain/contextBudget";
import { maxOutputTokensFromParams } from "../../domain/providerParams";
import { imageTokenEstimator } from "../../domain/imageTokenEstimate";
import { contextTokenEstimator } from "../../domain/tokenEstimate";
import { takeUtf16SafePrefix } from "../../domain/utf16";
import {
  usesNativePdfInput,
  providerAttachmentBudgetTokens,
  providerAttachmentTextLabel,
  truncateProviderAttachmentText
} from "../providers/attachmentPayload";
import { MEMORY_READER_CONTRACT_CURRENT, MEMORY_READER_FINALIZATION_CONTRACT_V1 } from "../providers/personalContext";
import { memoryActionAnswerContract } from "../providers/memoryActionAnswer";
import type {
  NormalizedRunRequest,
  ProviderConversationMessage,
  ProviderModelCapabilities,
  ProviderRunRequest
} from "../providers/types";
import type { ProviderToolBridge } from "../tools/types";
import { getAttachmentTextConfig } from "../uploads/attachmentTextConfig";
import type { SkillBudgetFacts } from "../../contracts/skills";

/**
 * The context fit of an exact request at admission and before document or
 * Workspace work hands a run to the agent engine. The engine measures and
 * compacts the conversation itself (`lib/server/engine/runContext.ts`), so
 * earlier turns never count here: only what no compaction can remove must fit
 * the model's input budget (prompt, pinned context, the current message, its
 * attachments, tools and the follow-up reserve). Extracted attachment text is
 * elastic and takes the room that is left; nothing else is ever cut.
 */

/** Room for extracted attachment text when the model's window is unknown. */
export const UNKNOWN_CONTEXT_ATTACHMENT_TEXT_BUDGET_TOKENS = 5_000;

function contextTooLargeMessage(budgetTokens: number): string {
  return "Prompt, pinned context, current message, tools, and selected attachments exceed the model context budget " +
    `(${budgetTokens} estimated tokens available).`;
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

type BudgetLimits = ReturnType<typeof calculateContextBudgetLimits>;

function maxOutputTokensForBudget(params: Readonly<Record<string, unknown>>, capabilities: ProviderModelCapabilities,
  provider: string): number {
  const requested = maxOutputTokensFromParams(params);
  const selected = requested !== undefined ? Math.floor(requested) : capabilities.defaultMaxOutputTokens ?? 0;
  return provider === "fake" && typeof capabilities.contextWindow === "number" && capabilities.contextWindow > 0 &&
    selected >= capabilities.contextWindow ? 0 : selected;
}

function budgetLimits(request: Pick<NormalizedRunRequest, "modelCapabilities" | "params" | "provider">): BudgetLimits | null {
  const contextWindow = request.modelCapabilities.contextWindow;
  return Number.isFinite(contextWindow) && Number(contextWindow) > 0
    ? calculateContextBudgetLimits({
        contextWindow: Number(contextWindow),
        maxOutputTokens: maxOutputTokensForBudget(request.params, request.modelCapabilities, request.provider),
        provider: request.provider
      })
    : null;
}

/** The trusted prompt strings every request carries. */
function promptTokens(request: Pick<NormalizedRunRequest, "prompt">, estimate: (value: unknown) => number): number {
  const prompt = request.prompt;
  return [
    prompt.system,
    prompt.personalInstructions,
    prompt.developer,
    prompt.responseReminder ? `Response reminder:\n${prompt.responseReminder}` : null,
    prompt.memoryActionAnswerResult ? memoryActionAnswerContract(prompt.memoryActionAnswerResult) : null
  ].reduce((total: number, part) => total + (part?.trim() ? estimate(part) : 0), 0);
}

function followupReserveTokens(request: Pick<NormalizedRunRequest, "followupContextReserveTokens">): number {
  return request.followupContextReserveTokens ?? 0;
}

/** Pinned context (Skills, private context) and the current message; earlier turns are left to compaction. */
function irreducibleMessageTokens(request: NormalizedRunRequest, estimate: (value: unknown) => number): number {
  const messages = request.context?.messages ?? [];
  const pinned = messages.filter((message) => message.purpose !== undefined);
  const current = messages.filter((message) => message.purpose === undefined).at(-1);
  return pinned.reduce((total, message) => total + estimate(message.content), 0) +
    estimate(current?.content ?? request.content);
}

export function providerFacingSerializedTools(request: ProviderRunRequest, bridge?: ProviderToolBridge): Record<string, unknown>[] {
  if (!bridge) return [];
  return [
    ...(bridge.serializeHostedTools?.(request) ?? []),
    ...(request.tools ?? []).map((tool) => bridge.serializeTool(tool).tool)
  ];
}

function textModeAttachment(attachment: ProviderRunRequest["attachments"][number], capabilities: ProviderModelCapabilities): boolean {
  return attachment.kind === "document" || (attachment.kind === "pdf" && !usesNativePdfInput(attachment, capabilities));
}

function clampedProviderAttachments(request: ProviderRunRequest): ProviderRunRequest["attachments"] {
  const operatorMaxChars = getAttachmentTextConfig().extractedTextMaxChars;
  return request.attachments.map((attachment) => ({
    ...attachment,
    extractedText: attachment.extractedText ? truncateProviderAttachmentText(attachment.extractedText, operatorMaxChars) : null
  }));
}

type TextAttachmentCandidate = Readonly<{
  index: number;
  /** The provider line prefix, measured together with the text. */
  label: string;
  labelTokens: number;
  minimumTokens: number;
  /** What the whole text adds to its label line: token estimates are not
   * additive, so text is always measured as the provider receives it. */
  sourceTokens: number;
}>;

function textAttachmentCandidates(attachments: ProviderRunRequest["attachments"], capabilities: ProviderModelCapabilities,
  estimate: (value: unknown) => number): TextAttachmentCandidate[] {
  return attachments.flatMap((attachment, index) => {
    if (!textModeAttachment(attachment, capabilities) || !attachment.extractedText?.trim()) return [];
    const label = `[${providerAttachmentTextLabel(attachment)}]\n`;
    const labelTokens = estimate(label);
    return [{
      index,
      label,
      labelTokens,
      minimumTokens: estimate(String.fromCodePoint(attachment.extractedText.codePointAt(0)!)),
      sourceTokens: Math.max(0, estimate(`${label}${attachment.extractedText}`) - labelTokens)
    }];
  });
}

/** The longest prefix of `text` whose provider line (label, prefix and, when
 * cut, the marker) fits the budget, measured as one string. */
function fitTextToTokenBudget(text: string, tokenBudget: number, estimate: (value: unknown) => number, label: string): string {
  if (estimate(`${label}${text}`) <= tokenBudget) return text;
  const marker = "\n[truncated for model context]";
  const firstCharacter = String.fromCodePoint(text.codePointAt(0)!);
  const candidate = (length: number, withMarker: boolean) => `${takeUtf16SafePrefix(text, length)}${withMarker ? marker : ""}`;
  const useMarker = estimate(`${label}${firstCharacter}${marker}`) <= tokenBudget;
  let low = firstCharacter.length;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimate(`${label}${candidate(middle, useMarker)}`) <= tokenBudget) low = middle;
    else high = middle - 1;
  }
  return candidate(low, useMarker);
}

/** Shares the room for extracted text among the text attachments: each keeps
 * its first character, short texts stay whole, the rest split what is left. */
function allocateAttachmentText(attachments: ProviderRunRequest["attachments"], candidates: readonly TextAttachmentCandidate[],
  availableTextTokens: number, estimate: (value: unknown) => number): ProviderRunRequest["attachments"] | null {
  const minimumTokens = candidates.reduce((total, candidate) => total + candidate.minimumTokens, 0);
  if (availableTextTokens < minimumTokens) return null;
  const allocations = new Map(candidates.map((candidate) => [candidate.index, candidate.minimumTokens]));
  let remaining = availableTextTokens - minimumTokens;
  let active = candidates.filter((candidate) => candidate.sourceTokens > candidate.minimumTokens);
  while (active.length > 0) {
    const share = Math.floor(remaining / active.length);
    if (share <= 0) break;
    const complete = active.filter((candidate) => candidate.sourceTokens - allocations.get(candidate.index)! <= share);
    if (complete.length === 0) {
      for (const candidate of active) allocations.set(candidate.index, allocations.get(candidate.index)! + share);
      break;
    }
    for (const candidate of complete) {
      remaining -= candidate.sourceTokens - allocations.get(candidate.index)!;
      allocations.set(candidate.index, candidate.sourceTokens);
    }
    const completed = new Set(complete.map((candidate) => candidate.index));
    active = active.filter((candidate) => !completed.has(candidate.index));
  }
  const byIndex = new Map(candidates.map((candidate) => [candidate.index, candidate]));
  return attachments.map((attachment, index) => {
    const allocated = allocations.get(index);
    const candidate = byIndex.get(index);
    return allocated === undefined || !candidate || !attachment.extractedText ? attachment
      : { ...attachment, extractedText: fitTextToTokenBudget(attachment.extractedText, candidate.labelTokens + allocated, estimate,
        candidate.label) };
  });
}

/**
 * Estimated tokens of everything in the request that no compaction removes,
 * with extracted attachment text left out (it is fitted to the room left).
 * `withReserve` adds the follow-up reserve a fit check keeps free.
 */
function irreducibleTokens(request: ProviderRunRequest, attachments: ProviderRunRequest["attachments"],
  bridge: ProviderToolBridge | undefined, withReserve: boolean): number {
  const estimate = contextTokenEstimator(request);
  const withoutText = attachments.map((attachment) =>
    textModeAttachment(attachment, request.modelCapabilities) ? { ...attachment, extractedText: null } : attachment);
  return promptTokens(request, estimate) +
    irreducibleMessageTokens(request, estimate) +
    (withReserve ? followupReserveTokens(request) : 0) +
    estimate(providerFacingSerializedTools(request, bridge)) +
    estimate(request.providerToolMessages ?? []) + workspaceImageTokenReserve(request.providerToolMessages) +
    estimate(request.personalContext?.text ?? "") +
    (request.personalContext ? estimate(MEMORY_READER_CONTRACT_CURRENT) + estimate(MEMORY_READER_FINALIZATION_CONTRACT_V1) : 0) +
    providerAttachmentBudgetTokens({ attachments: withoutText, estimateImageTokens: imageTokenEstimator(request), estimateTokens: estimate,
      modelCapabilities: request.modelCapabilities });
}

/** Pinned context directly precedes the current message. */
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

function fitRequest(request: ProviderRunRequest, bridge: ProviderToolBridge | undefined):
  Readonly<{ attachments: ProviderRunRequest["attachments"]; ok: true }> | Readonly<{ budgetTokens: number; ok: false }> {
  const estimate = contextTokenEstimator(request);
  const attachments = clampedProviderAttachments(request);
  const candidates = textAttachmentCandidates(attachments, request.modelCapabilities, estimate);
  const labelTokens = candidates.reduce((total, candidate) => total + candidate.labelTokens, 0);
  const limits = budgetLimits(request);
  if (!limits) {
    const fitted = allocateAttachmentText(attachments, candidates, UNKNOWN_CONTEXT_ATTACHMENT_TEXT_BUDGET_TOKENS - labelTokens, estimate);
    return fitted ? { attachments: fitted, ok: true } : { budgetTokens: UNKNOWN_CONTEXT_ATTACHMENT_TEXT_BUDGET_TOKENS, ok: false };
  }
  const available = limits.budgetTokens - irreducibleTokens(request, attachments, bridge, true) - labelTokens;
  const fitted = allocateAttachmentText(attachments, candidates, available, estimate);
  return fitted ? { attachments: fitted, ok: true } : { budgetTokens: limits.budgetTokens, ok: false };
}

/**
 * Fits the exact request: refuses it when its irreducible part does not fit
 * (`skills_budget_exceeded` when only the pinned Skills make the difference),
 * otherwise gives extracted attachment text the room that is left.
 */
export function applyProviderRequestContextBudget(input: Readonly<{
  bridge?: ProviderToolBridge;
  request: ProviderRunRequest;
}>): ProviderRequestContextBudgetResult {
  const fit = fitRequest(input.request, input.bridge);
  if (fit.ok) {
    return { contextTruncation: null, ok: true,
      request: { ...pinsBeforeCurrentMessage(input.request), attachments: fit.attachments } };
  }
  const skills = withoutSkillPins(input.request);
  if ((skills.pinned.length > 0 || skills.catalog.length > 0) && fitRequest(skills.request, input.bridge).ok) {
    const estimate = contextTokenEstimator(input.request);
    return { ok: false, status: 400, error: {
      code: "skills_budget_exceeded",
      message: "Pinned Skills exceed the model context budget. Unpin Skills or choose a model with a larger context window.",
      skillBudget: { budgetTokens: fit.budgetTokens,
        catalogTokens: skills.catalog.reduce((sum, message) => sum + estimate(message.content), 0),
        pinnedTokens: skills.pinned.reduce((sum, message) => sum + estimate(message.content), 0) }
    } };
  }
  return { error: { code: "context_too_large", message: contextTooLargeMessage(fit.budgetTokens) }, ok: false, status: 400 };
}

/**
 * The room a request leaves beside its irreducible part as dispatched (no
 * follow-up reserve), with attachment text at its full length; null when the
 * model's window is unknown.
 */
export function requestHeadroomTokens(request: ProviderRunRequest, bridge?: ProviderToolBridge): number | null {
  const limits = budgetLimits(request);
  if (!limits) return null;
  const estimate = contextTokenEstimator(request);
  const attachments = clampedProviderAttachments(request);
  const text = textAttachmentCandidates(attachments, request.modelCapabilities, estimate)
    .reduce((total, candidate) => total + candidate.labelTokens + candidate.sourceTokens, 0);
  return Math.max(0, limits.budgetTokens - irreducibleTokens(request, attachments, bridge, false) - text);
}

/** Returns the bounded room for a future Personal Memory block after the
 * admitted model's output reserve, safety margin, trusted prompt, current
 * message and pinned context. Attachments and serialized tools remain subject
 * to the exact request fit. */
export function normalizedRequestPersonalContextTokenLimit(request: NormalizedRunRequest): number | null {
  const limits = budgetLimits(request);
  if (!limits) return null;
  const estimate = contextTokenEstimator(request);
  return Math.max(0, limits.budgetTokens - promptTokens(request, estimate) - estimate(MEMORY_READER_CONTRACT_CURRENT) -
    estimate(MEMORY_READER_FINALIZATION_CONTRACT_V1) - irreducibleMessageTokens(request, estimate) - followupReserveTokens(request));
}
