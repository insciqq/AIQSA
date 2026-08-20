import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import {
  applyKnowledgeStrategyStepCasTransitionV1,
  createKnowledgeStrategyCoverageRequestV1,
  createKnowledgeStrategyDependencyV1,
  createKnowledgeStrategyExecutionRequestV1,
  createKnowledgeStrategyStepReceiptV1,
  createKnowledgeStrategyStepRequestV1,
  createKnowledgeStrategyStepTemplateV1,
  decodeKnowledgeStrategyCoverageReceiptV1,
  decodeKnowledgeStrategyStepEvidenceV1,
  decodeKnowledgeStrategyStepLifecycleV1,
  deriveKnowledgeStrategyMapOutputDependencyHashV2,
  deriveKnowledgeStrategyCoverageReceiptV1,
  hashKnowledgeStrategyCursorV1,
  hashKnowledgeStrategyDependencyV1,
  hashKnowledgeStrategyExecutionRequestV1,
  hashKnowledgeStrategyStepReceiptV1,
  hashKnowledgeStrategyStepRequestV1,
  hashKnowledgeStrategyStepTemplateV1,
  knowledgeStrategyTemplateInvariantReasonCodesV1,
  materializeKnowledgeStrategyStepRequestV1,
  KNOWLEDGE_STRATEGY_MAX_SOURCES,
  validateKnowledgeStrategyDagV1,
  validateKnowledgeStrategyStepMaterializationV1,
  type KnowledgeStrategyCoverageReceiptV1,
  type KnowledgeStrategyCoverageRequestV1,
  type KnowledgeStrategyDependencyV1,
  type KnowledgeStrategyExecutionRequestV1,
  type KnowledgeStrategyStepEvidenceV1,
  type KnowledgeStrategyStepLifecycleV1,
  type KnowledgeStrategyStepReceiptV1,
  type KnowledgeStrategyStepRequestV1,
  type KnowledgeStrategyStepTemplateV1,
  type KnowledgeStrategyStepState
} from "./knowledgeStrategyExecution";
import {
  createKnowledgeStrategyMapOutputReceiptV2,
  decodeKnowledgeStrategyMapOutputReceiptV2,
  decodeKnowledgeStrategyMapOutputV2,
  hashKnowledgeStrategyMapOutputReceiptV2,
  hashKnowledgeStrategyMapOutputV2,
  type KnowledgeStrategyMapOutputReceiptV2,
  type KnowledgeStrategyMapOutputV2
} from "./knowledgeStrategyMapOutput";

const SERIALIZABLE_ATTEMPTS = 4;
const MAX_LEASE_MS = 3_630_000;
const HASH = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

const mapOutputSelect = {
  createdAt: true,
  executionId: true,
  id: true,
  inputPageReceiptCount: true,
  inputPageReceiptsHash: true,
  inputPassageCount: true,
  inputPassageItemsHash: true,
  inputSectionCount: true,
  inputSectionHashesHash: true,
  mapInputHash: true,
  modelRunId: true,
  output: true,
  outputHash: true,
  processedPassageCount: true,
  purgedAt: true,
  receipt: true,
  receiptHash: true,
  settledAt: true,
  sourceBindingId: true,
  sourceOrdinal: true,
  state: true,
  summaryItemCount: true,
  summaryItemsHash: true,
  terminalStepId: true,
  updatedAt: true,
  version: true
} satisfies Prisma.KnowledgeStrategyMapOutputSelect;

const stepSelect = {
  ambiguousAt: true,
  attemptCount: true,
  cancelledAt: true,
  comparisonDimensionHash: true,
  createdAt: true,
  cursor: true,
  cursorHash: true,
  dependencies: {
    orderBy: { dependsOnStepId: "asc" as const },
    select: { dependsOnStepId: true, executionId: true, stepId: true }
  },
  evidenceInputHash: true,
  executionId: true,
  failedAt: true,
  failureCode: true,
  id: true,
  idempotencyKey: true,
  includedPassageCount: true,
  inputHash: true,
  ioStartedAt: true,
  irreversibleDispatch: true,
  kind: true,
  materializationMode: true,
  materializedAt: true,
  leaseExpiresAt: true,
  leaseToken: true,
  modelRunId: true,
  modelRunToolCallId: true,
  ordinal: true,
  pageOrdinal: true,
  phaseOrdinal: true,
  processedItemsHash: true,
  processedPassageCount: true,
  processedSourceCount: true,
  providerAttemptId: true,
  purgedAt: true,
  request: true,
  requestHash: true,
  required: true,
  result: true,
  resultHash: true,
  settledAt: true,
  sourceBindingId: true,
  sourceSetHash: true,
  startedAt: true,
  state: true,
  stateVersion: true,
  streamId: true,
  targetOrdinal: true,
  templateHash: true,
  updatedAt: true
} satisfies Prisma.KnowledgeStrategyStepSelect;

const executionSelect = {
  ambiguousAt: true,
  cancelledAt: true,
  coverageReceipt: true,
  coverageReceiptHash: true,
  coverageStatus: true,
  createdAt: true,
  dispatchManifestHash: true,
  dispatchedPassageCount: true,
  dispatchSetHash: true,
  executionHash: true,
  executionRequest: true,
  expectedPassageCount: true,
  expectedSourceCount: true,
  failedAt: true,
  failureCode: true,
  id: true,
  includedPassageCount: true,
  includedSetHash: true,
  mapOutputs: { orderBy: { sourceOrdinal: "asc" as const }, select: mapOutputSelect },
  modelRunId: true,
  planHash: true,
  plannerVersion: true,
  processedPassageCount: true,
  processedSetHash: true,
  processedSourceCount: true,
  purgedAt: true,
  retrievalSessionId: true,
  settledAt: true,
  sourceSetHash: true,
  startedAt: true,
  state: true,
  steps: { orderBy: { ordinal: "asc" as const }, select: stepSelect },
  strategy: true,
  updatedAt: true,
  version: true
} satisfies Prisma.KnowledgeStrategyExecutionSelect;

type ExecutionRow = Prisma.KnowledgeStrategyExecutionGetPayload<{
  select: typeof executionSelect;
}>;
type StepRow = ExecutionRow["steps"][number];
type MapOutputRow = ExecutionRow["mapOutputs"][number];

export type StoredKnowledgeStrategyStep = Readonly<{
  createdAt: Date;
  cursor: KnowledgeStrategyStepReceiptV1["nextCursor"];
  includedPassageCount: number;
  lifecycle: KnowledgeStrategyStepLifecycleV1;
  materializedAt: Date | null;
  modelRunToolCallId: string | null;
  processedPassageCount: number;
  processedSourceCount: number;
  providerAttemptId: string | null;
  purgedAt: Date | null;
  receipt: KnowledgeStrategyStepReceiptV1 | null;
  request: KnowledgeStrategyStepRequestV1 | null;
  settledAt: Date | null;
  template: KnowledgeStrategyStepTemplateV1 | null;
  updatedAt: Date;
}>;

export type StoredKnowledgeStrategyMapOutput = Readonly<{
  createdAt: Date;
  executionId: string;
  id: string;
  modelRunId: string;
  output: KnowledgeStrategyMapOutputV2 | null;
  purgedAt: Date | null;
  receipt: KnowledgeStrategyMapOutputReceiptV2 | null;
  settledAt: Date;
  sourceOrdinal: number;
  state: "available" | "purged";
  terminalStepId: string;
  updatedAt: Date;
}>;

export type StoredKnowledgeStrategyExecution = Readonly<{
  coverage: KnowledgeStrategyCoverageReceiptV1 | null;
  createdAt: Date;
  dependencies: readonly KnowledgeStrategyDependencyV1[];
  dispatchManifestHash: string | null;
  execution: KnowledgeStrategyExecutionRequestV1 | null;
  failureCode: string | null;
  includedPassageCount: number;
  mapOutputs: readonly StoredKnowledgeStrategyMapOutput[];
  modelRunId: string;
  processedPassageCount: number;
  processedSourceCount: number;
  purgedAt: Date | null;
  retrievalSessionId: string;
  state: "planned" | "running" | "settled" | "partial" | "failed" | "ambiguous" | "cancelled";
  steps: readonly StoredKnowledgeStrategyStep[];
  updatedAt: Date;
}>;

export type KnowledgeStrategyStepToolCallBinding = Readonly<{
  modelRunToolCallId: string;
  stepId: string;
}>;

export type CreateKnowledgeStrategyExecutionInput = Readonly<{
  dependencies: readonly unknown[];
  execution: unknown;
  retrievalSessionId: string;
  steps: readonly unknown[];
  toolCallBindings?: readonly KnowledgeStrategyStepToolCallBinding[];
}>;

export type KnowledgeStrategyStepClaim = Readonly<{
  execution: StoredKnowledgeStrategyExecution;
  kind: "claimed";
  leaseToken: string;
  step: StoredKnowledgeStrategyStep;
}>;

export type KnowledgeStrategyClaimResult = KnowledgeStrategyStepClaim | Readonly<{
  execution: StoredKnowledgeStrategyExecution;
  kind: "none";
}>;

export type KnowledgeStrategyMutationResult = Readonly<{
  execution: StoredKnowledgeStrategyExecution;
  kind: "idempotent" | "transitioned";
  step: StoredKnowledgeStrategyStep;
}>;

export type KnowledgeStrategyStepEvidenceRecord = Readonly<{
  coverage: KnowledgeStrategyCoverageReceiptV1 | null;
  evidence: KnowledgeStrategyStepEvidenceV1;
  executionState: StoredKnowledgeStrategyExecution["state"];
}>;

export type KnowledgeStrategyRepositoryErrorCode =
  | "cas_mismatch"
  | "coverage_not_monotonic"
  | "execution_conflict"
  | "execution_not_finalizable"
  | "invalid_input"
  | "invalid_state"
  | "lease_expired"
  | "lease_fenced"
  | "map_output_conflict"
  | "map_output_incomplete"
  | "not_found"
  | "plan_invalid"
  | "purged"
  | "source_changed"
  | "stored_state_invalid";

export class KnowledgeStrategyRepositoryError extends Error {
  readonly code: KnowledgeStrategyRepositoryErrorCode;

  constructor(code: KnowledgeStrategyRepositoryErrorCode) {
    super(`knowledge_strategy_repository_${code}`);
    this.name = "KnowledgeStrategyRepositoryError";
    this.code = code;
  }
}

class KnowledgeStrategyClaimRaceError extends Error {}

function repositoryError(code: KnowledgeStrategyRepositoryErrorCode): never {
  throw new KnowledgeStrategyRepositoryError(code);
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function hashValue(value: string | null): string | null {
  return value?.trim() ?? null;
}

function validIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

function compareIdentifier(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validReason(value: string): boolean {
  return REASON_CODE.test(value);
}

function validHash(value: string): boolean {
  return HASH.test(value);
}

function serializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (
    error.code === "P2034" || error.code === "P2002" ||
    error.code === "P2010" && error.meta?.code === "40001"
  );
}

async function serializable<T>(
  client: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await client.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error) {
      if (attempt < SERIALIZABLE_ATTEMPTS - 1 &&
        (serializationConflict(error) || error instanceof KnowledgeStrategyClaimRaceError)) {
        continue;
      }
      if (error instanceof KnowledgeStrategyClaimRaceError) repositoryError("cas_mismatch");
      throw error;
    }
  }
  return repositoryError("cas_mismatch");
}

