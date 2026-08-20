import { createHash } from "node:crypto";
import {
  createKnowledgeStrategyDependencyV1,
  createKnowledgeStrategyStepTemplateV1,
  decodeKnowledgeAcceptedSourceSetV1,
  hashKnowledgeAcceptedSourceSetV1,
  hashKnowledgeStrategyTargetSetV1,
  sealKnowledgeStrategyExecutionRequestV1,
  KNOWLEDGE_STRATEGY_EXECUTION_VERSION,
  KNOWLEDGE_STRATEGY_MAX_STEPS,
  type KnowledgeAcceptedSourceTupleV1,
  type KnowledgeMeasuredStrategy,
  type KnowledgeStrategyDependencyV1,
  type KnowledgeStrategyExecutionRequestV1,
  type KnowledgeStrategyStepKind,
  type KnowledgeStrategyStepTemplateV1,
  type KnowledgeStrategyTargetV1
} from "./knowledgeStrategyExecution";
import type {
  KnowledgePlannerPlanV2,
  KnowledgePlannerStrategy
} from "./planner";

export const KNOWLEDGE_STRATEGY_PAGE_SIZE = 64;
export const KNOWLEDGE_STRATEGY_FULL_CONTEXT_MAX_PASSAGES = 8;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type KnowledgeStrategyToolCallIdentityV1 = Readonly<{
  id: string;
  ordinal: number;
}>;

export type KnowledgeStrategyPlannedStepV1 = Readonly<{
  modelRunToolCallId: string | null;
  template: KnowledgeStrategyStepTemplateV1;
}>;

export type KnowledgeStrategyPreparedExecutionV1 = Readonly<{
  dependencies: readonly KnowledgeStrategyDependencyV1[];
  execution: KnowledgeStrategyExecutionRequestV1;
  steps: readonly KnowledgeStrategyPlannedStepV1[];
}>;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function measuredStrategy(
  strategy: KnowledgePlannerStrategy
): KnowledgeMeasuredStrategy | null {
  switch (strategy) {
    case "comparison": return "comparison";
    case "corpus_summary": return "corpus_summary";
    case "exhaustive": return "exhaustive";
    case "full_context": return "full_context";
    case "multi_pass": return "multi_hop";
    default: return null;
  }
}

function deterministicId(prefix: string, input: unknown): string {
  return `${prefix}-${sha256(input)}`;
}

function callMap(
  plan: KnowledgePlannerPlanV2,
  calls: readonly KnowledgeStrategyToolCallIdentityV1[]
): ReadonlyMap<number, string> {
  if (calls.length !== plan.subqueries.length || calls.length < 1 ||
    new Set(calls.map(({ id }) => id)).size !== calls.length ||
    new Set(calls.map(({ ordinal }) => ordinal)).size !== calls.length ||
    calls.some(({ id, ordinal }) => !IDENTIFIER.test(id) ||
      !Number.isSafeInteger(ordinal) || ordinal < 0 ||
      plan.subqueries[ordinal]?.ordinal !== ordinal)) {
    throw new Error("knowledge_strategy_tool_call_identity_invalid");
  }
  return new Map(calls.map(({ id, ordinal }) => [ordinal, id]));
}

function targetSet(
  plan: KnowledgePlannerPlanV2,
  sources: readonly KnowledgeAcceptedSourceTupleV1[]
): readonly KnowledgeStrategyTargetV1[] {
  const targets = plan.targetResolution?.targets ?? [];
  if (targets.length < 2) throw new Error("knowledge_strategy_comparison_targets_invalid");
  const bySourceId = new Map(sources.map((source) => [source.sourceId, source]));
  return Object.freeze(targets.map((target, ordinal): KnowledgeStrategyTargetV1 => {
    const resolvedSourceId = target.outcome === "resolved"
      ? target.candidateSourceIds[0] ?? null
      : null;
    const source = resolvedSourceId ? bySourceId.get(resolvedSourceId) : undefined;
    const admission = target.outcome === "ambiguous"
      ? "ambiguous" as const
      : target.outcome === "not_found"
        ? "not_present" as const
        : source ? "resolved" as const : "not_ready" as const;
    return Object.freeze({
      admission,
      ordinal,
      referenceHash: sha256(["target", target.targetName]),
      sourceBindingId: admission === "resolved" ? source!.bindingId : null,
      version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
    });
  }));
}

