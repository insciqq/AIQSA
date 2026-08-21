import type { MemorySummary } from "../../../contracts/memory";
import type {
  MemoryActionFeedback,
  MemoryActionResultItem
} from "../../../contracts/memoryClient";
import type { MemoryActionIntent } from "../../../contracts/memoryActionIntent";
import { memoryExplicitStatementContainsSecret } from "../explicit/safety";
import {
  MemoryControlledMutationCommittedError,
  type ExplicitMemoryService
} from "../explicit/service";
import {
  MemoryControlledForgetCommittedError,
  type MemoryLifecycleService
} from "../lifecycle/service";
import {
  MEMORY_V1_CATEGORY_ALLOWLIST,
  type MemoryV1Category
} from "../learning/extraction/contract";
import type {
  MemoryMutationAuthorizationSnapshot,
  MemoryMutationControlAuthorizationMint
} from "../persistence/authorizations";
import { memoryTargetAuthorizationPayloadHash } from "../persistence/authorizations";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import {
  defaultMemoryClientRefService,
  type MemoryClientRefService
} from "./clientRef";
import type {
  MemoryActionTarget as ExactTarget,
  MemoryActionTargetSearchService
} from "./targetSearch";
import type { MemoryTargetSelector } from "./targetSelector";

export type MemoryIntentAuthorizationRepository = Readonly<{
  mintForControl(
    userId: string,
    input: MemoryMutationControlAuthorizationMint,
    now?: Date
  ): Promise<MemoryMutationAuthorizationSnapshot>;
}>;

export type MemoryIntentActionExecutionInput = Readonly<{
  admissionDeadlineAtMs: number;
  attemptId: string;
  bindingId: string;
  chatId: string;
  currentUserText: string;
  intent: MemoryActionIntent;
  modelRunId: string;
  now?: Date;
  signal: AbortSignal;
  userId: string;
}>;

export type MemoryIntentActionExecutor = Readonly<{
  execute(input: MemoryIntentActionExecutionInput): Promise<MemoryActionFeedback | null>;
}>;

const allowedCategories = new Set<string>(MEMORY_V1_CATEGORY_ALLOWLIST);

function assertActionAdmissionActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error("memory_action_admission_aborted");
  }
}

async function abortableActionRead<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  assertActionAdmissionActive(signal);
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(
      signal.reason ?? new Error("memory_action_admission_aborted")
    );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function categoryFor(intent: MemoryActionIntent): MemoryV1Category {
  const candidate = intent.category === "sensitive"
    ? intent.categoryHint
    : intent.category;
  if (candidate && candidate !== "sensitive" && allowedCategories.has(candidate)) {
    return candidate as MemoryV1Category;
  }
  return intent.sensitivity === "SENSITIVE" ? "about_you" : "other";
}

function clientCategory(value: string): MemoryV1Category {
  return allowedCategories.has(value) ? value as MemoryV1Category : "other";
}

function activeTarget(summary: MemorySummary): ExactTarget | null {
  return summary.scope.type === "GLOBAL_USER" && summary.factState === "ACTIVE" &&
    summary.currentVersionId && summary.displayText
    ? {
        factId: summary.id,
        statement: summary.displayText,
        summary,
        versionId: summary.currentVersionId
      }
    : null;
}

function refFor(
  service: MemoryClientRefService,
  userId: string,
  modelRunId: string,
  target: ExactTarget,
  now: Date
): string {
  return service.mint(userId, {
    allowedOperations: ["EDIT", "FORGET"],
    originatingRunId: modelRunId,
    target: {
      exactItemId: target.versionId,
      factId: target.factId,
      factVersionId: target.versionId,
      itemType: "FACT_VERSION",
      recallChunkId: null,
      sourceChatId: null,
      sourceMessageIds: []
    }
  }, now);
}