function state(value: string): StoredKnowledgeStrategyExecution["state"] {
  if (["planned", "running", "settled", "partial", "failed", "ambiguous", "cancelled"]
    .includes(value)) return value as StoredKnowledgeStrategyExecution["state"];
  return repositoryError("stored_state_invalid");
}

function stepState(value: string): KnowledgeStrategyStepState {
  if (["pending", "running", "settled", "failed", "ambiguous", "cancelled", "purged"]
    .includes(value)) return value as KnowledgeStrategyStepState;
  return repositoryError("stored_state_invalid");
}

function lifecycle(row: StepRow): KnowledgeStrategyStepLifecycleV1 {
  const decoded = decodeKnowledgeStrategyStepLifecycleV1({
    attemptCount: row.attemptCount,
    executionId: row.executionId,
    failureCode: row.failureCode,
    irreversibleDispatch: row.irreversibleDispatch,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    leaseToken: row.leaseToken,
    receiptHash: row.state === "settled" ? hashValue(row.resultHash) : null,
    state: row.state,
    stateVersion: row.stateVersion,
    stepId: row.id,
    version: 1
  });
  return decoded ?? repositoryError("stored_state_invalid");
}

function strictReceipt(row: StepRow): KnowledgeStrategyStepReceiptV1 | null {
  if (row.result === null) {
    if (row.resultHash !== null || row.processedItemsHash !== null || row.cursor !== null ||
      row.cursorHash !== null) repositoryError("stored_state_invalid");
    return null;
  }
  const receipt = createKnowledgeStrategyStepReceiptV1(row.result);
  const receiptHash = hashKnowledgeStrategyStepReceiptV1(receipt);
  if (hashValue(row.resultHash) !== receiptHash ||
    hashValue(row.processedItemsHash) !== receipt.processedItemsHash ||
    row.processedPassageCount !== receipt.processedItemCount ||
    (receipt.nextCursor === null) !== (row.cursor === null) ||
    receipt.nextCursor !== null && (
      hashValue(row.cursorHash) !== hashKnowledgeStrategyCursorV1(receipt.nextCursor) ||
      hashKnowledgeStrategyCursorV1(row.cursor) !== hashKnowledgeStrategyCursorV1(receipt.nextCursor)
    )) repositoryError("stored_state_invalid");
  const validStatus = row.state === "settled"
    ? receipt.status === "succeeded" || receipt.status === "unavailable"
    : row.state === receipt.status;
  if (!validStatus) repositoryError("stored_state_invalid");
  return receipt;
}

function strictTemplate(
  row: StepRow,
  request: KnowledgeStrategyStepRequestV1 | null
): KnowledgeStrategyStepTemplateV1 {
  const dynamicCursor = row.materializationMode === "cursor_from_predecessor";
  const dynamicEvidence = row.materializationMode === "evidence_from_prerequisites";
  const template = createKnowledgeStrategyStepTemplateV1({
    comparisonDimensionHash: hashValue(row.comparisonDimensionHash),
    cursor: dynamicCursor ? null : request?.cursor ?? null,
    evidenceInputHash: dynamicEvidence ? null : hashValue(row.evidenceInputHash),
    executionId: row.executionId,
    inputHash: hashValue(row.inputHash),
    kind: row.kind,
    materializationMode: row.materializationMode,
    ordinal: row.ordinal,
    pageOrdinal: row.pageOrdinal,
    phaseOrdinal: row.phaseOrdinal,
    required: row.required,
    sourceBindingId: row.sourceBindingId,
    sourceSetHash: hashValue(row.sourceSetHash),
    stepId: row.id,
    strategy: request?.strategy ?? (row.kind === "full_context_page" ? "full_context" :
      row.kind === "comparison_target" ? "comparison" :
      row.kind === "exhaustive_page" ? "exhaustive" :
      row.kind === "corpus_summary_map" || row.kind === "corpus_summary_reduce"
        ? "corpus_summary"
        : "multi_hop"),
    streamId: row.streamId,
    targetOrdinal: row.targetOrdinal,
    version: 1
  });
  const templateHash = hashKnowledgeStrategyStepTemplateV1(template);
  if (hashValue(row.templateHash) !== templateHash || row.idempotencyKey !== templateHash) {
    repositoryError("stored_state_invalid");
  }
  return template;
}

function strictStep(row: StepRow, execution: KnowledgeStrategyExecutionRequestV1 | null): StoredKnowledgeStrategyStep {
  if (row.purgedAt !== null) {
    if (row.state !== "purged" || row.request !== null || row.result !== null ||
      row.modelRunToolCallId !== null || row.providerAttemptId !== null ||
      row.sourceBindingId !== null) repositoryError("stored_state_invalid");
    return Object.freeze({
      createdAt: row.createdAt,
      cursor: null,
      includedPassageCount: row.includedPassageCount,
      lifecycle: Object.freeze({
        attemptCount: row.attemptCount,
        executionId: row.executionId,
        failureCode: null,
        irreversibleDispatch: row.irreversibleDispatch,
        leaseExpiresAt: null,
        leaseToken: null,
        receiptHash: null,
        state: "purged",
        stateVersion: row.stateVersion,
        stepId: row.id,
        version: 1
      }),
      modelRunToolCallId: null,
      materializedAt: null,
      processedPassageCount: row.processedPassageCount,
      processedSourceCount: row.processedSourceCount,
      providerAttemptId: null,
      purgedAt: row.purgedAt,
      receipt: null,
      request: null,
      settledAt: row.settledAt,
      template: null,
      updatedAt: row.updatedAt
    });
  }
  if (!execution) repositoryError("stored_state_invalid");
  const request = row.request === null ? null : createKnowledgeStrategyStepRequestV1(row.request);
  const requestHash = request ? hashKnowledgeStrategyStepRequestV1(request) : null;
  if (row.executionId !== execution.executionId || row.modelRunId !== execution.modelRunId ||
    request && (request.executionId !== execution.executionId ||
      request.strategy !== execution.strategy || request.sourceSetHash !== execution.sourceSetHash ||
      row.id !== request.stepId || hashValue(row.requestHash) !== requestHash ||
      row.ordinal !== request.ordinal || row.kind !== request.kind ||
      row.phaseOrdinal !== request.phaseOrdinal || row.streamId !== request.streamId ||
      row.pageOrdinal !== request.pageOrdinal || row.targetOrdinal !== request.targetOrdinal ||
      row.required !== request.required || row.sourceBindingId !== request.sourceBindingId ||
      hashValue(row.inputHash) !== request.inputHash ||
      hashValue(row.evidenceInputHash) !== request.evidenceInputHash ||
      hashValue(row.sourceSetHash) !== request.sourceSetHash) ||
    !request && (row.requestHash !== null || row.materializedAt !== null || row.state !== "pending")) {
    repositoryError("stored_state_invalid");
  }
  const template = strictTemplate(row, request);
  if (template.executionId !== execution.executionId || template.strategy !== execution.strategy ||
    template.sourceSetHash !== execution.sourceSetHash ||
    (request !== null) !== (row.materializedAt !== null)) repositoryError("stored_state_invalid");
  const receipt = strictReceipt(row);
  if (receipt && !request) repositoryError("stored_state_invalid");
  return Object.freeze({
    createdAt: row.createdAt,
    cursor: receipt?.nextCursor ?? null,
    includedPassageCount: row.includedPassageCount,
    lifecycle: lifecycle(row),
    materializedAt: row.materializedAt,
    modelRunToolCallId: row.modelRunToolCallId,
    processedPassageCount: row.processedPassageCount,
    processedSourceCount: row.processedSourceCount,
    providerAttemptId: row.providerAttemptId,
    purgedAt: null,
    receipt,
    request,
    settledAt: row.settledAt,
    template,
    updatedAt: row.updatedAt
  });
}

function mapOutputHashesAreNull(row: MapOutputRow): boolean {
  return row.mapInputHash === null && row.outputHash === null && row.receiptHash === null &&
    row.inputPageReceiptsHash === null && row.inputPassageItemsHash === null &&
    row.inputSectionHashesHash === null && row.summaryItemsHash === null;
}

export function hydrateKnowledgeStrategyMapOutputRow(
  row: MapOutputRow
): StoredKnowledgeStrategyMapOutput {
  const countsValid = row.version === 2 && Number.isInteger(row.sourceOrdinal) &&
    row.sourceOrdinal >= 0 && row.sourceOrdinal <= KNOWLEDGE_STRATEGY_MAX_SOURCES - 1 &&
    Number.isInteger(row.inputPageReceiptCount) && row.inputPageReceiptCount >= 1 &&
    row.inputPageReceiptCount <= 4_096 && Number.isInteger(row.inputPassageCount) &&
    row.inputPassageCount >= 1 && row.inputPassageCount <= 10_000_000 &&
    Number.isInteger(row.inputSectionCount) && row.inputSectionCount >= 1 &&
    row.inputSectionCount <= 64 && row.processedPassageCount === row.inputPassageCount &&
    row.summaryItemCount === row.inputSectionCount;
  if (!countsValid) repositoryError("stored_state_invalid");
  if (row.purgedAt !== null) {
    if (row.state !== "purged" || row.sourceBindingId !== null || row.output !== null ||
      row.receipt !== null || !mapOutputHashesAreNull(row)) {
      repositoryError("stored_state_invalid");
    }
    return Object.freeze({
      createdAt: row.createdAt,
      executionId: row.executionId,
      id: row.id,
      modelRunId: row.modelRunId,
      output: null,
      purgedAt: row.purgedAt,
      receipt: null,
      settledAt: row.settledAt,
      sourceOrdinal: row.sourceOrdinal,
      state: "purged",
      terminalStepId: row.terminalStepId,
      updatedAt: row.updatedAt
    });
  }
  const output = decodeKnowledgeStrategyMapOutputV2(row.output);
  const receipt = decodeKnowledgeStrategyMapOutputReceiptV2(row.receipt);
  if (row.state !== "available" || row.sourceBindingId === null || !output || !receipt) {
    repositoryError("stored_state_invalid");
  }
  const expectedReceipt = createKnowledgeStrategyMapOutputReceiptV2(output);
  if (hashKnowledgeStrategyMapOutputReceiptV2(expectedReceipt) !==
      hashKnowledgeStrategyMapOutputReceiptV2(receipt) ||
    output.executionId !== row.executionId || output.terminalStepId !== row.terminalStepId ||
    output.sourceBindingId !== row.sourceBindingId || output.sourceOrdinal !== row.sourceOrdinal ||
    output.mapInputHash !== hashValue(row.mapInputHash) ||
    output.outputHash !== hashValue(row.outputHash) ||
    receipt.receiptHash !== hashValue(row.receiptHash) ||
    output.inputPageReceiptCount !== row.inputPageReceiptCount ||
    output.inputPageReceiptsHash !== hashValue(row.inputPageReceiptsHash) ||
    output.inputPassageCount !== row.inputPassageCount ||
    output.inputPassageItemsHash !== hashValue(row.inputPassageItemsHash) ||
    output.inputSectionCount !== row.inputSectionCount ||
    output.inputSectionHashesHash !== hashValue(row.inputSectionHashesHash) ||
    output.processedPassageCount !== row.processedPassageCount ||
    output.summaryItemCount !== row.summaryItemCount ||
    output.summaryItemsHash !== hashValue(row.summaryItemsHash)) {
    repositoryError("stored_state_invalid");
  }
  return Object.freeze({
    createdAt: row.createdAt,
    executionId: row.executionId,
    id: row.id,
    modelRunId: row.modelRunId,
    output,
    purgedAt: null,
    receipt,
    settledAt: row.settledAt,
    sourceOrdinal: row.sourceOrdinal,
    state: "available",
    terminalStepId: row.terminalStepId,
    updatedAt: row.updatedAt
  });
}