function executionRequest(input: Readonly<{
  executionId: string;
  modelRunId: string;
  plan: KnowledgePlannerPlanV2;
  sources: readonly KnowledgeAcceptedSourceTupleV1[];
  strategy: KnowledgeMeasuredStrategy;
}>): KnowledgeStrategyExecutionRequestV1 {
  const sourceSetHash = hashKnowledgeAcceptedSourceSetV1(input.sources);
  const expectedPassageCount = input.sources.reduce((sum, source) =>
    sum + source.passageCount, 0);
  const base = {
    executionId: input.executionId,
    modelRunId: input.modelRunId,
    plannerVersion: input.plan.version,
    sourceSet: input.sources,
    sourceSetHash,
    strategy: input.strategy,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  } as const;
  switch (input.strategy) {
    case "full_context":
      return sealKnowledgeStrategyExecutionRequestV1({
        ...base,
        config: {
          expectedPassageCount,
          fallback: "corpus_summary",
          kind: "full_context"
        }
      });
    case "exhaustive":
      return sealKnowledgeStrategyExecutionRequestV1({
        ...base,
        config: {
          expectedPassageCount,
          kind: "exhaustive",
          queryHash: sha256(["exhaustive", input.plan.rewrite.query])
        }
      });
    case "comparison": {
      const targets = targetSet(input.plan, input.sources);
      return sealKnowledgeStrategyExecutionRequestV1({
        ...base,
        config: {
          dimensionHash: sha256([
            "comparison_dimension",
            input.plan.rewrite.query,
            input.plan.rewrite.exactTerms
          ]),
          kind: "comparison",
          targetSetHash: hashKnowledgeStrategyTargetSetV1(targets),
          targets
        }
      });
    }
    case "corpus_summary":
      return sealKnowledgeStrategyExecutionRequestV1({
        ...base,
        config: {
          expectedPassageCount,
          kind: "corpus_summary",
          mapInputHash: sha256([
            "corpus_summary_map",
            input.plan.rewrite.query,
            sourceSetHash
          ]),
          reduceInputHash: sha256([
            "corpus_summary_reduce",
            input.plan.rewrite.query,
            sourceSetHash
          ])
        }
      });
    case "multi_hop": {
      if (input.plan.subqueries.length < 2) {
        throw new Error("knowledge_strategy_multi_hop_questions_invalid");
      }
      return sealKnowledgeStrategyExecutionRequestV1({
        ...base,
        config: {
          atomicQuestionHashes: input.plan.subqueries.map((subquery) =>
            sha256(["multi_hop_question", subquery.ordinal, subquery.query])),
          kind: "multi_hop"
        }
      });
    }
  }
}