function refForIdentity(
  service: MemoryClientRefService,
  userId: string,
  modelRunId: string,
  factId: string,
  versionId: string,
  now: Date
): string {
  return service.mint(userId, {
    allowedOperations: ["EDIT", "FORGET"],
    originatingRunId: modelRunId,
    target: {
      exactItemId: versionId,
      factId,
      factVersionId: versionId,
      itemType: "FACT_VERSION",
      recallChunkId: null,
      sourceChatId: null,
      sourceMessageIds: []
    }
  }, now);
}

function resultItem(
  service: MemoryClientRefService,
  userId: string,
  modelRunId: string,
  target: ExactTarget,
  now: Date
): MemoryActionResultItem {
  return {
    category: clientCategory(target.summary.category),
    createdAt: target.summary.createdAt,
    memoryRef: refFor(service, userId, modelRunId, target, now),
    provenance: target.summary.sourceMode === "EXPLICIT" ? "SAVED" : "LEARNED",
    sensitivity: target.summary.sensitivityClass === "NORMAL" ? "NORMAL" : "SENSITIVE",
    statement: target.statement
  };
}

async function selectedTarget(
  selector: MemoryTargetSelector | undefined,
  targets: readonly ExactTarget[],
  input: MemoryIntentActionExecutionInput
): Promise<
  | Readonly<{ kind: "AMBIGUOUS"; targets: readonly ExactTarget[] }>
  | Readonly<{
      kind: "TARGET";
      selectionEvidence?: Readonly<{
        acceptedOutputHash: string;
        bindingId: string;
        candidateMapHash: string;
        selectedHandle: string;
      }>;
      target: ExactTarget;
    }>
> {
  if (targets.length === 1) return { kind: "TARGET", target: targets[0]! };
  const bounded = targets.slice(0, 5);
  if (!selector || bounded.length < 2) return { kind: "AMBIGUOUS", targets: bounded };
  const candidates = bounded.map((target, index) => ({ handle: `c${index}`, target }));
  const selection = await selector.select({
    attemptId: input.attemptId,
    candidates,
    controlBindingId: input.bindingId,
    currentUserText: input.currentUserText,
    signal: input.signal,
    targetQuery: input.intent.targetQuery ?? "",
    userId: input.userId
  }).catch(() => ({ reason: "memory_target_selector_unavailable", status: "UNAVAILABLE" as const }));
  assertActionAdmissionActive(input.signal);
  if (selection.status === "READY" && selection.selectedHandle) {
    const selected = candidates.find(({ handle }) => handle === selection.selectedHandle);
    if (selected) {
      return {
        kind: "TARGET",
        selectionEvidence: {
          acceptedOutputHash: selection.acceptedOutputHash,
          bindingId: selection.bindingId,
          candidateMapHash: selection.candidateMapHash,
          selectedHandle: selection.selectedHandle
        },
        target: selected.target
      };
    }
  }
  return { kind: "AMBIGUOUS", targets: bounded };
}

async function resolveTarget(
  service: ExplicitMemoryService,
  refs: MemoryClientRefService,
  search: MemoryActionTargetSearchService | undefined,
  selector: MemoryTargetSelector | undefined,
  input: MemoryIntentActionExecutionInput,
  operation: "EDIT" | "FORGET"
): Promise<
  | Readonly<{ kind: "AMBIGUOUS"; targets: readonly ExactTarget[] }>
  | Readonly<{ kind: "MISSING" }>
  | Readonly<{
      kind: "TARGET";
      selectionEvidence?: Readonly<{
        acceptedOutputHash: string;
        bindingId: string;
        candidateMapHash: string;
        selectedHandle: string;
      }>;
      target: ExactTarget;
    }>
  | Readonly<{ kind: "UNAVAILABLE" }>