export function hydrateKnowledgeStrategyExecutionRow(row: ExecutionRow): StoredKnowledgeStrategyExecution {
  const execution = row.executionRequest === null
    ? null
    : createKnowledgeStrategyExecutionRequestV1(row.executionRequest);
  if (row.purgedAt === null) {
    if (!execution || execution.executionId !== row.id || execution.modelRunId !== row.modelRunId ||
      execution.plannerVersion !== row.plannerVersion || execution.strategy !== row.strategy ||
      execution.planHash !== hashValue(row.planHash) ||
      execution.sourceSetHash !== hashValue(row.sourceSetHash) ||
      hashKnowledgeStrategyExecutionRequestV1(execution) !== hashValue(row.executionHash) ||
      execution.sourceSet.length !== row.expectedSourceCount ||
      execution.sourceSet.reduce((sum, source) => sum + source.passageCount, 0) !==
        row.expectedPassageCount) repositoryError("stored_state_invalid");
  } else if (execution !== null || row.planHash !== null || row.executionHash !== null ||
    row.sourceSetHash !== null || row.coverageReceipt !== null) {
    repositoryError("stored_state_invalid");
  }
  const mapOutputs = Object.freeze((row.mapOutputs ?? []).map(
    hydrateKnowledgeStrategyMapOutputRow
  ));
  if (mapOutputs.some((mapOutput, index) =>
    mapOutput.executionId !== row.id || mapOutput.modelRunId !== row.modelRunId ||
    index > 0 && mapOutput.sourceOrdinal <= mapOutputs[index - 1]!.sourceOrdinal ||
    execution === null && mapOutput.state !== "purged" ||
    execution !== null && (
      mapOutput.state !== "available" || !mapOutput.output || !mapOutput.receipt ||
      execution.strategy !== "corpus_summary" ||
      execution.sourceSet[mapOutput.sourceOrdinal]?.bindingId !==
        mapOutput.output.sourceBindingId ||
      execution.sourceSet[mapOutput.sourceOrdinal]?.sourceAlias !==
        mapOutput.output.sourceAlias ||
      execution.sourceSet[mapOutput.sourceOrdinal]?.sourceArtifactId !==
        mapOutput.output.sourceArtifactId ||
      execution.sourceSet[mapOutput.sourceOrdinal]?.sourceId !== mapOutput.output.sourceId ||
      execution.sourceSet[mapOutput.sourceOrdinal]?.sourceVersionId !==
        mapOutput.output.sourceVersionId
    ))) repositoryError("stored_state_invalid");
  const steps = Object.freeze(row.steps.map((step) => strictStep(step, execution)));
  const dependencies = Object.freeze(row.steps.flatMap((step) => step.dependencies.map((entry) =>
    createKnowledgeStrategyDependencyV1({
      dependentStepId: entry.stepId,
      executionId: entry.executionId,
      prerequisiteStepId: entry.dependsOnStepId,
      version: 1
    }))));
  if (execution) {
    const templates = steps.map(({ template }) => template).filter(
      (template): template is KnowledgeStrategyStepTemplateV1 => template !== null
    );
    const dag = validateKnowledgeStrategyDagV1(execution.executionId, templates, dependencies);
    if (!dag.valid || templates.length !== steps.length || templates.some((template) =>
      template.executionId !== execution.executionId || template.strategy !== execution.strategy ||
      template.sourceSetHash !== execution.sourceSetHash) ||
      knowledgeStrategyTemplateInvariantReasonCodesV1(execution, templates, dependencies)
        .length > 0) repositoryError("stored_state_invalid");
    for (const step of steps) {
      if (!step.template || !step.request) continue;
      const prerequisiteIds = dependencies.filter(({ dependentStepId }) =>
        dependentStepId === step.request!.stepId).map(({ prerequisiteStepId }) => prerequisiteStepId);
      const prerequisites = prerequisiteIds.flatMap((stepId) => {
        const prerequisite = steps.find(({ request }) => request?.stepId === stepId);
        return prerequisite?.request && prerequisite.receipt
          ? [{ receipt: prerequisite.receipt, request: prerequisite.request }]
          : [];
      });
      if (step.request.kind !== "corpus_summary_reduce" &&
        !validateKnowledgeStrategyStepMaterializationV1(
        step.template,
        step.request,
        dependencies,
        prerequisites
      )) repositoryError("stored_state_invalid");
    }
    const reduceSteps = steps.filter((step) =>
      step.request?.kind === "corpus_summary_reduce");
    if (reduceSteps.some((step) => {
      if (!step.request || !step.template || mapOutputs.length !== execution.sourceSet.length ||
        mapOutputs.some((mapOutput) => !mapOutput.receipt)) return true;
      const directDependencyIds = dependencies.filter(({ dependentStepId }) =>
        dependentStepId === step.request!.stepId).map(({ prerequisiteStepId }) =>
        prerequisiteStepId).sort(compareIdentifier);
      if (directDependencyIds.length !== mapOutputs.length ||
        directDependencyIds.some((stepId) => !mapOutputs.some((mapOutput) =>
          mapOutput.terminalStepId === stepId)) || mapOutputs.some((mapOutput) =>
          !directDependencyIds.includes(mapOutput.terminalStepId))) return true;
      try {
        const dependencyHash = deriveKnowledgeStrategyMapOutputDependencyHashV2({
          dependentStepId: step.request.stepId,
          executionId: execution.executionId,
          receipts: mapOutputs.map(({ receipt }) => receipt!),
          sourceSetHash: execution.sourceSetHash
        });
        const { materializationMode: _materializationMode, ...requestShape } = step.template;
        const expected = createKnowledgeStrategyStepRequestV1({
          ...requestShape,
          evidenceInputHash: dependencyHash
        });
        return hashKnowledgeStrategyStepRequestV1(expected) !==
          hashKnowledgeStrategyStepRequestV1(step.request);
      } catch {
        return true;
      }
    })) repositoryError("stored_state_invalid");
  }
  const coverage = row.coverageReceipt === null
    ? null
    : decodeKnowledgeStrategyCoverageReceiptV1(row.coverageReceipt);
  if (row.coverageReceipt !== null && (!coverage ||
    coverage.receiptHash !== hashValue(row.coverageReceiptHash))) {
    repositoryError("stored_state_invalid");
  }
  if (coverage && (
    coverage.executionId !== row.id || coverage.executionHash !== hashValue(row.executionHash) ||
    coverage.sourceSetHash !== hashValue(row.sourceSetHash) ||
    coverage.processedSourceCount !== row.processedSourceCount ||
    coverage.processedPassageCount !== row.processedPassageCount ||
    coverage.dispatchExpectedItemCount !== row.includedPassageCount ||
    coverage.dispatchIncludedItemCount !== row.dispatchedPassageCount ||
    coverage.processedItemsHash !== hashValue(row.processedSetHash) ||
    coverage.expectedItemsHash !== hashValue(row.includedSetHash) ||
    coverage.includedItemsHash !== hashValue(row.dispatchSetHash) ||
    coverage.dispatchManifestHash !== hashValue(row.dispatchManifestHash)
  )) repositoryError("stored_state_invalid");
  if ((row.state === "settled" || row.state === "partial") !== (coverage !== null) &&
    row.purgedAt === null) repositoryError("stored_state_invalid");
  return Object.freeze({
    coverage,
    createdAt: row.createdAt,
    dependencies,
    dispatchManifestHash: hashValue(row.dispatchManifestHash),
    execution,
    failureCode: row.failureCode,
    includedPassageCount: row.includedPassageCount,
    mapOutputs,
    modelRunId: row.modelRunId,
    processedPassageCount: row.processedPassageCount,
    processedSourceCount: row.processedSourceCount,
    purgedAt: row.purgedAt,
    retrievalSessionId: row.retrievalSessionId,
    state: state(row.state),
    steps,
    updatedAt: row.updatedAt
  });
}

async function loadRow(
  tx: Prisma.TransactionClient,
  where: Prisma.KnowledgeStrategyExecutionWhereUniqueInput
): Promise<ExecutionRow | null> {
  return tx.knowledgeStrategyExecution.findUnique({ select: executionSelect, where });
}

async function requireRow(
  tx: Prisma.TransactionClient,
  executionId: string
): Promise<ExecutionRow> {
  const row = await loadRow(tx, { id: executionId });
  return row ?? repositoryError("not_found");
}

function decodePlan(input: CreateKnowledgeStrategyExecutionInput): Readonly<{
  dependencies: readonly KnowledgeStrategyDependencyV1[];
  execution: KnowledgeStrategyExecutionRequestV1;
  steps: readonly KnowledgeStrategyStepTemplateV1[];
  toolCalls: ReadonlyMap<string, string>;
}> {
  if (!validIdentifier(input.retrievalSessionId)) repositoryError("invalid_input");
  const execution = createKnowledgeStrategyExecutionRequestV1(input.execution);
  const steps = input.steps.map(createKnowledgeStrategyStepTemplateV1).sort((left, right) =>
    left.ordinal - right.ordinal || compareIdentifier(left.stepId, right.stepId));
  const dependencies = input.dependencies.map(createKnowledgeStrategyDependencyV1).sort(
    (left, right) => compareIdentifier(left.dependentStepId, right.dependentStepId) ||
      compareIdentifier(left.prerequisiteStepId, right.prerequisiteStepId)
  );
  const dag = validateKnowledgeStrategyDagV1(execution.executionId, steps, dependencies);
  if (!dag.valid || knowledgeStrategyTemplateInvariantReasonCodesV1(
    execution,
    steps,
    dependencies
  ).length > 0) {
    repositoryError("plan_invalid");
  }
  const bindings = input.toolCallBindings ?? [];
  if (bindings.some(({ modelRunToolCallId, stepId }) =>
    !validIdentifier(modelRunToolCallId) || !validIdentifier(stepId)) ||
    new Set(bindings.map(({ stepId }) => stepId)).size !== bindings.length ||
    new Set(bindings.map(({ modelRunToolCallId }) => modelRunToolCallId)).size !== bindings.length ||
    bindings.some(({ stepId }) => !steps.some((step) => step.stepId === stepId))) {
    repositoryError("invalid_input");
  }
  return { dependencies, execution, steps, toolCalls: new Map(
    bindings.map(({ modelRunToolCallId, stepId }) => [stepId, modelRunToolCallId])
  ) };
}

