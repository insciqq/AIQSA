import type { KnowledgeAnswerInstructions } from "./answerInstructions";
import type { ModelGenerationBudget } from "../providers/modelOutputAllowance";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { acceptedOperation } from "./answerGroundingExecutionV21";
import { knowledgeAnswerHash } from "./answerGroundingV5";
import { KnowledgeAnswerContractError } from "./grounding";
import { decodeKnowledgeEvidenceDispatchManifestDraft, type KnowledgeEvidenceDispatchManifestDraft } from "./evidenceDispatchManifest";
import {
  buildKnowledgeEvidenceAnswerPublicationV1, decodeKnowledgeEvidenceAnswerDraftV1,
  knowledgeEvidenceAnswerDraftPromptV1, knowledgeEvidenceAnswerReviewPromptV1,
  normalizeKnowledgeEvidenceAnswerDraftV1,
  validateKnowledgeEvidenceAnswerDraftV1, validateKnowledgeEvidenceAnswerReviewV1,
  type KnowledgeEvidenceAnswerDraftV1, type KnowledgeEvidenceAnswerPublicationV1,
  type KnowledgeEvidenceAnswerReviewV1, type KnowledgeEvidenceAnswerValidationV1
} from "./evidenceAnswerV1";
import {
  createKnowledgeEvidenceAnswerSnapshotV1, KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1
} from "./evidenceAnswerSnapshotV1";
import { createKnowledgeEvidenceAnswerSnapshotV2, isKnowledgeEvidenceAnswerOperationV2, KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2 } from "./evidenceAnswerSnapshotV2";
import { isKnowledgeEvidenceComposeOperation, type KnowledgeEvidenceAnswerOperation } from "./evidenceAnswerSnapshot";
import { buildKnowledgeEvidenceAnswerPublicationV2, decodeKnowledgeEvidenceAnswerReviewV2, decodeKnowledgeEvidenceReviewRepairHintV1,
  knowledgeEvidenceAnswerDraftPromptV2, knowledgeEvidenceAnswerReviewPromptV2, validateKnowledgeEvidenceAnswerReviewV2,
  type KnowledgeEvidenceAnswerReviewV2, type KnowledgeEvidenceReviewRepairHintV1 } from "./evidenceAnswerReviewV2";
import type { KnowledgeGroundingEffectiveExecutionPolicyV1 } from "./groundingExecutionPolicy";
import { EMPTY_KNOWLEDGE_COVERAGE_LIMITATIONS_V1 } from "./searchFailure";
import { observedFailure, observedFailureCode } from "../providers/providerObservability";

type OperationInput = Parameters<typeof acceptedOperation>[0];
type OperationRecord = Readonly<Record<string, unknown>>;
type RejectionReason = Extract<KnowledgeEvidenceAnswerValidationV1<unknown>, { kind: "rejected" }>["reason"];
type ProviderFailureReason = "timeout" | "refusal" | "transport" | "provider_error";
type Failure = Readonly<{ kind: "rejected"; reason: RejectionReason; version: 1 }> |
  Readonly<{ kind: "failed"; reason: ProviderFailureReason; version: 1 }> |
  Readonly<{ kind: "failed"; reason: ProviderFailureReason; version: 2; providerCode: string; httpStatus?: number }>;

/** The public Knowledge failure identity and its optional content-free HTTP
 * diagnostic survive settled-operation replay without retaining provider text.
 * Legacy accepted failures keep their original shape and hash. */
export class KnowledgeAnswerProviderError extends Error {
  readonly code = "knowledge_answer_failed";
  readonly providerCode: string | undefined;
  readonly httpStatus: number | undefined;

  constructor(providerCode?: string, httpStatus?: number) {
    super("Knowledge evidence answer provider failed.");
    this.name = "KnowledgeAnswerProviderError";
    this.providerCode = providerCode === undefined ? undefined : observedFailureCode({ code: providerCode });
    this.httpStatus = validHttpStatus(httpStatus) ? httpStatus : undefined;
  }
}

function validHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