> {
  if (input.intent.referencedMemoryRef) {
    const referenced = refs.resolve(
      input.userId,
      input.intent.referencedMemoryRef,
      operation,
      input.now
    );
    if (!referenced?.target.factId || !referenced.target.factVersionId) {
      return { kind: "MISSING" };
    }
    const detail = await abortableActionRead(
      service.get(input.userId, referenced.target.factId),
      input.signal
    ).catch(() => null);
    assertActionAdmissionActive(input.signal);
    const target = detail ? activeTarget(detail.memory) : null;
    return target && target.versionId === referenced.target.factVersionId
      ? { kind: "TARGET", target }
      : { kind: "MISSING" };
  }

  const query = input.intent.targetQuery;
  if (!query) return { kind: "MISSING" };
  const normalizedQuery = normalizeMemorySearchText(query);
  if (!normalizedQuery) return { kind: "MISSING" };
  if (!search) return { kind: "UNAVAILABLE" };
  const exact = await abortableActionRead(
    search.exact({ query, userId: input.userId }),
    input.signal
  );
  if (exact.status !== "READY") return { kind: "UNAVAILABLE" };
  if (exact.targets.length > 0) {
    return selectedTarget(selector, exact.targets, input);
  }
  const semantic = await search.semantic({
    attemptId: input.attemptId,
    query,
    signal: input.signal,
    userId: input.userId
  });
  assertActionAdmissionActive(input.signal);
  if (semantic.status !== "READY") return { kind: "UNAVAILABLE" };
  if (semantic.targets.length === 0) return { kind: "MISSING" };
  return selectedTarget(selector, semantic.targets, input);
}

function mutationRejected(
  operation: "FORGET" | "SAVE" | "UPDATE"
): MemoryActionFeedback {
  return {
    operation,
    status: "REJECTED"
  };
}

async function mutationAuthorityCurrent(
  selector: MemoryTargetSelector | undefined,
  execution: MemoryIntentActionExecutionInput,
  selectionEvidence?: Readonly<{
    acceptedOutputHash: string;
    bindingId: string;
    candidateMapHash: string;
    selectedHandle: string;
  }>
): Promise<boolean> {
  if (!selector) return false;
  try {
    if (selectionEvidence) {
      await abortableActionRead(selector.assertAuthorized({
        acceptedOutputHash: selectionEvidence.acceptedOutputHash,
        bindingId: selectionEvidence.bindingId,
        controlBindingId: execution.bindingId,
        userId: execution.userId
      }), execution.signal);
    } else {
      await abortableActionRead(selector.assertControlAuthorized({
        bindingId: execution.bindingId,
        userId: execution.userId
      }), execution.signal);
    }
    assertActionAdmissionActive(execution.signal);
    return true;
  } catch {
    return false;
  }
}