async function assertFrozenSources(
  tx: Prisma.TransactionClient,
  execution: KnowledgeStrategyExecutionRequestV1
): Promise<void> {
  const bindingIds = execution.sourceSet.map(({ bindingId }) => bindingId).sort();
  const lockedBindings = await tx.$queryRaw<readonly { id: string }[]>`
    SELECT "id"
    FROM "KnowledgeRunSourceBinding"
    WHERE "id" IN (${Prisma.join(bindingIds)})
    ORDER BY "id"
    FOR SHARE
  `;
  if (lockedBindings.length !== bindingIds.length) repositoryError("source_changed");
  const bindings = await tx.knowledgeRunSourceBinding.findMany({
    select: {
      id: true,
      modelRunId: true,
      ordinal: true,
      readinessState: true,
      sourceAlias: true,
      sourceArtifact: {
        select: {
          hierarchicalIndexes: {
            select: { checksum: true, id: true, passageCount: true, state: true }
          },
          id: true,
          state: true
        }
      },
      sourceArtifactId: true,
      sourceId: true,
      sourceVersionId: true,
      sourceVersionNumber: true,
      tombstonedAt: true
    },
    where: { id: { in: execution.sourceSet.map(({ bindingId }) => bindingId) } }
  });
  if (bindings.length !== execution.sourceSet.length) repositoryError("source_changed");
  const byId = new Map(bindings.map((binding) => [binding.id, binding]));
  for (const source of execution.sourceSet) {
    const binding = byId.get(source.bindingId);
    const hierarchy = binding?.sourceArtifact?.hierarchicalIndexes.find(
      ({ id }) => id === source.hierarchicalArtifactId
    );
    if (!binding || binding.modelRunId !== execution.modelRunId ||
      binding.readinessState !== "ready" || binding.tombstonedAt !== null ||
      binding.ordinal !== source.ordinal || binding.sourceAlias !== source.sourceAlias ||
      binding.sourceId !== source.sourceId || binding.sourceVersionId !== source.sourceVersionId ||
      binding.sourceArtifactId !== source.sourceArtifactId ||
      binding.sourceVersionNumber !== source.sourceVersionNumber ||
      binding.sourceArtifact?.id !== source.sourceArtifactId ||
      binding.sourceArtifact.state !== "ready" || hierarchy?.state !== "ready" ||
      hierarchy.checksum?.trim() !== source.hierarchicalChecksum ||
      hierarchy.passageCount !== source.passageCount) repositoryError("source_changed");
  }
}

function findStoredStep(
  execution: StoredKnowledgeStrategyExecution,
  stepId: string
): StoredKnowledgeStrategyStep {
  return execution.steps.find(({ lifecycle: step }) => step.stepId === stepId) ??
    repositoryError("stored_state_invalid");
}

function assertLeaseInput(input: Readonly<{
  at: Date;
  executionId: string;
  leaseToken: string;
  stateVersion: number;
  stepId: string;
}>): void {
  if (!(input.at instanceof Date) || Number.isNaN(input.at.valueOf()) ||
    !validIdentifier(input.executionId) || !validIdentifier(input.stepId) ||
    !validIdentifier(input.leaseToken) || !Number.isInteger(input.stateVersion) ||
    input.stateVersion < 0) repositoryError("invalid_input");
}

function receiptForStep(row: StepRow, input: unknown): KnowledgeStrategyStepReceiptV1 {
  const receipt = createKnowledgeStrategyStepReceiptV1(input);
  if (receipt.executionId !== row.executionId || receipt.stepId !== row.id ||
    receipt.requestHash !== hashValue(row.requestHash)) repositoryError("invalid_input");
  return receipt;
}

function assertActiveLease(row: StepRow, input: Readonly<{
  at: Date;
  executionId: string;
  leaseToken: string;
  stateVersion: number;
  stepId: string;
}>): void {
  assertLeaseInput(input);
  if (row.state !== "running" || row.stateVersion !== input.stateVersion) {
    repositoryError("cas_mismatch");
  }
  if (row.leaseToken !== input.leaseToken) repositoryError("lease_fenced");
  if (!row.leaseExpiresAt || row.leaseExpiresAt <= input.at) repositoryError("lease_expired");
}

async function settledMutation(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    at: Date;
    executionId: string;
    includedPassageCount?: number;
    leaseToken: string;
    receipt: unknown;
    stateVersion: number;
    stepId: string;
  }>,
  target: "settled" | "failed" | "ambiguous"
): Promise<KnowledgeStrategyMutationResult> {
  const row = await requireRow(tx, input.executionId);
  const step = row.steps.find(({ id }) => id === input.stepId) ?? repositoryError("not_found");
  const receipt = receiptForStep(step, input.receipt);
  const resultHash = hashKnowledgeStrategyStepReceiptV1(receipt);
  const expectedStatuses = target === "settled" ? ["succeeded", "unavailable"] : [target];
  if (!expectedStatuses.includes(receipt.status)) repositoryError("invalid_input");
  if (step.state === target && hashValue(step.resultHash) === resultHash) {
    const stored = hydrateKnowledgeStrategyExecutionRow(row);
    return { execution: stored, kind: "idempotent", step: findStoredStep(stored, step.id) };
  }
  const postDispatch = step.irreversibleDispatch && target !== "failed";
  if (postDispatch) {
    if (step.state !== "running" || step.stateVersion !== input.stateVersion) {
      repositoryError("cas_mismatch");
    }
    if (step.leaseToken !== input.leaseToken) repositoryError("lease_fenced");
  } else {
    assertActiveLease(step, input);
  }
  if (target === "failed" && step.irreversibleDispatch ||
    target === "ambiguous" && !step.irreversibleDispatch) repositoryError("invalid_state");
  const included = input.includedPassageCount ?? 0;
  if (!Number.isInteger(included) || included < 0 || included > receipt.processedItemCount) {
    repositoryError("invalid_input");
  }
  const action = target === "settled" ? "settle" :
    target === "failed" ? "fail" : "mark_ambiguous";
  const transition = applyKnowledgeStrategyStepCasTransitionV1(lifecycle(step), {
    action,
    at: input.at.toISOString(),
    expectedLeaseToken: input.leaseToken,
    expectedState: "running",
    expectedStateVersion: input.stateVersion,
    failureCode: target === "settled" ? null : receipt.reasonCode,
    leaseExpiresAt: null,
    leaseToken: null,
    receiptHash: target === "settled" ? resultHash : null
  });
  if (transition.kind !== "transitioned") repositoryError(
    transition.kind === "cas_mismatch" ? "cas_mismatch" : "invalid_state"
  );
  const result = await tx.knowledgeStrategyStep.updateMany({
    data: {
      ambiguousAt: target === "ambiguous" ? input.at : undefined,
      cancelledAt: null,
      cursor: receipt.nextCursor === null ? Prisma.DbNull : json(receipt.nextCursor),
      cursorHash: receipt.nextCursor === null ? null : hashKnowledgeStrategyCursorV1(receipt.nextCursor),
      failedAt: target === "failed" ? input.at : undefined,
      failureCode: target === "settled" ? null : receipt.reasonCode,
      includedPassageCount: included,
      leaseExpiresAt: null,
      leaseToken: null,
      processedItemsHash: receipt.processedItemsHash,
      processedPassageCount: receipt.processedItemCount,
      processedSourceCount: step.sourceBindingId !== null && receipt.cursorExhausted ? 1 : 0,
      result: json(receipt),
      resultHash,
      settledAt: target === "settled" ? input.at : undefined,
      state: target,
      stateVersion: transition.value.stateVersion
    },
    where: {
      id: step.id,
      ...(postDispatch ? {} : { leaseExpiresAt: { gt: input.at } }),
      leaseToken: input.leaseToken,
      state: "running",
      stateVersion: input.stateVersion
    }
  });
  if (result.count !== 1) throw new KnowledgeStrategyClaimRaceError();
  const updated = hydrateKnowledgeStrategyExecutionRow(await requireRow(tx, input.executionId));
  return { execution: updated, kind: "transitioned", step: findStoredStep(updated, step.id) };
}

export async function settleKnowledgeStrategyStepReceipt(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    at: Date;
    executionId: string;
    includedPassageCount?: number;
    leaseToken: string;
    receipt: unknown;
    stateVersion: number;
    stepId: string;
  }>
): Promise<Readonly<{
  evidence: KnowledgeStrategyStepEvidenceV1;
  mutation: KnowledgeStrategyMutationResult;
}>> {
  assertLeaseInput(input);
  const mutation = await settledMutation(tx, input, "settled");
  const { receipt, request } = mutation.step;
  if (!receipt || !request) repositoryError("stored_state_invalid");
  const evidence = decodeKnowledgeStrategyStepEvidenceV1({
    executionId: request.executionId,
    kind: request.kind,
    ordinal: request.ordinal,
    requestHash: hashKnowledgeStrategyStepRequestV1(request),
    resultHash: hashKnowledgeStrategyStepReceiptV1(receipt),
    stepId: request.stepId,
    version: 1
  }) ?? repositoryError("stored_state_invalid");
  return Object.freeze({ evidence, mutation });
}

function decodeMapOutputPair(input: Readonly<{
  mapOutput: unknown;
  mapOutputReceipt: unknown;
}>): Readonly<{
  output: KnowledgeStrategyMapOutputV2;
  receipt: KnowledgeStrategyMapOutputReceiptV2;
}> {
  const output = decodeKnowledgeStrategyMapOutputV2(input.mapOutput);
  const receipt = decodeKnowledgeStrategyMapOutputReceiptV2(input.mapOutputReceipt);
  if (!output || !receipt) repositoryError("invalid_input");
  const expectedReceipt = createKnowledgeStrategyMapOutputReceiptV2(output);
  if (hashKnowledgeStrategyMapOutputReceiptV2(expectedReceipt) !==
    hashKnowledgeStrategyMapOutputReceiptV2(receipt)) {
    repositoryError("invalid_input");
  }
  return Object.freeze({ output, receipt });
}