export function decodeKnowledgeEvidenceAnswerFailureV1(value: unknown): Failure | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.reason !== "string") return null;
  if (record.version === 1 && Object.keys(record).length === 3 && (
    record.kind === "rejected" && ["shape_invalid", "text_invalid", "capacity_exceeded", "evidence_invalid", "coverage_invalid"].includes(record.reason) ||
    record.kind === "failed" && ["timeout", "refusal", "transport", "provider_error"].includes(record.reason))) return record as Failure;
  if (record.version === 2 && record.kind === "failed" &&
    Object.keys(record).length === (record.httpStatus === undefined ? 4 : 5) &&
    ["timeout", "refusal", "transport", "provider_error"].includes(record.reason) &&
    typeof record.providerCode === "string" && observedFailureCode({ code: record.providerCode }) === record.providerCode &&
    (record.httpStatus === undefined || validHttpStatus(record.httpStatus))) return record as Failure;
  return null;
}
function decodeReviewFailure(value: OperationRecord, repairFeedbackVersion: 1 | undefined): Failure | Readonly<{
  kind: "rejected"; reason: "text_invalid"; version: 2; repairHint: KnowledgeEvidenceReviewRepairHintV1;
}> | null {
  const legacy = decodeKnowledgeEvidenceAnswerFailureV1(value);
  if (legacy) return legacy;
  if (repairFeedbackVersion !== 1 || Object.keys(value).length !== 4 || value.kind !== "rejected" ||
    value.reason !== "text_invalid" || value.version !== 2) return null;
  const repairHint = decodeKnowledgeEvidenceReviewRepairHintV1(value.repairHint);
  return repairHint ? Object.freeze({ kind: "rejected", reason: "text_invalid", version: 2, repairHint }) : null;
}
function providerFailure(error: unknown): Failure {
  const failure = observedFailure(error);
  return Object.freeze({ version: 2, kind: "failed", reason:
    failure.reason === "deadline" ? "timeout" : failure.code === "provider_refused" ? "refusal" :
    failure.reason === "network" ? "transport" : "provider_error",
    providerCode: failure.code, ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }) });
}
function failed(reason: string): never {
  throw new KnowledgeAnswerContractError("knowledge_answer_contract_failed", `Knowledge evidence answer failed: ${reason}`);
}
function providerFailed(failure: Extract<Failure, { kind: "failed" }>): never {
  throw new KnowledgeAnswerProviderError(failure.version === 2 ? failure.providerCode : undefined,
    failure.version === 2 ? failure.httpStatus : undefined);
}

export type KnowledgeEvidenceAnswerExecutionV1Result = Readonly<{
  evidenceReceiptHash: string;
  refinementAttempted: boolean;
  compositionRepairAttempted: boolean;
  reviewRepairAttempted: boolean;
  contracts: typeof KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1 | typeof KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2;
  draft: KnowledgeEvidenceAnswerDraftV1;
  review: KnowledgeEvidenceAnswerReviewV1 | KnowledgeEvidenceAnswerReviewV2;
  publication: KnowledgeEvidenceAnswerPublicationV1;
  operations: readonly Readonly<{
    operation: KnowledgeEvidenceAnswerOperation;
    ordinal: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    providerResponseId: string | null;
    usage: ModelRunUsage;
  }>[];
}>;

export type KnowledgeEvidenceAnswerExecutionV1Input = Readonly<{
  authorize: OperationInput["authorize"];
  answerInstructions?: KnowledgeAnswerInstructions;
  draft: KnowledgeEvidenceDispatchManifestDraft;
  evidenceBindings?: OperationInput["evidenceBindings"];
  execute: OperationInput["execute"];
  executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1;
  forbiddenIdentityFragments?: readonly string[];
  lifecycle: OperationInput["lifecycle"];
  modelRunId: string;
  request: string;
  shouldAbort: OperationInput["shouldAbort"];
  transport: "native_strict" | "provider_neutral_json";
  repairFeedbackVersion?: 1;
  generationBudget?: ModelGenerationBudget;
  onOperationAccepted?: (operation: KnowledgeEvidenceAnswerExecutionV1Result["operations"][number]) => void;
}>;

