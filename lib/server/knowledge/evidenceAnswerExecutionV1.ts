import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { acceptedOperation } from "./answerGroundingExecutionV21";
import { knowledgeAnswerHash } from "./answerGroundingV5";
import { KnowledgeAnswerContractError } from "./grounding";
import { decodeKnowledgeEvidenceDispatchManifestDraft, type KnowledgeEvidenceDispatchManifestDraft } from "./evidenceDispatchManifest";
import {
  buildKnowledgeEvidenceAnswerPublicationV1, decodeKnowledgeEvidenceAnswerDraftV1,
  knowledgeEvidenceAnswerDraftPromptV1, knowledgeEvidenceAnswerReviewPromptV1,
  validateKnowledgeEvidenceAnswerDraftV1, validateKnowledgeEvidenceAnswerReviewV1,
  type KnowledgeEvidenceAnswerDraftV1, type KnowledgeEvidenceAnswerPublicationV1,
  type KnowledgeEvidenceAnswerReviewV1, type KnowledgeEvidenceAnswerValidationV1
} from "./evidenceAnswerV1";
import {
  createKnowledgeEvidenceAnswerSnapshotV1, KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1
} from "./evidenceAnswerSnapshotV1";
import { createKnowledgeEvidenceAnswerSnapshotV2, isKnowledgeEvidenceAnswerOperationV2, KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2 } from "./evidenceAnswerSnapshotV2";
import { isKnowledgeEvidenceComposeOperation, type KnowledgeEvidenceAnswerOperation } from "./evidenceAnswerSnapshot";
import { buildKnowledgeEvidenceAnswerPublicationV2, decodeKnowledgeEvidenceAnswerReviewV2,
  knowledgeEvidenceAnswerDraftPromptV2, knowledgeEvidenceAnswerReviewPromptV2, validateKnowledgeEvidenceAnswerReviewV2,
  type KnowledgeEvidenceAnswerReviewV2 } from "./evidenceAnswerReviewV2";
import type { KnowledgeGroundingEffectiveExecutionPolicyV1 } from "./groundingExecutionPolicy";
import { EMPTY_KNOWLEDGE_COVERAGE_LIMITATIONS_V1 } from "./searchFailure";

type OperationInput = Parameters<typeof acceptedOperation>[0];
type OperationRecord = Readonly<Record<string, unknown>>;
type RejectionReason = Extract<KnowledgeEvidenceAnswerValidationV1<unknown>, { kind: "rejected" }>["reason"];
type Failure = Readonly<{ kind: "rejected"; reason: RejectionReason; version: 1 }> |
  Readonly<{ kind: "failed"; reason: "timeout" | "refusal" | "transport" | "provider_error"; version: 1 }>;

export function decodeKnowledgeEvidenceAnswerFailureV1(value: unknown): Failure | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || record.version !== 1) return null;
  if (record.kind === "rejected" && ["shape_invalid", "text_invalid", "capacity_exceeded", "evidence_invalid", "coverage_invalid"].includes(String(record.reason)) ||
    record.kind === "failed" && ["timeout", "refusal", "transport", "provider_error"].includes(String(record.reason))) return record as Failure;
  return null;
}
function providerFailure(error: unknown): Failure {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  return Object.freeze({ version: 1, kind: "failed", reason:
    name === "TimeoutError" || /timeout|deadline/iu.test(message) ? "timeout" :
    /refusal|refused/iu.test(message) ? "refusal" : error instanceof TypeError || /network|transport|fetch/iu.test(message) ? "transport" : "provider_error" });
}
function failed(reason: string): never {
  throw new KnowledgeAnswerContractError("knowledge_answer_contract_failed", `Knowledge evidence answer failed: ${reason}`);
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
    const snapshotInput = { evidenceReceiptHash: manifest!.manifestHash, executionPolicy: input.executionPolicy, transport: input.transport };
    const snapshot = isKnowledgeEvidenceAnswerOperationV2(inputOperation.operation)
      ? createKnowledgeEvidenceAnswerSnapshotV2({ ...inputOperation, ...snapshotInput, operation: inputOperation.operation, workflowVersion: 11 })
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
        const validation = validateKnowledgeEvidenceAnswerDraftV1(output, context);
        return validation.kind === "accepted" ? validation.value : { ...validation, version: 1 };
      } });
    draft = decodeKnowledgeEvidenceAnswerDraftV1(result, context);
    if (draft) break;
    const failure = decodeKnowledgeEvidenceAnswerFailureV1(result);
    if (failure?.kind !== "rejected") failed(failure?.reason ?? "accepted_draft_invalid");
    repairReason = failure.reason;
  }
  if (!draft) failed(repairReason ?? "draft_invalid");
  if (input.revision?.evidenceReceiptHash === manifest.manifestHash &&
    knowledgeAnswerHash(input.revision.draft) === knowledgeAnswerHash(draft)) failed("revision_unchanged");
  let review: KnowledgeEvidenceAnswerReviewV1 | KnowledgeEvidenceAnswerReviewV2 | null = null;
  repairReason = undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await operation({ operation: reviewV2 ? "knowledge_evidence_review_v2" : "knowledge_evidence_review_v1", draftPayloadHash: knowledgeAnswerHash(draft),
      ...(reviewV2 ? knowledgeEvidenceAnswerReviewPromptV2 : knowledgeEvidenceAnswerReviewPromptV1)({ request: input.request, evidenceManifest: manifest.message,
        draft, availableSourceAliases: context.availableSourceAliases, repairReason }),
      accept(output) {
        const validation = (reviewV2 ? validateKnowledgeEvidenceAnswerReviewV2 : validateKnowledgeEvidenceAnswerReviewV1)(output, { ...context, draft: draft! });
        return validation.kind === "accepted" ? validation.value : { ...validation, version: 1 };
      } });
    if (reviewV2) review = decodeKnowledgeEvidenceAnswerReviewV2(result, { ...context, draft });
    else {
      const validation = validateKnowledgeEvidenceAnswerReviewV1(result, { ...context, draft });
      if (validation.kind === "accepted") review = validation.value;
    }
    if (review) break;
    const failure = decodeKnowledgeEvidenceAnswerFailureV1(result);
    if (failure?.kind !== "rejected") failed(failure?.reason ?? "accepted_review_invalid");
    repairReason = failure.reason;
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
      if (!(error instanceof KnowledgeAnswerContractError) || !error.message.startsWith("Knowledge evidence answer failed:")) throw error;
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