function assertMapOutputStepClosure(
  row: ExecutionRow,
  output: KnowledgeStrategyMapOutputV2,
  receipt: KnowledgeStrategyMapOutputReceiptV2
): void {
  const stored = hydrateKnowledgeStrategyExecutionRow(row);
  const execution = stored.execution;
  if (!execution || execution.strategy !== "corpus_summary" ||
    execution.config.kind !== "corpus_summary" || row.state !== "running" || row.purgedAt) {
    repositoryError("invalid_state");
  }
  const source = execution.sourceSet[output.sourceOrdinal];
  if (!source || output.executionId !== execution.executionId ||
    output.sourceBindingId !== source.bindingId || output.sourceAlias !== source.sourceAlias ||
    output.sourceArtifactId !== source.sourceArtifactId || output.sourceId !== source.sourceId ||
    output.sourceVersionId !== source.sourceVersionId ||
    output.sourceVersionNumber !== source.sourceVersionNumber ||
    output.hierarchicalArtifactId !== source.hierarchicalArtifactId ||
    output.hierarchicalChecksum !== source.hierarchicalChecksum ||
    output.inputPassageCount !== source.passageCount ||
    receipt.executionId !== execution.executionId ||
    receipt.sourceBindingId !== source.bindingId || receipt.sourceOrdinal !== source.ordinal ||
    receipt.terminalStepId !== output.terminalStepId ||
    receipt.outputHash !== output.outputHash || receipt.mapInputHash !== output.mapInputHash) {
    repositoryError("invalid_input");
  }
  const sourceSteps = row.steps.filter((step) =>
    step.kind === "corpus_summary_map" && step.sourceBindingId === source.bindingId)
    .sort((left, right) => left.pageOrdinal - right.pageOrdinal);
  if (sourceSteps.length !== output.inputPageReceiptCount ||
    sourceSteps.length < 1 || sourceSteps.at(-1)?.id !== output.terminalStepId ||
    sourceSteps.reduce((sum, step) => sum + step.processedPassageCount, 0) !==
      output.inputPassageCount || sourceSteps.some((step, pageOrdinal) => {
      const stepReceipt = step.result === null
        ? null
        : createKnowledgeStrategyStepReceiptV1(step.result);
      const terminal = pageOrdinal === sourceSteps.length - 1;
      return step.pageOrdinal !== pageOrdinal || step.state !== "settled" ||
        !stepReceipt || stepReceipt.status !== "succeeded" ||
        stepReceipt.processedItemCount !== step.processedPassageCount ||
        terminal !== stepReceipt.cursorExhausted ||
        terminal !== (stepReceipt.nextCursor === null);
    })) repositoryError("map_output_incomplete");
}

async function persistKnowledgeStrategyMapOutput(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    at: Date;
    executionId: string;
    mapOutput: unknown;
    mapOutputReceipt: unknown;
    stepId: string;
  }>
): Promise<Readonly<{
  kind: "created" | "idempotent";
  mapOutput: StoredKnowledgeStrategyMapOutput;
}>> {
  const { output, receipt } = decodeMapOutputPair(input);
  if (output.executionId !== input.executionId || output.terminalStepId !== input.stepId) {
    repositoryError("invalid_input");
  }
  const existing = await tx.knowledgeStrategyMapOutput.findFirst({
    orderBy: { createdAt: "asc" },
    select: mapOutputSelect,
    where: {
      executionId: input.executionId,
      OR: [
        { sourceBindingId: output.sourceBindingId },
        { sourceOrdinal: output.sourceOrdinal },
        { terminalStepId: output.terminalStepId }
      ]
    }
  });
  if (existing) {
    const stored = hydrateKnowledgeStrategyMapOutputRow(existing);
    if (stored.state !== "available" || !stored.output || !stored.receipt ||
      hashKnowledgeStrategyMapOutputV2(stored.output) !== output.outputHash ||
      hashKnowledgeStrategyMapOutputReceiptV2(stored.receipt) !== receipt.receiptHash) {
      repositoryError("map_output_conflict");
    }
    return Object.freeze({ kind: "idempotent", mapOutput: stored });
  }
  const row = await requireRow(tx, input.executionId);
  assertMapOutputStepClosure(row, output, receipt);
  const terminalSettledAt = row.steps.find(({ id }) => id === output.terminalStepId)?.settledAt ??
    repositoryError("stored_state_invalid");
  const created = await tx.knowledgeStrategyMapOutput.create({
    data: {
      executionId: output.executionId,
      inputPageReceiptCount: output.inputPageReceiptCount,
      inputPageReceiptsHash: output.inputPageReceiptsHash,
      inputPassageCount: output.inputPassageCount,
      inputPassageItemsHash: output.inputPassageItemsHash,
      inputSectionCount: output.inputSectionCount,
      inputSectionHashesHash: output.inputSectionHashesHash,
      mapInputHash: output.mapInputHash,
      modelRunId: row.modelRunId,
      output: json(output),
      outputHash: output.outputHash,
      processedPassageCount: output.processedPassageCount,
      receipt: json(receipt),
      receiptHash: receipt.receiptHash,
      settledAt: terminalSettledAt,
      sourceBindingId: output.sourceBindingId,
      sourceOrdinal: output.sourceOrdinal,
      state: "available",
      summaryItemCount: output.summaryItemCount,
      summaryItemsHash: output.summaryItemsHash,
      terminalStepId: output.terminalStepId,
      version: 2
    },
    select: mapOutputSelect
  });
  return Object.freeze({
    kind: "created",
    mapOutput: hydrateKnowledgeStrategyMapOutputRow(created)
  });
}

type ClaimKnowledgeStrategyStepInput = Readonly<{
  leaseExpiresAt: Date;
  leaseToken: string;
  now: Date;
}>;

async function claimKnowledgeStrategyStep(
  tx: Prisma.TransactionClient,
  row: ExecutionRow,
  candidate: StepRow,
  input: ClaimKnowledgeStrategyStepInput
): Promise<KnowledgeStrategyStepClaim> {
  let expectedVersion = candidate.stateVersion;
  if (candidate.state === "running") {
    const release = applyKnowledgeStrategyStepCasTransitionV1(lifecycle(candidate), {
      action: "release",
      at: input.now.toISOString(),
      expectedLeaseToken: candidate.leaseToken,
      expectedState: "running",
      expectedStateVersion: candidate.stateVersion,
      failureCode: null,
      leaseExpiresAt: null,
      leaseToken: null,
      receiptHash: null
    });
    if (release.kind !== "transitioned") repositoryError("stored_state_invalid");
    const released = await tx.knowledgeStrategyStep.updateMany({
      data: {
        leaseExpiresAt: null,
        leaseToken: null,
        state: "pending",
        stateVersion: release.value.stateVersion
      },
      where: {
        id: candidate.id,
        irreversibleDispatch: false,
        leaseExpiresAt: { lte: input.now },
        leaseToken: candidate.leaseToken,
        state: "running",
        stateVersion: candidate.stateVersion
      }
    });
    if (released.count !== 1) throw new KnowledgeStrategyClaimRaceError();
    expectedVersion = release.value.stateVersion;
  }
  const pendingLifecycle = candidate.state === "pending"
    ? lifecycle(candidate)
    : decodeKnowledgeStrategyStepLifecycleV1({
        ...lifecycle(candidate),
        leaseExpiresAt: null,
        leaseToken: null,
        state: "pending",
        stateVersion: expectedVersion
      });
  if (!pendingLifecycle) repositoryError("stored_state_invalid");
  const claim = applyKnowledgeStrategyStepCasTransitionV1(pendingLifecycle, {
    action: "claim",
    at: input.now.toISOString(),
    expectedLeaseToken: null,
    expectedState: "pending",
    expectedStateVersion: expectedVersion,
    failureCode: null,
    leaseExpiresAt: input.leaseExpiresAt.toISOString(),
    leaseToken: input.leaseToken,
    receiptHash: null
  });
  if (claim.kind !== "transitioned") repositoryError("stored_state_invalid");
  const claimed = await tx.knowledgeStrategyStep.updateMany({
    data: {
      attemptCount: { increment: 1 },
      leaseExpiresAt: input.leaseExpiresAt,
      leaseToken: input.leaseToken,
      startedAt: candidate.startedAt ?? input.now,
      state: "running",
      stateVersion: claim.value.stateVersion
    },
    where: { id: candidate.id, state: "pending", stateVersion: expectedVersion }
  });
  if (claimed.count !== 1) throw new KnowledgeStrategyClaimRaceError();
  if (row.state === "planned") {
    await tx.knowledgeStrategyExecution.update({
      data: { startedAt: input.now, state: "running" },
      where: { id: row.id }
    });
  }
  const stored = hydrateKnowledgeStrategyExecutionRow(await requireRow(tx, row.id));
  return {
    execution: stored,
    kind: "claimed",
    leaseToken: input.leaseToken,
    step: findStoredStep(stored, candidate.id)
  };
}

type MaterializeKnowledgeStrategyStepInput = Readonly<{
  at: Date;
  executionId: string;
  stepId: string;
}>;

function assertMaterializeInput(input: MaterializeKnowledgeStrategyStepInput): void {
  if (!(input.at instanceof Date) || Number.isNaN(input.at.valueOf()) ||
    !validIdentifier(input.executionId) || !validIdentifier(input.stepId)) {
    repositoryError("invalid_input");
  }
}

async function materializeStoredKnowledgeStrategyStepRequest(
  tx: Prisma.TransactionClient,
  input: MaterializeKnowledgeStrategyStepInput,
  requiredKind?: "corpus_summary_reduce"
): Promise<KnowledgeStrategyMutationResult> {
  const row = await requireRow(tx, input.executionId);
  const stored = hydrateKnowledgeStrategyExecutionRow(row);
  const step = stored.steps.find(({ lifecycle: value }) => value.stepId === input.stepId) ??
    repositoryError("not_found");
  if (requiredKind && step.template?.kind !== requiredKind && step.request?.kind !== requiredKind) {
    repositoryError("invalid_state");
  }
  if (step.request !== null) {
    return { execution: stored, kind: "idempotent", step };
  }
  if (row.state !== "running" || step.lifecycle.state !== "pending" || !step.template ||
    step.template.materializationMode === "complete") repositoryError("invalid_state");
  const prerequisiteIds = stored.dependencies.filter(({ dependentStepId }) =>
    dependentStepId === input.stepId).map(({ prerequisiteStepId }) => prerequisiteStepId);
  const prerequisites = prerequisiteIds.map((stepId) => {
    const prerequisite = stored.steps.find(({ lifecycle: value }) => value.stepId === stepId);
    if (!prerequisite?.request || !prerequisite.receipt ||
      prerequisite.lifecycle.state !== "settled" || prerequisite.receipt.status !== "succeeded") {
      return repositoryError("invalid_state");
    }
    return { receipt: prerequisite.receipt, request: prerequisite.request };
  });
  const request = step.template.kind === "corpus_summary_reduce"
    ? (() => {
        if (!stored.execution || stored.execution.strategy !== "corpus_summary") return null;
        const mapOutputs = (row.mapOutputs ?? []).map(hydrateKnowledgeStrategyMapOutputRow);
        if (mapOutputs.length !== stored.execution.sourceSet.length ||
          mapOutputs.some(({ output, receipt, state }) =>
            state !== "available" || !output || !receipt) ||
          prerequisiteIds.some((stepId) => !mapOutputs.some((mapOutput) =>
            mapOutput.terminalStepId === stepId)) || mapOutputs.some((mapOutput) =>
            !prerequisiteIds.includes(mapOutput.terminalStepId))) return null;
        const dependencyHash = deriveKnowledgeStrategyMapOutputDependencyHashV2({
          dependentStepId: step.template.stepId,
          executionId: stored.execution.executionId,
          receipts: mapOutputs.map(({ receipt }) => receipt!),
          sourceSetHash: stored.execution.sourceSetHash
        });
        const { materializationMode: _materializationMode, ...requestShape } = step.template;
        return createKnowledgeStrategyStepRequestV1({
          ...requestShape,
          evidenceInputHash: dependencyHash
        });
      })()
    : materializeKnowledgeStrategyStepRequestV1(
        step.template,
        stored.dependencies,
        prerequisites
      );
  if (!request) repositoryError("invalid_state");
  const requestHash = hashKnowledgeStrategyStepRequestV1(request);
  const result = await tx.knowledgeStrategyStep.updateMany({
    data: {
      evidenceInputHash: request.evidenceInputHash,
      materializedAt: input.at,
      request: json(request),
      requestHash
    },
    where: {
      id: input.stepId,
      materializedAt: null,
      request: { equals: Prisma.DbNull },
      state: "pending"
    }
  });
  if (result.count !== 1) throw new KnowledgeStrategyClaimRaceError();
  const updated = hydrateKnowledgeStrategyExecutionRow(await requireRow(tx, row.id));
  return {
    execution: updated,
    kind: "transitioned",
    step: findStoredStep(updated, input.stepId)
  };
}