async function executeCycle(input: KnowledgeEvidenceAnswerExecutionV1Input & Readonly<{
  workflowVersion?: 9 | 10 | 11;
  operationOffset?: number;
  revision?: Pick<KnowledgeEvidenceAnswerExecutionV1Result, "draft" | "review" | "evidenceReceiptHash">;
}>): Promise<KnowledgeEvidenceAnswerExecutionV1Result> {
  const manifest = decodeKnowledgeEvidenceDispatchManifestDraft(input.draft);
  if (!manifest || !input.request.trim() || manifest.items.length === 0) failed("input_invalid");
  const reviewV2 = input.workflowVersion === 11;
  if (input.repairFeedbackVersion !== undefined && (input.repairFeedbackVersion !== 1 || !reviewV2)) failed("repair_policy_invalid");
  const context = {
    availableHandles: manifest.items.map(item => item.handle),
    availableSourceAliases: [...new Set(manifest.items.map(item => item.sourceAlias))],
    forbiddenIdentityFragments: input.forbiddenIdentityFragments ?? []
  };
  const operations: KnowledgeEvidenceAnswerExecutionV1Result["operations"][number][] = [];
  async function operation(inputOperation: Readonly<{
    operation: KnowledgeEvidenceAnswerOperation;
    draftPayloadHash?: string;
    reviewPayloadHash?: string;
    systemPrompt: string;
    userPrompt: string;
    accept(output: OperationRecord): OperationRecord;
  }>): Promise<OperationRecord> {
    if (operations.length >= 4) failed("operation_budget_exceeded");
    const ordinal = operations.length + 1 + (input.operationOffset ?? 0) as KnowledgeEvidenceAnswerExecutionV1Result["operations"][number]["ordinal"];
    if (ordinal > 8 || input.workflowVersion === undefined && ordinal > 4) failed("operation_budget_exceeded");
    const snapshotInput = { ...(isKnowledgeEvidenceComposeOperation(inputOperation.operation) && input.answerInstructions
      ? { answerInstructions: input.answerInstructions } : {}), evidenceReceiptHash: manifest!.manifestHash, executionPolicy: input.executionPolicy, transport: input.transport };
    const snapshot = isKnowledgeEvidenceAnswerOperationV2(inputOperation.operation)
      ? createKnowledgeEvidenceAnswerSnapshotV2({ ...inputOperation, ...snapshotInput, operation: inputOperation.operation, workflowVersion: 11,
          repairFeedbackVersion: input.repairFeedbackVersion, generationBudget: input.generationBudget })
      : createKnowledgeEvidenceAnswerSnapshotV1({ ...inputOperation, ...snapshotInput, operation: inputOperation.operation,
          workflowVersion: input.workflowVersion === 11 ? undefined : input.workflowVersion });
    const result = await acceptedOperation({ ...input, draft: manifest!, acceptedRequest: snapshot,
      acceptedFailure: providerFailure, acceptedOutput: inputOperation.accept, ordinal, operation: inputOperation.operation });
    operations.push(Object.freeze({ operation: inputOperation.operation, ordinal, providerResponseId: result.providerResponseId, usage: result.usage }));
    input.onOperationAccepted?.(operations.at(-1)!);
    return result.acceptedResult;
  }

  let draft: KnowledgeEvidenceAnswerDraftV1 | null = null;
  let repairReason: RejectionReason | undefined;
  function composePrompt() {
    const revision = input.revision;
    if (reviewV2) {
      if (revision && revision.review.version !== 2) failed("revision_contract_invalid");
      return knowledgeEvidenceAnswerDraftPromptV2({ request: input.request, evidenceManifest: manifest!.message, repairReason,
        revision: revision && revision.review.version === 2 ? { draft: revision.draft, review: revision.review } : undefined });
    }
    if (revision && revision.review.version !== 1) failed("revision_contract_invalid");
    return knowledgeEvidenceAnswerDraftPromptV1({ request: input.request, evidenceManifest: manifest!.message, repairReason,
      revision: revision && revision.review.version === 1 ? { draft: revision.draft, review: revision.review } : undefined });
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await operation({ operation: reviewV2 ? "knowledge_evidence_compose_v2" : "knowledge_evidence_compose_v1",
      ...(input.revision ? { draftPayloadHash: knowledgeAnswerHash(input.revision.draft), reviewPayloadHash: knowledgeAnswerHash(input.revision.review) } : {}),
      ...composePrompt(),
      accept(output) {
        const validation = validateKnowledgeEvidenceAnswerDraftV1(
          normalizeKnowledgeEvidenceAnswerDraftV1(output, context.availableHandles), context
        );
        return validation.kind === "accepted" ? validation.value : { ...validation, version: 1 };
      } });
    draft = decodeKnowledgeEvidenceAnswerDraftV1(result, context);
    if (draft) break;
    const failure = decodeKnowledgeEvidenceAnswerFailureV1(result);
    if (failure?.kind === "failed") providerFailed(failure);
    if (failure?.kind !== "rejected") failed("accepted_draft_invalid");
    repairReason = failure.reason;
  }
  if (!draft) failed(repairReason ?? "draft_invalid");
  if (input.revision?.evidenceReceiptHash === manifest.manifestHash &&
    knowledgeAnswerHash(input.revision.draft) === knowledgeAnswerHash(draft)) failed("revision_unchanged");
  let review: KnowledgeEvidenceAnswerReviewV1 | KnowledgeEvidenceAnswerReviewV2 | null = null;
  let repairHint: KnowledgeEvidenceReviewRepairHintV1 | undefined;
  repairReason = undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await operation({ operation: reviewV2 ? "knowledge_evidence_review_v2" : "knowledge_evidence_review_v1", draftPayloadHash: knowledgeAnswerHash(draft),
      ...(reviewV2 ? knowledgeEvidenceAnswerReviewPromptV2 : knowledgeEvidenceAnswerReviewPromptV1)({ request: input.request, evidenceManifest: manifest.message,
        draft, availableSourceAliases: context.availableSourceAliases, repairReason, repairHint, repairFeedbackVersion: input.repairFeedbackVersion }),
      accept(output) {
        const validation = (reviewV2 ? validateKnowledgeEvidenceAnswerReviewV2 : validateKnowledgeEvidenceAnswerReviewV1)(output,
          { ...context, draft: draft!, repairFeedbackVersion: input.repairFeedbackVersion });
        return validation.kind === "accepted" ? validation.value : { ...validation, version: "repairHint" in validation ? 2 : 1 };
      } });
    if (reviewV2) review = decodeKnowledgeEvidenceAnswerReviewV2(result, { ...context, draft });
    else {
      const validation = validateKnowledgeEvidenceAnswerReviewV1(result, { ...context, draft });
      if (validation.kind === "accepted") review = validation.value;
    }
    if (review) break;
    const failure = decodeReviewFailure(result, input.repairFeedbackVersion);
    if (failure?.kind === "failed") providerFailed(failure);
    if (failure?.kind !== "rejected") failed("accepted_review_invalid");
    repairReason = failure.reason;
    repairHint = "repairHint" in failure ? failure.repairHint : undefined;
  }
  if (!review) failed(repairReason ?? "review_invalid");
  const publicationInput = { ...context, draft, coverageLimitations: manifest.coverageLimitations ?? EMPTY_KNOWLEDGE_COVERAGE_LIMITATIONS_V1 };
  const publication = review.version === 2 ? buildKnowledgeEvidenceAnswerPublicationV2({ ...publicationInput, review })
    : buildKnowledgeEvidenceAnswerPublicationV1({ ...publicationInput, review });
  return Object.freeze({ contracts: reviewV2 ? KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2 : KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1, draft, review, publication,
    evidenceReceiptHash: manifest.manifestHash, refinementAttempted: false,
    compositionRepairAttempted: operations.filter(item => isKnowledgeEvidenceComposeOperation(item.operation)).length > 1,
    reviewRepairAttempted: operations.filter(item => !isKnowledgeEvidenceComposeOperation(item.operation)).length > 1,
    operations: Object.freeze(operations) });
}