export function createMemoryIntentActionExecutor(input: Readonly<{
  authorizationRepository: MemoryIntentAuthorizationRepository;
  clientRefs?: MemoryClientRefService;
  explicitService: ExplicitMemoryService;
  lifecycleService: MemoryLifecycleService;
  targetSearch?: MemoryActionTargetSearchService;
  targetSelector?: MemoryTargetSelector;
}>): MemoryIntentActionExecutor {
  const refs = input.clientRefs ?? defaultMemoryClientRefService;
  return Object.freeze({
    async execute(execution) {
      assertActionAdmissionActive(execution.signal);
      const { intent } = execution;
      const now = execution.now ?? new Date();
      if (intent.action === "NONE") return null;
      if (intent.action === "RESET") {
        return { operation: "RESET", status: "CONFIRMATION_REQUIRED" };
      }
      if (intent.action === "LIST" || intent.action === "SEARCH") {
        if (intent.action === "SEARCH") {
          if (!intent.targetQuery || !input.targetSearch) return null;
          const searched = await input.targetSearch.semantic({
            attemptId: execution.attemptId,
            query: intent.targetQuery,
            signal: execution.signal,
            userId: execution.userId
          });
          assertActionAdmissionActive(execution.signal);
          if (searched.status !== "READY") return null;
          return {
            items: searched.targets.map((target) =>
              resultItem(refs, execution.userId, execution.modelRunId, target, now)),
            operation: "SEARCH",
            status: "COMPLETE"
          };
        }
        const response = await abortableActionRead(
          input.explicitService.list(execution.userId, {
            pageSize: 20,
            scope: { type: "GLOBAL_USER" },
            state: "ACTIVE"
          }),
          execution.signal
        );
        return {
          items: response.memories.flatMap((memory) => {
            const target = activeTarget(memory);
            return target
              ? [resultItem(refs, execution.userId, execution.modelRunId, target, now)]
              : [];
          }),
          operation: intent.action,
          status: "COMPLETE"
        };
      }

      if (intent.confidenceBand !== "HIGH" || intent.sensitivity === "SECRET" ||
        intent.sensitivity === "UNCERTAIN") {
        return mutationRejected(intent.action);
      }
      if (intent.action === "SAVE") {
        const statement = intent.statement;
        if (!statement || memoryExplicitStatementContainsSecret(statement)) {
          return mutationRejected("SAVE");
        }
        if (intent.thisChatOnly) {
          return { operation: "SAVE", statement, status: "THIS_CHAT_ONLY" };
        }
        if (!await mutationAuthorityCurrent(input.targetSelector, execution)) {
          return mutationRejected("SAVE");
        }
        assertActionAdmissionActive(execution.signal);
        const authorization = await input.authorizationRepository.mintForControl(
          execution.userId,
          {
            action: "SAVE",
            admissionDeadlineAtMs: execution.admissionDeadlineAtMs,
            authorizedPayloadHash: memorySha256(statement),
            bindingId: execution.bindingId,
            chatId: execution.chatId,
            controlIntent: intent,
            modelRunId: execution.modelRunId,
            sourceText: execution.currentUserText
          },
          now
        );
        assertActionAdmissionActive(execution.signal);
        let response: Awaited<ReturnType<ExplicitMemoryService["create"]>>;
        try {
          response = await input.explicitService.create(execution.userId, {
            category: categoryFor(intent),
            modality: intent.responsePreference ? "PREFERENCE" : "STATE",
            mutationAuthorizationId: authorization.id,
            scope: { type: "GLOBAL_USER" },
            statement
          }, {
            admissionDeadlineAtMs: execution.admissionDeadlineAtMs,
            authorizedPayloadHash: authorization.authorizedPayloadHash,
            modelRunId: execution.modelRunId,
            persistedToolCallId: null,
            safetyClassifierExecutionId: execution.bindingId,
            safetyClassifierIntent: intent,
            sensitivityClass: "NORMAL"
          });
        } catch (error) {
          if (error instanceof MemoryControlledMutationCommittedError) {
            return {
              memoryRef: refForIdentity(
                refs,
                execution.userId,
                execution.modelRunId,
                error.factId,
                error.versionId,
                now
              ),
              operation: "SAVE",
              statement: error.statement,
              status: "COMMITTED"
            };
          }
          throw error;
        }
        const target = activeTarget(response.memory);
        return target
          ? {
              memoryRef: refFor(refs, execution.userId, execution.modelRunId, target, now),
              operation: "SAVE",
              statement: target.statement,
              status: "COMMITTED"
            }
          : mutationRejected("SAVE");
      }

      const operation = intent.action === "UPDATE" ? "EDIT" as const : "FORGET" as const;
      if (intent.action === "UPDATE" && (
        !intent.replacementStatement ||
        memoryExplicitStatementContainsSecret(intent.replacementStatement)
      )) {
        return mutationRejected("UPDATE");
      }
      const resolution = await resolveTarget(
        input.explicitService,
        refs,
        input.targetSearch,
        input.targetSelector,
        execution,
        operation
      );
      if (resolution.kind === "AMBIGUOUS") {
        return {
          candidates: resolution.targets.map((target) =>
            resultItem(refs, execution.userId, execution.modelRunId, target, now)),
          operation: intent.action,
          ...(intent.action === "UPDATE" && intent.replacementStatement
            ? { statement: intent.replacementStatement }
            : {}),
          status: "AMBIGUOUS"
        };
      }
      if (resolution.kind === "MISSING") {
        return mutationRejected(intent.action);
      }
      if (resolution.kind === "UNAVAILABLE") return null;
      const target = resolution.target;
      if (!await mutationAuthorityCurrent(
        input.targetSelector,
        execution,
        resolution.selectionEvidence
      )) {
        return mutationRejected(intent.action);
      }
      assertActionAdmissionActive(execution.signal);
      const authorizedPayloadHash = memoryTargetAuthorizationPayloadHash({
        action: operation,
        expectedTargetVersionId: target.versionId,
        replacementStatementHash: intent.action === "UPDATE"
          ? memorySha256(intent.replacementStatement!)
          : undefined,
        targetFactId: target.factId
      });
      const authorization = await input.authorizationRepository.mintForControl(
        execution.userId,
        {
          action: operation,
          admissionDeadlineAtMs: execution.admissionDeadlineAtMs,
          authorizedPayloadHash,
          bindingId: execution.bindingId,
          chatId: execution.chatId,
          controlIntent: intent,
          expectedTargetVersionId: target.versionId,
          modelRunId: execution.modelRunId,
          ...(resolution.selectionEvidence ? {
            targetSelectionBindingId: resolution.selectionEvidence.bindingId,
            targetSelectionCandidateMapHash: resolution.selectionEvidence.candidateMapHash,
            targetSelectionOutputHash: resolution.selectionEvidence.acceptedOutputHash,
            targetSelectionSelectedHandle: resolution.selectionEvidence.selectedHandle
          } : {}),
          sourceText: execution.currentUserText,
          targetFactId: target.factId
        },
        now
      );
      assertActionAdmissionActive(execution.signal);
      if (intent.action === "UPDATE") {
        const statement = intent.replacementStatement!;
        let response: Awaited<ReturnType<ExplicitMemoryService["update"]>>;
        try {
          response = await input.explicitService.update(execution.userId, target.factId, {
            category: categoryFor(intent),
            expectedVersionId: target.versionId,
            modality: intent.responsePreference ? "PREFERENCE" : "STATE",
            mutationAuthorizationId: authorization.id,
            statement
          }, {
            admissionDeadlineAtMs: execution.admissionDeadlineAtMs,
            modelRunId: execution.modelRunId,
            persistedToolCallId: null,
            safetyClassifierExecutionId: execution.bindingId,
            safetyClassifierIntent: intent,
            sensitivityClass: "NORMAL"
          });
        } catch (error) {
          if (error instanceof MemoryControlledMutationCommittedError) {
            return {
              memoryRef: refForIdentity(
                refs,
                execution.userId,
                execution.modelRunId,
                error.factId,
                error.versionId,
                now
              ),
              operation: "UPDATE",
              statement: error.statement,
              status: "COMMITTED"
            };
          }
          throw error;
        }
        const updated = activeTarget(response.memory);
        return updated
          ? {
              memoryRef: refFor(refs, execution.userId, execution.modelRunId, updated, now),
              operation: "UPDATE",
              statement: updated.statement,
              status: "COMMITTED"
            }
          : mutationRejected("UPDATE");
      }
      assertActionAdmissionActive(execution.signal);
      try {
        await input.lifecycleService.forget(execution.userId, target.factId, {
          expectedVersionId: target.versionId,
          mutationAuthorizationId: authorization.id
        }, {
          admissionDeadlineAtMs: execution.admissionDeadlineAtMs,
          modelRunId: execution.modelRunId,
          persistedToolCallId: null
        });
      } catch (error) {
        if (!(error instanceof MemoryControlledForgetCommittedError)) throw error;
      }
      return { operation: "FORGET", status: "COMMITTED" };
    }
  });
}