export function createPrismaKnowledgeStrategyRepository(client: PrismaClient = prisma) {
  return {
    async createExecution(
      input: CreateKnowledgeStrategyExecutionInput
    ): Promise<Readonly<{ execution: StoredKnowledgeStrategyExecution; kind: "created" | "reused" }>> {
      const plan = decodePlan(input);
      return serializable(client, async (tx) => {
        const existing = await loadRow(tx, { id: plan.execution.executionId }) ??
          await loadRow(tx, { modelRunId: plan.execution.modelRunId });
        if (existing) {
          const stored = hydrateKnowledgeStrategyExecutionRow(existing);
          const bindings = new Map(stored.steps.flatMap((step) =>
            step.modelRunToolCallId
              ? [[step.lifecycle.stepId, step.modelRunToolCallId] as const]
              : []));
          if (!stored.execution ||
            hashKnowledgeStrategyExecutionRequestV1(stored.execution) !==
              hashKnowledgeStrategyExecutionRequestV1(plan.execution) ||
            stored.retrievalSessionId !== input.retrievalSessionId ||
            stored.dependencies.length !== plan.dependencies.length ||
            stored.dependencies.map(hashKnowledgeStrategyDependencyV1).sort().join(":") !==
              plan.dependencies.map(hashKnowledgeStrategyDependencyV1).sort().join(":") ||
            stored.steps.length !== plan.steps.length ||
            stored.steps.some((step, index) => !step.template ||
              hashKnowledgeStrategyStepTemplateV1(step.template) !==
                hashKnowledgeStrategyStepTemplateV1(plan.steps[index])) ||
            bindings.size !== plan.toolCalls.size ||
            [...plan.toolCalls].some(([stepId, toolCallId]) => bindings.get(stepId) !== toolCallId)) {
            repositoryError("execution_conflict");
          }
          return { execution: stored, kind: "reused" };
        }
        const session = await tx.knowledgeRetrievalSession.findUnique({
          select: { modelRunId: true }, where: { id: input.retrievalSessionId }
        });
        if (session?.modelRunId !== plan.execution.modelRunId) repositoryError("invalid_input");
        await assertFrozenSources(tx, plan.execution);
        const toolCallIds = [...plan.toolCalls.values()];
        if (toolCallIds.length > 0 && await tx.modelRunToolCall.count({
          where: { id: { in: toolCallIds }, modelRunId: plan.execution.modelRunId }
        }) !== toolCallIds.length) repositoryError("invalid_input");
        const executionHash = hashKnowledgeStrategyExecutionRequestV1(plan.execution);
        await tx.knowledgeStrategyExecution.create({
          data: {
            executionHash,
            executionRequest: json(plan.execution),
            expectedPassageCount: plan.execution.sourceSet.reduce(
              (sum, source) => sum + source.passageCount,
              0
            ),
            expectedSourceCount: plan.execution.sourceSet.length,
            id: plan.execution.executionId,
            modelRunId: plan.execution.modelRunId,
            planHash: plan.execution.planHash,
            plannerVersion: plan.execution.plannerVersion,
            retrievalSessionId: input.retrievalSessionId,
            sourceSetHash: plan.execution.sourceSetHash,
            strategy: plan.execution.strategy,
            version: 1
          }
        });
        await tx.knowledgeStrategyStep.createMany({
          data: plan.steps.map((step) => {
            const request = materializeKnowledgeStrategyStepRequestV1(step, plan.dependencies, []);
            const requestHash = request ? hashKnowledgeStrategyStepRequestV1(request) : null;
            const templateHash = hashKnowledgeStrategyStepTemplateV1(step);
            return {
              comparisonDimensionHash: step.comparisonDimensionHash,
              evidenceInputHash: request?.evidenceInputHash ?? step.evidenceInputHash,
              executionId: step.executionId,
              id: step.stepId,
              idempotencyKey: templateHash,
              inputHash: step.inputHash,
              kind: step.kind,
              materializationMode: step.materializationMode,
              materializedAt: request ? new Date() : null,
              modelRunId: plan.execution.modelRunId,
              modelRunToolCallId: plan.toolCalls.get(step.stepId) ?? null,
              ordinal: step.ordinal,
              pageOrdinal: step.pageOrdinal,
              phaseOrdinal: step.phaseOrdinal,
              request: request ? json(request) : Prisma.DbNull,
              requestHash,
              required: step.required,
              sourceBindingId: step.sourceBindingId,
              sourceSetHash: step.sourceSetHash,
              streamId: step.streamId,
              templateHash,
              targetOrdinal: step.targetOrdinal
            };
          })
        });
        if (plan.dependencies.length > 0) {
          await tx.knowledgeStrategyStepDependency.createMany({
            data: plan.dependencies.map((dependency) => ({
              dependsOnStepId: dependency.prerequisiteStepId,
              executionId: dependency.executionId,
              stepId: dependency.dependentStepId
            }))
          });
        }
        const created = await requireRow(tx, plan.execution.executionId);
        return { execution: hydrateKnowledgeStrategyExecutionRow(created), kind: "created" };
      });
    },

    async loadExecution(executionId: string): Promise<StoredKnowledgeStrategyExecution | null> {
      if (!validIdentifier(executionId)) repositoryError("invalid_input");
      const row = await client.knowledgeStrategyExecution.findUnique({
        select: executionSelect,
        where: { id: executionId }
      });
      return row ? hydrateKnowledgeStrategyExecutionRow(row) : null;
    },

    async loadExecutionByModelRun(
      modelRunId: string
    ): Promise<StoredKnowledgeStrategyExecution | null> {
      if (!validIdentifier(modelRunId)) repositoryError("invalid_input");
      const row = await client.knowledgeStrategyExecution.findUnique({
        select: executionSelect,
        where: { modelRunId }
      });
      return row ? hydrateKnowledgeStrategyExecutionRow(row) : null;
    },

    async loadMapOutputs(
      input: Readonly<{ executionId: string }>
    ): Promise<readonly StoredKnowledgeStrategyMapOutput[]> {
      if (!validIdentifier(input.executionId)) repositoryError("invalid_input");
      const row = await client.knowledgeStrategyExecution.findUnique({
        select: executionSelect,
        where: { id: input.executionId }
      });
      if (!row) repositoryError("not_found");
      const stored = hydrateKnowledgeStrategyExecutionRow(row);
      if (!stored.execution || stored.purgedAt) repositoryError("purged");
      if (stored.execution.strategy !== "corpus_summary") repositoryError("invalid_state");
      const outputs = Object.freeze((row.mapOutputs ?? []).map(
        hydrateKnowledgeStrategyMapOutputRow
      ));
      if (outputs.length !== stored.execution.sourceSet.length || outputs.some((output, ordinal) =>
        output.state !== "available" || output.output === null || output.receipt === null ||
        output.sourceOrdinal !== ordinal ||
        output.output.sourceBindingId !== stored.execution!.sourceSet[ordinal]!.bindingId)) {
        repositoryError("map_output_incomplete");
      }
      return outputs;
    },

    async materializeStepRequest(
      input: MaterializeKnowledgeStrategyStepInput
    ): Promise<KnowledgeStrategyMutationResult> {
      assertMaterializeInput(input);
      return serializable(client, (tx) =>
        materializeStoredKnowledgeStrategyStepRequest(tx, input));
    },

    async materializeReduceStepRequest(
      input: MaterializeKnowledgeStrategyStepInput
    ): Promise<KnowledgeStrategyMutationResult> {
      assertMaterializeInput(input);
      return serializable(client, (tx) =>
        materializeStoredKnowledgeStrategyStepRequest(tx, input, "corpus_summary_reduce"));
    },

    async claimToolCallStep(input: Readonly<{
      leaseExpiresAt: Date;
      leaseToken: string;
      modelRunId: string;
      modelRunToolCallId: string;
      now: Date;
    }>): Promise<KnowledgeStrategyClaimResult> {
      if (!validIdentifier(input.modelRunId) || !validIdentifier(input.modelRunToolCallId) ||
        !validIdentifier(input.leaseToken) ||
        !(input.now instanceof Date) || !(input.leaseExpiresAt instanceof Date) ||
        Number.isNaN(input.now.valueOf()) || Number.isNaN(input.leaseExpiresAt.valueOf()) ||
        input.leaseExpiresAt <= input.now ||
        input.leaseExpiresAt.valueOf() - input.now.valueOf() > MAX_LEASE_MS) {
        repositoryError("invalid_input");
      }
      return serializable(client, async (tx) => {
        let row = await loadRow(tx, { modelRunId: input.modelRunId }) ??
          repositoryError("not_found");
        if (row.purgedAt) repositoryError("purged");
        if (row.state !== "planned" && row.state !== "running") {
          return { execution: hydrateKnowledgeStrategyExecutionRow(row), kind: "none" };
        }
        const successful = new Set(row.steps.filter((step) => step.state === "settled" &&
          step.result !== null && createKnowledgeStrategyStepReceiptV1(step.result).status === "succeeded")
          .map(({ id }) => id));
        const eligible = (step: StepRow) => step.dependencies.every(
          ({ dependsOnStepId }) => successful.has(dependsOnStepId)
        );
        const bound = row.steps.find((step) =>
          step.modelRunToolCallId === input.modelRunToolCallId) ?? repositoryError("not_found");
        const expired = bound.state === "running" &&
          !bound.irreversibleDispatch && bound.ioStartedAt === null &&
          bound.leaseExpiresAt !== null && bound.leaseExpiresAt <= input.now && eligible(bound)
          ? bound
          : undefined;
        const pending = bound.state === "pending" && bound.request !== null && eligible(bound)
          ? bound
          : undefined;
        const candidate = expired ?? pending;
        if (!candidate) return { execution: hydrateKnowledgeStrategyExecutionRow(row), kind: "none" };
        return claimKnowledgeStrategyStep(tx, row, candidate, input);
      });
    },

    async claimNextStep(input: Readonly<{
      executionId: string;
      leaseExpiresAt: Date;
      leaseToken: string;
      now: Date;
    }>): Promise<KnowledgeStrategyClaimResult> {
      if (!validIdentifier(input.executionId) || !validIdentifier(input.leaseToken) ||
        !(input.now instanceof Date) || !(input.leaseExpiresAt instanceof Date) ||
        Number.isNaN(input.now.valueOf()) || Number.isNaN(input.leaseExpiresAt.valueOf()) ||
        input.leaseExpiresAt <= input.now ||
        input.leaseExpiresAt.valueOf() - input.now.valueOf() > MAX_LEASE_MS) {
        repositoryError("invalid_input");
      }
      return serializable(client, async (tx) => {
        const row = await requireRow(tx, input.executionId);
        if (row.purgedAt) repositoryError("purged");
        if (row.state !== "planned" && row.state !== "running") {
          return { execution: hydrateKnowledgeStrategyExecutionRow(row), kind: "none" };
        }
        const successful = new Set(row.steps.filter((step) => step.state === "settled" &&
          step.result !== null && createKnowledgeStrategyStepReceiptV1(step.result).status === "succeeded")
          .map(({ id }) => id));
        const eligible = (step: StepRow) => step.dependencies.every(
          ({ dependsOnStepId }) => successful.has(dependsOnStepId)
        );
        const candidate = row.steps.find((step) => step.modelRunToolCallId === null &&
          step.request !== null && eligible(step) && (
          step.state === "pending" ||
          step.state === "running" && !step.irreversibleDispatch && step.ioStartedAt === null &&
          step.leaseExpiresAt !== null && step.leaseExpiresAt <= input.now
        ));
        if (!candidate) return { execution: hydrateKnowledgeStrategyExecutionRow(row), kind: "none" };
        return claimKnowledgeStrategyStep(tx, row, candidate, input);
      });
    },

    async releaseStep(input: Readonly<{
      at: Date;
      executionId: string;
      leaseToken: string;
      stateVersion: number;
      stepId: string;
    }>): Promise<KnowledgeStrategyMutationResult> {
      assertLeaseInput(input);
      return serializable(client, async (tx) => {
        const row = await requireRow(tx, input.executionId);
        const step = row.steps.find(({ id }) => id === input.stepId) ?? repositoryError("not_found");
        assertActiveLease(step, input);
        if (step.irreversibleDispatch) repositoryError("invalid_state");
        const transition = applyKnowledgeStrategyStepCasTransitionV1(lifecycle(step), {
          action: "release",
          at: input.at.toISOString(),
          expectedLeaseToken: input.leaseToken,
          expectedState: "running",
          expectedStateVersion: input.stateVersion,
          failureCode: null,
          leaseExpiresAt: null,
          leaseToken: null,
          receiptHash: null
        });
        if (transition.kind !== "transitioned") repositoryError("invalid_state");
        const result = await tx.knowledgeStrategyStep.updateMany({
          data: {
            leaseExpiresAt: null,
            leaseToken: null,
            state: "pending",
            stateVersion: transition.value.stateVersion
          },
          where: {
            id: step.id,
            irreversibleDispatch: false,
            leaseExpiresAt: { gt: input.at },
            leaseToken: input.leaseToken,
            state: "running",
            stateVersion: input.stateVersion
          }
        });
        if (result.count !== 1) throw new KnowledgeStrategyClaimRaceError();
        const updated = hydrateKnowledgeStrategyExecutionRow(await requireRow(tx, row.id));
        return { execution: updated, kind: "transitioned", step: findStoredStep(updated, step.id) };
      });
    },

    async markStepDispatched(input: Readonly<{
      at: Date;
      executionId: string;
      leaseToken: string;
      providerAttemptId: string | null;
      stateVersion: number;
      stepId: string;
    }>): Promise<KnowledgeStrategyMutationResult> {
      assertLeaseInput(input);
      if (input.providerAttemptId !== null && !validIdentifier(input.providerAttemptId)) {
        repositoryError("invalid_input");
      }
      return serializable(client, async (tx) => {
        const row = await requireRow(tx, input.executionId);
        const step = row.steps.find(({ id }) => id === input.stepId) ?? repositoryError("not_found");
        if (step.irreversibleDispatch && step.leaseToken === input.leaseToken &&
          step.providerAttemptId === input.providerAttemptId) {
          const stored = hydrateKnowledgeStrategyExecutionRow(row);
          return { execution: stored, kind: "idempotent", step: findStoredStep(stored, step.id) };
        }
        assertActiveLease(step, input);
        if (input.providerAttemptId !== null && await tx.knowledgeProviderAttempt.count({
          where: { id: input.providerAttemptId, modelRunId: row.modelRunId }
        }) !== 1) repositoryError("invalid_input");
        const transition = applyKnowledgeStrategyStepCasTransitionV1(lifecycle(step), {
          action: "mark_dispatched",
          at: input.at.toISOString(),
          expectedLeaseToken: input.leaseToken,
          expectedState: "running",
          expectedStateVersion: input.stateVersion,
          failureCode: null,
          leaseExpiresAt: null,
          leaseToken: null,
          receiptHash: null
        });
        if (transition.kind !== "transitioned") repositoryError("invalid_state");
        const result = await tx.knowledgeStrategyStep.updateMany({
          data: {
            ioStartedAt: input.at,
            irreversibleDispatch: true,
            providerAttemptId: input.providerAttemptId,
            stateVersion: transition.value.stateVersion
          },
          where: {
            id: step.id,
            irreversibleDispatch: false,
            leaseExpiresAt: { gt: input.at },
            leaseToken: input.leaseToken,
            state: "running",
            stateVersion: input.stateVersion
          }
        });
        if (result.count !== 1) throw new KnowledgeStrategyClaimRaceError();
        const updated = hydrateKnowledgeStrategyExecutionRow(await requireRow(tx, row.id));
        return { execution: updated, kind: "transitioned", step: findStoredStep(updated, step.id) };
      });
    },

    async settleStep(input: Readonly<{
      at: Date;
      executionId: string;
      includedPassageCount?: number;
      leaseToken: string;
      receipt: unknown;
      stateVersion: number;
      stepId: string;
    }>): Promise<KnowledgeStrategyMutationResult> {
      return serializable(client, async (tx) =>
        (await settleKnowledgeStrategyStepReceipt(tx, input)).mutation);
    },

    async settleMapStep(input: Readonly<{
      at: Date;
      executionId: string;
      includedPassageCount?: number;
      leaseToken: string;
      mapOutput: unknown;
      mapOutputReceipt: unknown;
      receipt: unknown;
      stateVersion: number;
      stepId: string;
    }>): Promise<KnowledgeStrategyMutationResult> {
      assertLeaseInput(input);
      decodeMapOutputPair(input);
      return serializable(client, async (tx) => {
        const settlement = await settleKnowledgeStrategyStepReceipt(tx, input);
        await persistKnowledgeStrategyMapOutput(tx, input);
        const execution = hydrateKnowledgeStrategyExecutionRow(
          await requireRow(tx, input.executionId)
        );
        return {
          execution,
          kind: settlement.mutation.kind,
          step: findStoredStep(execution, input.stepId)
        };
      });
    },

    async failStep(input: Readonly<{
      at: Date;
      executionId: string;
      includedPassageCount?: number;
      leaseToken: string;
      receipt: unknown;
      stateVersion: number;
      stepId: string;
    }>): Promise<KnowledgeStrategyMutationResult> {
      assertLeaseInput(input);
      return serializable(client, (tx) => settledMutation(tx, input, "failed"));
    },

    async markStepAmbiguous(input: Readonly<{
      at: Date;
      executionId: string;
      includedPassageCount?: number;
      leaseToken: string;
      receipt: unknown;
      stateVersion: number;
      stepId: string;
    }>): Promise<KnowledgeStrategyMutationResult> {
      assertLeaseInput(input);
      return serializable(client, (tx) => settledMutation(tx, input, "ambiguous"));
    },

    async cancelStep(input: Readonly<{
      at: Date;
      executionId: string;
      leaseToken: string | null;
      receipt: unknown;
      stateVersion: number;
      stepId: string;
    }>): Promise<KnowledgeStrategyMutationResult> {
      if (!(input.at instanceof Date) || Number.isNaN(input.at.valueOf()) ||
        !Number.isInteger(input.stateVersion) ||
        input.stateVersion < 0 || !validIdentifier(input.executionId) ||
        !validIdentifier(input.stepId) ||
        input.leaseToken !== null && !validIdentifier(input.leaseToken)) {
        repositoryError("invalid_input");
      }
      return serializable(client, async (tx) => {
        const row = await requireRow(tx, input.executionId);
        const step = row.steps.find(({ id }) => id === input.stepId) ?? repositoryError("not_found");
        const receipt = receiptForStep(step, input.receipt);
        const receiptHash = hashKnowledgeStrategyStepReceiptV1(receipt);
        if (receipt.status !== "cancelled") repositoryError("invalid_input");
        if (step.state === "cancelled" && hashValue(step.resultHash) === receiptHash) {
          const stored = hydrateKnowledgeStrategyExecutionRow(row);
          return { execution: stored, kind: "idempotent", step: findStoredStep(stored, step.id) };
        }
        if (step.state !== "pending" && step.state !== "running" || step.irreversibleDispatch ||
          step.stateVersion !== input.stateVersion || step.leaseToken !== input.leaseToken ||
          step.state === "running" && (!step.leaseExpiresAt || step.leaseExpiresAt <= input.at)) {
          repositoryError("cas_mismatch");
        }
        const transition = applyKnowledgeStrategyStepCasTransitionV1(lifecycle(step), {
          action: "cancel",
          at: input.at.toISOString(),
          expectedLeaseToken: input.leaseToken,
          expectedState: stepState(step.state),
          expectedStateVersion: input.stateVersion,
          failureCode: receipt.reasonCode,
          leaseExpiresAt: null,
          leaseToken: null,
          receiptHash: null
        });
        if (transition.kind !== "transitioned") repositoryError("invalid_state");
        const result = await tx.knowledgeStrategyStep.updateMany({
          data: {
            cancelledAt: input.at,
            failureCode: receipt.reasonCode,
            leaseExpiresAt: null,
            leaseToken: null,
            processedItemsHash: receipt.processedItemsHash,
            processedPassageCount: receipt.processedItemCount,
            result: json(receipt),
            resultHash: receiptHash,
            state: "cancelled",
            stateVersion: transition.value.stateVersion
          },
          where: {
            id: step.id,
            irreversibleDispatch: false,
            leaseToken: input.leaseToken,
            state: step.state,
            stateVersion: input.stateVersion
          }
        });
        if (result.count !== 1) throw new KnowledgeStrategyClaimRaceError();
        const updated = hydrateKnowledgeStrategyExecutionRow(await requireRow(tx, row.id));
        return { execution: updated, kind: "transitioned", step: findStoredStep(updated, step.id) };
      });
    },

    async recordCoverage(input: Readonly<{
      dispatchManifestHash: string | null;
      dispatchSetHash: string;
      dispatchedPassageCount: number;
      executionId: string;
      includedPassageCount: number;
      includedSetHash: string;
      processedPassageCount: number;
      processedSetHash: string;
      processedSourceCount: number;
    }>): Promise<StoredKnowledgeStrategyExecution> {
      const counts = [input.processedSourceCount, input.processedPassageCount,
        input.includedPassageCount, input.dispatchedPassageCount];
      if (!validIdentifier(input.executionId) || counts.some((count) =>
        !Number.isInteger(count) || count < 0) ||
        !validHash(input.processedSetHash) || !validHash(input.includedSetHash) ||
        !validHash(input.dispatchSetHash) || input.dispatchManifestHash !== null &&
        !validHash(input.dispatchManifestHash)) repositoryError("invalid_input");
      return serializable(client, async (tx) => {
        const row = await requireRow(tx, input.executionId);
        if (row.state !== "running" || row.purgedAt) repositoryError("invalid_state");
        if (input.processedSourceCount < row.processedSourceCount ||
          input.processedPassageCount < row.processedPassageCount ||
          input.includedPassageCount < row.includedPassageCount ||
          input.dispatchedPassageCount < row.dispatchedPassageCount ||
          input.processedSourceCount > row.expectedSourceCount ||
          input.processedPassageCount > row.expectedPassageCount ||
          input.includedPassageCount > input.processedPassageCount ||
          input.dispatchedPassageCount > input.includedPassageCount) {
          repositoryError("coverage_not_monotonic");
        }
        const sameHash = (currentCount: number, nextCount: number, currentHash: string | null,
          nextHash: string) => currentCount !== nextCount || currentHash === null ||
            hashValue(currentHash) === nextHash;
        if (!sameHash(row.processedPassageCount, input.processedPassageCount,
          row.processedSetHash, input.processedSetHash) ||
          !sameHash(row.includedPassageCount, input.includedPassageCount,
            row.includedSetHash, input.includedSetHash) ||
          !sameHash(row.dispatchedPassageCount, input.dispatchedPassageCount,
            row.dispatchSetHash, input.dispatchSetHash)) repositoryError("coverage_not_monotonic");
        await tx.knowledgeStrategyExecution.update({
          data: {
            dispatchManifestHash: input.dispatchManifestHash,
            dispatchedPassageCount: input.dispatchedPassageCount,
            dispatchSetHash: input.dispatchSetHash,
            includedPassageCount: input.includedPassageCount,
            includedSetHash: input.includedSetHash,
            processedPassageCount: input.processedPassageCount,
            processedSetHash: input.processedSetHash,
            processedSourceCount: input.processedSourceCount
          },
          where: { id: row.id }
        });
        return hydrateKnowledgeStrategyExecutionRow(await requireRow(tx, row.id));
      });
    },

    async finalizeExecution(input: Readonly<{
      at: Date;
      coverage: unknown;
      executionId: string;
    }>): Promise<Readonly<{
      execution: StoredKnowledgeStrategyExecution;
      kind: "idempotent" | "transitioned";
    }>> {
      if (!(input.at instanceof Date) || Number.isNaN(input.at.valueOf()) ||
        !validIdentifier(input.executionId)) {
        repositoryError("invalid_input");
      }
      const coverageRequest = createKnowledgeStrategyCoverageRequestV1(input.coverage);
      return serializable(client, async (tx) => {
        const row = await requireRow(tx, input.executionId);
        const stored = hydrateKnowledgeStrategyExecutionRow(row);
        if (!stored.execution) repositoryError("purged");
        const receipt = deriveKnowledgeStrategyCoverageReceiptV1(stored.execution, coverageRequest);
        if (receipt.executionId !== row.id) repositoryError("invalid_input");
        if ((row.state === "settled" || row.state === "partial") && stored.coverage) {
          if (stored.coverage.receiptHash !== receipt.receiptHash) {
            repositoryError("execution_conflict");
          }
          return { execution: stored, kind: "idempotent" };
        }
        if (row.state !== "running" || receipt.terminalRequiredStepCount !==
          receipt.requiredStepCount) repositoryError("execution_not_finalizable");
        const storedRequests = stored.steps.flatMap(({ request }) => request ? [request] : []);
        const storedReceipts = stored.steps.flatMap(({ receipt: stepReceipt }) =>
          stepReceipt ? [stepReceipt] : []);
        const hashList = (values: readonly unknown[], hashFn: (value: unknown) => string) =>
          values.map(hashFn).sort().join(":");
        if (hashList(coverageRequest.steps, hashKnowledgeStrategyStepRequestV1) !==
          hashList(storedRequests, hashKnowledgeStrategyStepRequestV1) ||
          hashList(coverageRequest.stepReceipts, hashKnowledgeStrategyStepReceiptV1) !==
          hashList(storedReceipts, hashKnowledgeStrategyStepReceiptV1) ||
          hashList(coverageRequest.dependencies, hashKnowledgeStrategyDependencyV1) !==
          hashList(stored.dependencies, hashKnowledgeStrategyDependencyV1)) {
          repositoryError("execution_conflict");
        }
        const nextState = receipt.status === "verified" ? "settled" : "partial";
        await tx.knowledgeStrategyExecution.update({
          data: {
            coverageReceipt: json(receipt),
            coverageReceiptHash: receipt.receiptHash,
            coverageStatus: receipt.status,
            dispatchManifestHash: coverageRequest.dispatch.manifestHash,
            dispatchedPassageCount: receipt.dispatchIncludedItemCount,
            dispatchSetHash: receipt.includedItemsHash,
            includedPassageCount: receipt.dispatchExpectedItemCount,
            includedSetHash: receipt.expectedItemsHash,
            processedPassageCount: receipt.processedPassageCount,
            processedSetHash: receipt.processedItemsHash,
            processedSourceCount: receipt.processedSourceCount,
            settledAt: input.at,
            state: nextState
          },
          where: { id: row.id }
        });
        return {
          execution: hydrateKnowledgeStrategyExecutionRow(await requireRow(tx, row.id)),
          kind: "transitioned"
        };
      });
    },

    async loadStepEvidenceForToolCall(input: Readonly<{
      modelRunId: string;
      modelRunToolCallId: string;
    }>): Promise<KnowledgeStrategyStepEvidenceRecord | null> {
      if (!validIdentifier(input.modelRunId) || !validIdentifier(input.modelRunToolCallId)) {
        repositoryError("invalid_input");
      }
      const row = await client.knowledgeStrategyExecution.findUnique({
        select: executionSelect,
        where: { modelRunId: input.modelRunId }
      });
      if (!row) return null;
      const stored = hydrateKnowledgeStrategyExecutionRow(row);
      const step = stored.steps.find((candidate) =>
        candidate.modelRunToolCallId === input.modelRunToolCallId);
      if (!step?.request || !step.receipt || step.lifecycle.state !== "settled") return null;
      const evidence = decodeKnowledgeStrategyStepEvidenceV1({
        executionId: step.request.executionId,
        kind: step.request.kind,
        ordinal: step.request.ordinal,
        requestHash: hashKnowledgeStrategyStepRequestV1(step.request),
        resultHash: hashKnowledgeStrategyStepReceiptV1(step.receipt),
        stepId: step.request.stepId,
        version: 1
      }) ?? repositoryError("stored_state_invalid");
      return Object.freeze({ coverage: stored.coverage, evidence, executionState: stored.state });
    },

    async purgeExecution(input: Readonly<{
      at: Date;
      executionId: string;
    }>): Promise<StoredKnowledgeStrategyExecution> {
      if (!(input.at instanceof Date) || Number.isNaN(input.at.valueOf()) ||
        !validIdentifier(input.executionId)) {
        repositoryError("invalid_input");
      }
      return serializable(client, async (tx) => {
        const row = await requireRow(tx, input.executionId);
        if (row.purgedAt) return hydrateKnowledgeStrategyExecutionRow(row);
        if (!new Set(["settled", "partial", "failed", "ambiguous", "cancelled"])
          .has(row.state)) repositoryError("invalid_state");
        const toolCallIds = row.steps.flatMap(({ modelRunToolCallId }) =>
          modelRunToolCallId ? [modelRunToolCallId] : []);
        await tx.$executeRaw`SELECT set_config('aiqsa.knowledge_purge', 'on', true)`;
        await tx.knowledgeStrategyMapOutput.updateMany({
          data: {
            inputPageReceiptsHash: null,
            inputPassageItemsHash: null,
            inputSectionHashesHash: null,
            mapInputHash: null,
            output: Prisma.DbNull,
            outputHash: null,
            purgedAt: input.at,
            receipt: Prisma.DbNull,
            receiptHash: null,
            sourceBindingId: null,
            state: "purged",
            summaryItemsHash: null
          },
          where: { executionId: row.id, purgedAt: null }
        });
        await tx.knowledgeStrategyStep.updateMany({
          data: {
            comparisonDimensionHash: null,
            cursor: Prisma.DbNull,
            cursorHash: null,
            evidenceInputHash: null,
            failureCode: null,
            idempotencyKey: null,
            inputHash: null,
            leaseExpiresAt: null,
            leaseToken: null,
            materializedAt: null,
            modelRunToolCallId: null,
            processedItemsHash: null,
            providerAttemptId: null,
            purgedAt: input.at,
            request: Prisma.DbNull,
            requestHash: null,
            result: Prisma.DbNull,
            resultHash: null,
            sourceBindingId: null,
            sourceSetHash: null,
            state: "purged",
            stateVersion: { increment: 1 },
            streamId: null,
            templateHash: null
          },
          where: { executionId: row.id }
        });
        if (toolCallIds.length > 0) {
          await tx.knowledgeRun.updateMany({
            data: { strategyStepEvidence: Prisma.DbNull },
            where: { modelRunId: row.modelRunId, modelRunToolCallId: { in: toolCallIds } }
          });
        }
        await tx.knowledgeStrategyExecution.update({
          data: {
            coverageReceipt: Prisma.DbNull,
            coverageReceiptHash: null,
            dispatchManifestHash: null,
            dispatchSetHash: null,
            executionHash: null,
            executionRequest: Prisma.DbNull,
            includedSetHash: null,
            planHash: null,
            processedSetHash: null,
            purgedAt: input.at,
            sourceSetHash: null
          },
          where: { id: row.id }
        });
        return hydrateKnowledgeStrategyExecutionRow(await requireRow(tx, row.id));
      });
    }
  } as const;
}

export type PrismaKnowledgeStrategyRepository = ReturnType<
  typeof createPrismaKnowledgeStrategyRepository
>;