export async function executeKnowledgeEvidenceAnswerV1(input: KnowledgeEvidenceAnswerExecutionV1Input): Promise<KnowledgeEvidenceAnswerExecutionV1Result> {
  return executeCycle(input);
}

/** Workflow 9 permits one revision; workflow 10 follows fresh evidence.
 * Workflow 11 additionally permits one evidence-bound factual correction per
 * manifest. All share the same eight-operation ceiling and replay algorithm. */
export async function executeKnowledgeEvidenceAnswerWithRefinementV1(input: KnowledgeEvidenceAnswerExecutionV1Input & Readonly<{
  workflowVersion?: 10 | 11;
  refineEvidence(result: KnowledgeEvidenceAnswerExecutionV1Result, previousDraft: KnowledgeEvidenceDispatchManifestDraft): Promise<KnowledgeEvidenceDispatchManifestDraft | null>;
}>): Promise<KnowledgeEvidenceAnswerExecutionV1Result> {
  const operations: KnowledgeEvidenceAnswerExecutionV1Result["operations"][number][] = [];
  const onOperationAccepted: NonNullable<KnowledgeEvidenceAnswerExecutionV1Input["onOperationAccepted"]> = operation => {
    operations.push(operation);
    input.onOperationAccepted?.(operation);
  };
  const workflowVersion = input.workflowVersion ?? 9;
  const first = await executeCycle({ ...input, workflowVersion, onOperationAccepted });
  let selected = first;
  let lastUseful = first;
  let previousDraft = input.draft;
  let refinementAttempted = false;
  let compositionRepairAttempted = first.compositionRepairAttempted;
  let reviewRepairAttempted = first.reviewRepairAttempted;
  const maximumRevisions = workflowVersion === 9 ? 1 : 3;
  const correctedEvidence = new Set<string>();
  for (let revision = 0; revision < maximumRevisions; revision++) {
    // Never search for a new revision without room for both compose and review.
    if (selected.review.coverage === "complete" || operations.length > 6) break;
    const found = selected.review.followUps.length
      ? await input.refineEvidence({ ...selected, operations: Object.freeze([...operations]) }, previousDraft) : null;
    let draft = found && knowledgeEvidenceRefinementAddsEvidence(previousDraft, found, selected) ? found : null;
    if (!draft) {
      // One factual correction per evidence set is justified by an accepted
      // requirement and bound premises, not by an unexplained retry request.
      if (workflowVersion !== 11 || selected.review.version !== 2 || correctedEvidence.has(previousDraft.manifestHash) ||
        !selected.review.requirements.some(requirement => requirement.status === "needs_correction")) break;
      correctedEvidence.add(previousDraft.manifestHash);
      draft = previousDraft;
    }
    refinementAttempted = true;
    const operationOffset = operations.length;
    try {
      const next = await executeCycle({ ...input, draft, workflowVersion, operationOffset,
        evidenceBindings: undefined, revision: selected, onOperationAccepted });
      // Preserve the useful publication while allowing a named, evidence-bound
      // error in the new candidate to be corrected within the remaining budget.
      if (!next.publication.blocks.length && lastUseful.publication.blocks.length &&
        !(workflowVersion === 11 && next.review.version === 2 &&
          next.review.requirements.some(requirement => requirement.status === "needs_correction"))) break;
      selected = next;
      if (next.publication.blocks.length) lastUseful = next;
      previousDraft = draft;
    } catch (error) {
      // Only an accepted closed failure/rejection can fall back. Authority,
      // cancellation and ambiguous I/O still stop the run.
      if (!(error instanceof KnowledgeAnswerProviderError) &&
        (!(error instanceof KnowledgeAnswerContractError) || !error.message.startsWith("Knowledge evidence answer failed:"))) throw error;
      break;
    } finally {
      const cycleOperations = operations.slice(operationOffset);
      compositionRepairAttempted ||= cycleOperations.filter(item => isKnowledgeEvidenceComposeOperation(item.operation)).length > 1;
      reviewRepairAttempted ||= cycleOperations.filter(item => !isKnowledgeEvidenceComposeOperation(item.operation)).length > 1;
    }
  }
  const publication = !selected.publication.blocks.length && lastUseful.publication.blocks.length ? lastUseful : selected;
  return Object.freeze({ ...publication, refinementAttempted, compositionRepairAttempted, reviewRepairAttempted,
    operations: Object.freeze(operations) });
}

export function knowledgeEvidenceRefinementAddsEvidence(previous: KnowledgeEvidenceDispatchManifestDraft,
  next: KnowledgeEvidenceDispatchManifestDraft, result: Pick<KnowledgeEvidenceAnswerExecutionV1Result, "publication">): boolean {
  if (!decodeKnowledgeEvidenceDispatchManifestDraft(next)) return false;
  const key = (item: KnowledgeEvidenceDispatchManifestDraft["items"][number]) => knowledgeAnswerHash({
    sourceAlias: item.sourceAlias, sourceVersionNumber: item.sourceVersionNumber, locator: item.locator,
    exactExcerpt: item.exactExcerpt, expandedContext: item.expandedContext ?? null
  });
  const oldKeys = new Set(previous.items.map(key));
  const supported = new Set(result.publication.blocks.flatMap(block => block.evidenceHandles));
  return previous.items.filter(item => supported.has(item.handle)).every(item =>
    next.items.some(candidate => candidate.handle === item.handle && key(candidate) === key(item))) &&
    next.items.some(item => !oldKeys.has(key(item)));
}