function template(input: Readonly<{
  comparisonDimensionHash?: string | null;
  execution: KnowledgeStrategyExecutionRequestV1;
  inputHash: string;
  kind: KnowledgeStrategyStepKind;
  materializationMode: KnowledgeStrategyStepTemplateV1["materializationMode"];
  ordinal: number;
  pageOrdinal?: number;
  sourceBindingId?: string | null;
  streamId: string;
  targetOrdinal?: number | null;
}>): KnowledgeStrategyStepTemplateV1 {
  const stepId = deterministicId("strategy-step", [
    input.execution.executionId,
    input.kind,
    input.ordinal,
    input.pageOrdinal ?? 0,
    input.sourceBindingId ?? null,
    input.targetOrdinal ?? null
  ]);
  return createKnowledgeStrategyStepTemplateV1({
    comparisonDimensionHash: input.comparisonDimensionHash ?? null,
    cursor: null,
    evidenceInputHash: null,
    executionId: input.execution.executionId,
    inputHash: input.inputHash,
    kind: input.kind,
    materializationMode: input.materializationMode,
    ordinal: input.ordinal,
    pageOrdinal: input.pageOrdinal ?? 0,
    phaseOrdinal: 0,
    required: true,
    sourceBindingId: input.sourceBindingId ?? null,
    sourceSetHash: input.execution.sourceSetHash,
    stepId,
    strategy: input.execution.strategy,
    streamId: input.streamId,
    targetOrdinal: input.targetOrdinal ?? null,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

function paginatedTemplates(input: Readonly<{
  execution: KnowledgeStrategyExecutionRequestV1;
  inputHash: string;
  kind: "corpus_summary_map" | "exhaustive_page" | "full_context_page";
  ordinalStart: number;
  pageSize: number;
}>): Readonly<{
  dependencies: KnowledgeStrategyDependencyV1[];
  nextOrdinal: number;
  steps: KnowledgeStrategyPlannedStepV1[];
  terminalStepIds: string[];
}> {
  const dependencies: KnowledgeStrategyDependencyV1[] = [];
  const steps: KnowledgeStrategyPlannedStepV1[] = [];
  const terminalStepIds: string[] = [];
  let ordinal = input.ordinalStart;
  for (const source of input.execution.sourceSet) {
    const pageCount = Math.max(1, Math.ceil(source.passageCount / input.pageSize));
    const streamId = deterministicId("strategy-stream", [
      input.execution.executionId,
      input.kind,
      source.bindingId
    ]);
    let predecessor: string | null = null;
    for (let pageOrdinal = 0; pageOrdinal < pageCount; pageOrdinal += 1) {
      const stepTemplate = template({
        execution: input.execution,
        inputHash: input.inputHash,
        kind: input.kind,
        materializationMode: pageOrdinal === 0 ? "complete" : "cursor_from_predecessor",
        ordinal,
        pageOrdinal,
        sourceBindingId: source.bindingId,
        streamId
      });
      steps.push({ modelRunToolCallId: null, template: stepTemplate });
      if (predecessor) {
        dependencies.push(createKnowledgeStrategyDependencyV1({
          dependentStepId: stepTemplate.stepId,
          executionId: input.execution.executionId,
          prerequisiteStepId: predecessor,
          version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
        }));
      }
      predecessor = stepTemplate.stepId;
      ordinal += 1;
    }
    terminalStepIds.push(predecessor!);
  }
  return { dependencies, nextOrdinal: ordinal, steps, terminalStepIds };
}

function bindToolCall(
  steps: KnowledgeStrategyPlannedStepV1[],
  stepId: string,
  modelRunToolCallId: string
): void {
  const index = steps.findIndex(({ template: candidate }) => candidate.stepId === stepId);
  if (index < 0 || steps[index]!.modelRunToolCallId !== null) {
    throw new Error("knowledge_strategy_tool_call_binding_invalid");
  }
  steps[index] = Object.freeze({ modelRunToolCallId, template: steps[index]!.template });
}

export function prepareKnowledgeStrategyExecutionV1(input: Readonly<{
  calls: readonly KnowledgeStrategyToolCallIdentityV1[];
  executionId: string;
  modelRunId: string;
  pageSize?: number;
  plan: KnowledgePlannerPlanV2;
  sources: readonly KnowledgeAcceptedSourceTupleV1[];
}>): KnowledgeStrategyPreparedExecutionV1 | null {
  const strategy = measuredStrategy(input.plan.strategy);
  if (!strategy) return null;
  if (!IDENTIFIER.test(input.executionId) || !IDENTIFIER.test(input.modelRunId)) {
    throw new Error("knowledge_strategy_execution_identity_invalid");
  }
  const sources = decodeKnowledgeAcceptedSourceSetV1(input.sources);
  if (!sources) throw new Error("knowledge_strategy_source_set_invalid");
  const calls = callMap(input.plan, input.calls);
  const pageSize = input.pageSize ?? KNOWLEDGE_STRATEGY_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 256) {
    throw new Error("knowledge_strategy_page_size_invalid");
  }
  if (strategy === "full_context" && (
    sources.length !== 1 || sources[0]!.passageCount < 1 ||
    sources[0]!.passageCount > KNOWLEDGE_STRATEGY_FULL_CONTEXT_MAX_PASSAGES
  )) {
    throw new Error("knowledge_strategy_full_context_scope_invalid");
  }
  const execution = executionRequest({
    executionId: input.executionId,
    modelRunId: input.modelRunId,
    plan: input.plan,
    sources,
    strategy
  });
  const steps: KnowledgeStrategyPlannedStepV1[] = [];
  const dependencies: KnowledgeStrategyDependencyV1[] = [];

  if (strategy === "full_context" || strategy === "exhaustive" ||
    strategy === "corpus_summary") {
    if (calls.size !== 1) throw new Error("knowledge_strategy_tool_call_count_invalid");
    const kind = strategy === "full_context"
      ? "full_context_page" as const
      : strategy === "exhaustive" ? "exhaustive_page" as const : "corpus_summary_map" as const;
    const config = execution.config;
    const inputHash = config.kind === "full_context"
      ? sha256(["full_context", execution.sourceSetHash])
      : config.kind === "exhaustive"
        ? config.queryHash
        : config.kind === "corpus_summary"
          ? config.mapInputHash
          : null;
    if (!inputHash) throw new Error("knowledge_strategy_config_invalid");
    const pages = paginatedTemplates({
      execution,
      inputHash,
      kind,
      ordinalStart: 0,
      pageSize
    });
    steps.push(...pages.steps);
    dependencies.push(...pages.dependencies);
    if (strategy === "corpus_summary") {
      if (config.kind !== "corpus_summary") throw new Error("knowledge_strategy_config_invalid");
      const reduce = template({
        execution,
        inputHash: config.reduceInputHash,
        kind: "corpus_summary_reduce",
        materializationMode: "evidence_from_prerequisites",
        ordinal: pages.nextOrdinal,
        streamId: deterministicId("strategy-stream", [execution.executionId, "reduce"])
      });
      steps.push({ modelRunToolCallId: calls.get(0)!, template: reduce });
      for (const prerequisiteStepId of pages.terminalStepIds) {
        dependencies.push(createKnowledgeStrategyDependencyV1({
          dependentStepId: reduce.stepId,
          executionId: execution.executionId,
          prerequisiteStepId,
          version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
        }));
      }
    } else {
      const boundStep = strategy === "exhaustive" ? steps.at(-1) : steps[0];
      if (!boundStep) throw new Error("knowledge_strategy_step_plan_invalid");
      bindToolCall(steps, boundStep.template.stepId, calls.get(0)!);
    }
  } else if (strategy === "comparison") {
    if (execution.config.kind !== "comparison") {
      throw new Error("knowledge_strategy_config_invalid");
    }
    const resolvedTargets = execution.config.targets.filter(({ admission }) =>
      admission === "resolved");
    if (resolvedTargets.length !== execution.config.targets.length ||
      calls.size !== resolvedTargets.length) return null;
    for (const target of resolvedTargets) {
      const subquery = input.plan.subqueries[target.ordinal];
      const callId = calls.get(target.ordinal);
      if (!subquery || !callId || !target.sourceBindingId) {
        throw new Error("knowledge_strategy_comparison_binding_invalid");
      }
      const stepTemplate = template({
        comparisonDimensionHash: execution.config.dimensionHash,
        execution,
        inputHash: sha256(["comparison_target", subquery.query]),
        kind: "comparison_target",
        materializationMode: "complete",
        ordinal: target.ordinal,
        sourceBindingId: target.sourceBindingId,
        streamId: deterministicId("strategy-stream", [
          execution.executionId,
          "comparison",
          target.ordinal
        ]),
        targetOrdinal: target.ordinal
      });
      steps.push({ modelRunToolCallId: callId, template: stepTemplate });
    }
  } else {
    if (execution.config.kind !== "multi_hop" ||
      calls.size !== execution.config.atomicQuestionHashes.length) {
      throw new Error("knowledge_strategy_multi_hop_binding_invalid");
    }
    let predecessorStepId: string | null = null;
    for (const [ordinal, inputHash] of execution.config.atomicQuestionHashes.entries()) {
      const current = template({
        execution,
        inputHash,
        kind: ordinal === 0 ? "multi_hop_root" : "multi_hop_follow_up",
        materializationMode: ordinal === 0
          ? "complete"
          : "evidence_from_prerequisites",
        ordinal,
        streamId: deterministicId("strategy-stream", [
          execution.executionId,
          "multi_hop",
          ordinal
        ])
      });
      steps.push({ modelRunToolCallId: calls.get(ordinal)!, template: current });
      if (predecessorStepId) {
        dependencies.push(createKnowledgeStrategyDependencyV1({
          dependentStepId: current.stepId,
          executionId: execution.executionId,
          prerequisiteStepId: predecessorStepId,
          version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
        }));
      }
      predecessorStepId = current.stepId;
    }
  }

  if (steps.length < 1 || steps.length > KNOWLEDGE_STRATEGY_MAX_STEPS ||
    new Set(steps.map(({ template: entry }) => entry.stepId)).size !== steps.length ||
    new Set(steps.map(({ template: entry }) => entry.ordinal)).size !== steps.length) {
    throw new Error("knowledge_strategy_step_plan_invalid");
  }
  return Object.freeze({
    dependencies: Object.freeze(dependencies),
    execution,
    steps: Object.freeze(steps)
  });
}
