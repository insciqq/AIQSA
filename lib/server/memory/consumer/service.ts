import { Prisma, type MemoryDeletionState } from "@prisma/client";
import {
  MEMORY_CONSUMER_CONFIRMATION_COPY_VERSION,
  decodeMemoryConsumerItemResponse,
  decodeMemoryConsumerListResponse,
  decodeMemoryConsumerMutationResponse,
  decodeMemoryConsumerSettingsResponse,
  type MemoryConsumerForgetInput,
  type MemoryConsumerForgetResponse,
  type MemoryConsumerItem,
  type MemoryConsumerItemResponse,
  type MemoryConsumerListInput,
  type MemoryConsumerListResponse,
  type MemoryConsumerMutationResponse,
  type MemoryConsumerResetInput,
  type MemoryConsumerResetResponse,
  type MemoryConsumerSearchInput,
  type MemoryConsumerSettingsPatch,
  type MemoryConsumerSettingsResponse,
  type MemoryConsumerStatementMutation
} from "../../../contracts/memoryConsumer";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemorySettingsResponse,
  type MemorySummary
} from "../../../contracts/memory";
import { logEvent, type LifecycleFields } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import {
  MEMORY_PERSISTENCE_ERROR_CODES,
  memoryPersistenceFailureCode
} from "../persistence/errors";
import { memorySha256 } from "../persistence/lexical";
import type { MemoryEquivalentTargetResolver } from "../persistence/explicitEquivalence";
import {
  ExplicitMemoryServiceError,
  type ExplicitMemoryService,
  type ExplicitMemoryServiceErrorCode,
  type MemoryMutationAuthorizationContext
} from "../explicit/service";
import {
  MemoryForgetCommittedResponseError,
  MemoryLifecycleServiceError,
  type MemoryLifecycleService,
  type MemoryLifecycleServiceErrorCode
} from "../lifecycle/service";
import { memoryForgetPeerCascadeCount } from "../lifecycle/sourcePreservation";
import {
  MemorySettingsServiceError,
  type MemorySettingsService
} from "../settings/service";
import {
  defaultMemoryConsumerRefService,
  type MemoryConsumerRefOperation,
  type MemoryConsumerRefService
} from "./ref";

const MEMORY_CONSUMER_SERVICE_ERROR_CODES = [
  "memory_action_failed",
  "memory_changed",
  "memory_contract_invalid",
  "memory_not_found",
  "memory_preparing",
  "memory_reset_in_progress",
  "memory_secret_rejected",
  "memory_unavailable"
] as const;

export type MemoryConsumerServiceErrorCode =
  (typeof MEMORY_CONSUMER_SERVICE_ERROR_CODES)[number];

export class MemoryConsumerServiceError extends Error {
  constructor(readonly code: MemoryConsumerServiceErrorCode) {
    super(code);
    this.name = "MemoryConsumerServiceError";
  }
}

export type MemoryConsumerResetStateReader = (
  userId: string
) => Promise<MemoryDeletionState | null>;

export type MemoryConsumerMutationContext = Readonly<{
  authority: "DELEGATED_MCP" | "DIRECT_USER";
}>;

export type MemoryConsumerService = Readonly<{
  create(
    userId: string,
    input: MemoryConsumerStatementMutation,
    context?: MemoryConsumerMutationContext
  ): Promise<MemoryConsumerMutationResponse>;
  edit(
    userId: string,
    memoryRef: string,
    input: MemoryConsumerStatementMutation,
    context?: MemoryConsumerMutationContext
  ): Promise<MemoryConsumerMutationResponse>;
  forget(
    userId: string,
    memoryRef: string,
    input: MemoryConsumerForgetInput,
    context?: MemoryConsumerMutationContext
  ): Promise<MemoryConsumerForgetResponse>;
  get(
    userId: string,
    memoryRef: string,
    context?: MemoryConsumerMutationContext
  ): Promise<MemoryConsumerItemResponse>;
  list(
    userId: string,
    input: MemoryConsumerListInput,
    context?: MemoryConsumerMutationContext
  ): Promise<MemoryConsumerListResponse>;
  patchSettings(
    userId: string,
    patch: MemoryConsumerSettingsPatch
  ): Promise<MemoryConsumerSettingsResponse>;
  reset(
    userId: string,
    input: MemoryConsumerResetInput
  ): Promise<MemoryConsumerResetResponse>;
  search(
    userId: string,
    input: MemoryConsumerSearchInput,
    context?: MemoryConsumerMutationContext
  ): Promise<MemoryConsumerListResponse>;
  settings(userId: string): Promise<MemoryConsumerSettingsResponse>;
}>;

function failure(code: MemoryConsumerServiceErrorCode): never {
  throw new MemoryConsumerServiceError(code);
}

function legacyErrorCode(error: unknown): string | null {
  if (error instanceof ExplicitMemoryServiceError ||
    error instanceof MemoryLifecycleServiceError ||
    error instanceof MemorySettingsServiceError) return error.code;
  return null;
}

function mappedFailure(error: unknown): never {
  switch (legacyErrorCode(error)) {
    case "memory_contract_invalid":
    case "memory_scope_invalid":
      return failure("memory_contract_invalid");
    case "memory_not_found":
    case "memory_scope_unavailable":
      return failure("memory_not_found");
    case "memory_version_stale":
    case "memory_intent_confirmation_required":
      return failure("memory_changed");
    case "memory_secret_rejected":
      return failure("memory_secret_rejected");
    case "memory_embedding_unavailable":
    case "memory_index_unavailable":
    case "memory_model_unavailable":
    case "memory_unavailable":
      return failure("memory_unavailable");
    case "memory_statement_invalid":
      return failure("memory_contract_invalid");
    default:
      return failure("memory_action_failed");
  }
}

async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MemoryConsumerServiceError) throw error;
    return mappedFailure(error);
  }
}

function consumerFailure(error: unknown): MemoryConsumerServiceError {
  if (error instanceof MemoryConsumerServiceError) return error;
  try {
    return mappedFailure(error);
  } catch (mapped) {
    return mapped as MemoryConsumerServiceError;
  }
}

// Closed vocabularies whose members may name a Forget diagnostic. Any other
// value, including a forged class code, collapses to a fixed fallback.
const FORGET_SERVICE_CODES: ReadonlySet<string> = new Set<string>([
  ...MEMORY_PERSISTENCE_ERROR_CODES,
  ...MEMORY_CONSUMER_SERVICE_ERROR_CODES,
  ...([
    "memory_index_unavailable",
    "memory_intent_confirmation_required",
    "memory_operation_unsupported",
    "memory_scope_invalid",
    "memory_scope_unavailable",
    "memory_statement_invalid",
    "memory_undo_unavailable",
    "memory_version_stale"
  ] as const satisfies ReadonlyArray<ExplicitMemoryServiceErrorCode | MemoryLifecycleServiceErrorCode>)
]);

type ForgetObservation = Pick<LifecycleFields, "action" | "code" | "count" | "outcome" | "prisma_code" | "stage">;

/** One content-free event per Forget outcome that needs operator attention,
 * written where both HTTP and MCP callers converge. Only class-owned codes
 * from closed vocabularies and the database boundary's retained P-code are
 * read; messages, causes, stacks and Prisma meta never are. */
function observeForget(fields: ForgetObservation): void {
  try {
    logEvent("service_operation", { subsystem: "memory", ...fields });
  } catch {
    // A diagnostic sink cannot change the Forget outcome.
  }
}

function forgetFailureObservation(
  error: unknown,
  mapped: MemoryConsumerServiceError
): ForgetObservation {
  const directPrismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code
    : error instanceof Prisma.PrismaClientInitializationError ? error.errorCode : undefined;
  const prismaCode = typeof directPrismaCode === "string" && /^P\d{4}$/u.test(directPrismaCode)
    ? directPrismaCode : databaseFailureCode(error);
  const ownedCode = memoryPersistenceFailureCode(error) ?? (
    error instanceof ExplicitMemoryServiceError || error instanceof MemoryLifecycleServiceError ||
    error instanceof MemoryConsumerServiceError ? error.code : null);
  const domainCode = typeof ownedCode === "string" && ownedCode !== "memory_action_failed" &&
    FORGET_SERVICE_CODES.has(ownedCode) ? ownedCode : null;
  const code = domainCode ??
    (prismaCode !== "unknown" ? "memory_forget_database_failed" : "memory_forget_failed");
  switch (mapped.code) {
    case "memory_changed":
    case "memory_reset_in_progress":
      return { action: "skip", code, outcome: "stale", prisma_code: prismaCode, stage: "delete" };
    case "memory_contract_invalid":
    case "memory_not_found":
    case "memory_secret_rejected":
      return { action: "skip", code, outcome: "skipped", prisma_code: prismaCode, stage: "delete" };
    default:
      return { action: "fail", code, outcome: "failed", prisma_code: prismaCode, stage: "delete" };
  }
}

async function observedForget<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const mapped = consumerFailure(error);
    observeForget(forgetFailureObservation(error, mapped));
    throw mapped;
  }
}

function category(value: string): MemoryConsumerItem["category"] {
  switch (value.trim().toLowerCase()) {
    case "about":
    case "about_you":
    case "identity":
      return "ABOUT_YOU";
    case "preference":
    case "preferences":
      return "PREFERENCES";
    case "work":
      return "WORK";
    case "goal":
    case "goals":
      return "GOALS";
    case "constraint":
    case "constraints":
    case "constraints_routines":
    case "constraints_and_routines":
    case "habit":
    case "routine":
    case "routines":
      return "CONSTRAINTS_AND_ROUTINES";
    case "sensitive":
    case "sensitive_information":
      return "OTHER";
    default:
      return "OTHER";
  }
}

function storageCategory(
  value: NonNullable<MemoryConsumerListInput["category"]>
): string {
  switch (value) {
    case "ABOUT_YOU":
      return "about_you";
    case "PREFERENCES":
      return "preferences";
    case "WORK":
      return "work";
    case "GOALS":
      return "goals";
    case "CONSTRAINTS_AND_ROUTINES":
      return "constraints_routines";
    case "OTHER":
      return "other";
  }
}

function sourceMode(
  value: MemoryConsumerListInput["provenance"]
): "AUTOMATIC" | "EXPLICIT" | undefined {
  return value === "LEARNED"
    ? "AUTOMATIC"
    : value === "SAVED"
      ? "EXPLICIT"
      : undefined;
}

function resetState(
  state: MemoryDeletionState | null
): MemoryConsumerSettingsResponse["resetState"] {
  if (state && state !== "CANCELLED" && state !== "SUCCEEDED") {
    return "IN_PROGRESS";
  }
  return "IDLE";
}

function consumerStatus(
  response: MemorySettingsResponse
): MemoryConsumerSettingsResponse["status"] {
  if (!response.settings.useMemoryFacts) return "PAUSED";
  if (response.capabilities.administratorSetupRequired) {
    return "NEEDS_ADMIN_SETUP";
  }
  if (
    !response.capabilities.naturalLanguageActionsAvailable ||
    !response.capabilities.retrievalAvailable ||
    response.settings.learnAutomatically &&
      !response.capabilities.automaticLearningAvailable ||
    response.settings.referenceChatHistory &&
      !response.capabilities.pastChatIndexingAvailable ||
    // `synthesisAvailable` now reports background maintenance, which follows
    // automatic learning.
    response.settings.learnAutomatically &&
      !response.capabilities.synthesisAvailable ||
    response.settings.decayEnabled && !response.capabilities.decayAvailable
  ) return "UNAVAILABLE";
  return "ON";
}

function projectSettings(
  response: MemorySettingsResponse,
  reset: MemoryDeletionState | null
): MemoryConsumerSettingsResponse {
  const candidate: MemoryConsumerSettingsResponse = {
    capabilities: {
      automaticLearningAvailable: response.capabilities.automaticLearningAvailable,
      decayAvailable: response.capabilities.decayAvailable,
      managementAvailable: response.capabilities.managementAvailable,
      naturalLanguageActionsAvailable: response.capabilities.naturalLanguageActionsAvailable,
      permanentChatDeletion: response.capabilities.permanentChatDeletion,
      pastChatIndexingAvailable: response.capabilities.pastChatIndexingAvailable,
      retrievalAvailable: response.capabilities.retrievalAvailable,
      synthesisAvailable: response.capabilities.synthesisAvailable,
      temporaryChats: response.capabilities.temporaryChats
    },
    resetState: resetState(reset),
    settings: {
      decayEnabled: response.settings.decayEnabled,
      learnAutomatically: response.settings.learnAutomatically,
      referenceChatHistory: response.settings.referenceChatHistory,
      synthesisEnabled: response.settings.synthesisEnabled,
      useMemoryFacts: response.settings.useMemoryFacts
    },
    status: consumerStatus(response)
  };
  const decoded = decodeMemoryConsumerSettingsResponse(candidate);
  return decoded.ok ? decoded.value : failure("memory_action_failed");
}

export function projectMemoryConsumerItem(
  refs: MemoryConsumerRefService,
  userId: string,
  summary: MemorySummary,
  now: Date
): MemoryConsumerItem {
  const versionId = summary.currentVersionId ?? summary.actionVersionId;
  if (summary.factState !== "ACTIVE" || !summary.displayText || !versionId) {
    return failure("memory_action_failed");
  }
  const sourceAvailable = summary.sourceMode === "EXPLICIT" || summary.sourceCount > 0;
  const pattern = summary.modality === "PATTERN";
  return {
    allowedActions: pattern ? ["FORGET"] : ["EDIT", "FORGET"],
    category: category(summary.category),
    ...(summary.combinedSources ? {
      combined: {
        sourceCount: summary.combinedSources.length,
        sources: summary.combinedSources.map((source) => ({
          category: category(source.category),
          createdAt: source.createdAt,
          memoryRef: refs.mintItem(userId, {
            allowedOperations: ["READ", "FORGET"],
            factId: source.factId,
            factVersionId: source.versionId
          }, now),
          provenance: source.sourceMode === "EXPLICIT" ? "SAVED" as const : "LEARNED" as const,
          sourceAvailable: true,
          statement: source.statement,
          updatedAt: source.updatedAt
        }))
      }
    } : {}),
    createdAt: summary.createdAt,
    memoryRef: refs.mintItem(userId, {
      allowedOperations: pattern ? ["READ", "FORGET"] : ["READ", "EDIT", "FORGET"],
      factId: summary.id,
      factVersionId: versionId
    }, now),
    provenance: summary.sourceMode === "EXPLICIT" ? "SAVED" : "LEARNED",
    sourceAvailable,
    statement: summary.displayText,
    updatedAt: summary.updatedAt
  };
}

function projectItem(
  refs: MemoryConsumerRefService,
  userId: string,
  summary: MemorySummary,
  now: Date
): MemoryConsumerItemResponse {
  const candidate = { item: projectMemoryConsumerItem(refs, userId, summary, now) };
  const decoded = decodeMemoryConsumerItemResponse(candidate);
  return decoded.ok ? decoded.value : failure("memory_action_failed");
}

function projectList(
  refs: MemoryConsumerRefService,
  userId: string,
  response: Awaited<ReturnType<ExplicitMemoryService["list"]>>,
  now: Date
): MemoryConsumerListResponse {
  const candidate: MemoryConsumerListResponse = {
    items: response.memories.map((memory) =>
      projectMemoryConsumerItem(refs, userId, memory, now)),
    nextCursor: response.nextCursor
      ? refs.mintCursor(userId, response.nextCursor, now)
      : null
  };
  const decoded = decodeMemoryConsumerListResponse(candidate);
  return decoded.ok ? decoded.value : failure("memory_action_failed");
}

function projectMutation(
  refs: MemoryConsumerRefService,
  userId: string,
  response: Awaited<ReturnType<ExplicitMemoryService["create"]>>,
  now: Date
): MemoryConsumerMutationResponse {
  const candidate = projectItem(refs, userId, response.memory, now);
  const decoded = decodeMemoryConsumerMutationResponse(candidate);
  return decoded.ok ? decoded.value : failure("memory_action_failed");
}

function mutationAuthorizationContext(
  context: MemoryConsumerMutationContext | undefined
): MemoryMutationAuthorizationContext {
  if (!context || context.authority === "DIRECT_USER") {
    return { origin: "DIRECT_API" };
  }
  if (context.authority === "DELEGATED_MCP") {
    return { origin: "DELEGATED_MCP" };
  }
  return failure("memory_contract_invalid");
}

function resolvedCursor(
  refs: MemoryConsumerRefService,
  userId: string,
  cursor: string | null | undefined,
  now: Date
): string | null {
  if (!cursor) return null;
  return refs.resolveCursor(userId, cursor, now) ?? failure("memory_contract_invalid");
}

export function createMemoryConsumerService(input: Readonly<{
  clock?: () => Date;
  explicitService: ExplicitMemoryService;
  lifecycleService: MemoryLifecycleService;
  readResetState: MemoryConsumerResetStateReader;
  refs?: MemoryConsumerRefService;
  resolveEquivalentTarget?: MemoryEquivalentTargetResolver;
  settingsService: MemorySettingsService;
}>): MemoryConsumerService {
  const clock = input.clock ?? (() => new Date());
  const refs = input.refs ?? defaultMemoryConsumerRefService;

  async function itemTarget(userId: string, ref: string, operation: MemoryConsumerRefOperation, now: Date) {
    const target = refs.resolveItem(userId, ref, operation, now);
    if (!target) return failure("memory_not_found");
    return await input.resolveEquivalentTarget?.(userId, target, now) ?? target;
  }

  async function currentSettings(userId: string): Promise<MemorySettingsResponse> {
    return input.settingsService.get(userId);
  }

  async function settingsProjection(
    userId: string,
    response: MemorySettingsResponse
  ): Promise<MemoryConsumerSettingsResponse> {
    return projectSettings(response, await input.readResetState(userId));
  }

  return Object.freeze({
    create(userId, createInput, context) {
      return safe(async () => {
        const authorization = await input.explicitService.mintAuthorization(userId, {
          action: "SAVE",
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          exactStatementHash: memorySha256(createInput.statement),
          requestNonce: createInput.requestId
        }, mutationAuthorizationContext(context));
        const response = await input.explicitService.create(userId, {
          mutationAuthorizationId: authorization.mutationAuthorizationId,
          scope: { type: "GLOBAL_USER" },
          statement: createInput.statement
        });
        return projectMutation(refs, userId, response, clock());
      });
    },

    edit(userId, memoryRef, editInput, context) {
      return safe(async () => {
        const target = await itemTarget(userId, memoryRef, "EDIT", clock());
        const authorization = await input.explicitService.mintAuthorization(userId, {
          action: "EDIT",
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          expectedTargetVersionId: target.factVersionId,
          requestNonce: editInput.requestId,
          targetFactId: target.factId
        }, mutationAuthorizationContext(context));
        const response = await input.explicitService.update(userId, target.factId, {
          expectedVersionId: target.factVersionId,
          mutationAuthorizationId: authorization.mutationAuthorizationId,
          statement: editInput.statement
        });
        return projectMutation(refs, userId, response, clock());
      });
    },

    forget(userId, memoryRef, forgetInput, context) {
      return observedForget(async () => {
        const target = await itemTarget(userId, memoryRef, "FORGET", clock());
        const authorization = await input.explicitService.mintAuthorization(userId, {
          action: "FORGET",
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          expectedTargetVersionId: target.factVersionId,
          requestNonce: forgetInput.requestId,
          targetFactId: target.factId
        }, mutationAuthorizationContext(context));
        let forgotten: unknown;
        try {
          forgotten = await input.lifecycleService.forget(userId, target.factId, {
            expectedVersionId: target.factVersionId,
            mutationAuthorizationId: authorization.mutationAuthorizationId
          });
        } catch (error) {
          // The deletion committed; only its response projection failed.
          if (!(error instanceof MemoryForgetCommittedResponseError)) throw error;
          observeForget({ action: "complete", code: "memory_forget_post_commit_degraded",
            outcome: "degraded", stage: "complete" });
          return { status: "FORGOTTEN" };
        }
        const cascadedPeers = memoryForgetPeerCascadeCount(forgotten);
        if (cascadedPeers > 0) {
          observeForget({ action: "complete", code: "memory_forget_peer_dependency_cascade",
            count: cascadedPeers, outcome: "degraded", stage: "delete" });
        }
        return { status: "FORGOTTEN" };
      });
    },

    get(userId, memoryRef, context) {
      return safe(async () => {
        const now = clock();
        const target = await itemTarget(userId, memoryRef, "READ", now);
        const detail = await input.explicitService.get(userId, target.factId);
        const currentVersionId = detail.memory.currentVersionId ??
          detail.memory.actionVersionId;
        if (detail.memory.factState !== "ACTIVE" || !currentVersionId ||
          (context?.authority === "DELEGATED_MCP" && detail.memory.modality === "PATTERN")) {
          return failure("memory_not_found");
        }
        if (currentVersionId !== target.factVersionId) {
          return failure("memory_changed");
        }
        return projectItem(refs, userId, detail.memory, now);
      });
    },

    list(userId, listInput, context) {
      return safe(async () => {
        const now = clock();
        const response = await input.explicitService.list(userId, {
          category: listInput.category
            ? storageCategory(listInput.category)
            : undefined,
          cursor: resolvedCursor(refs, userId, listInput.cursor, now),
          includePatterns: context?.authority !== "DELEGATED_MCP",
          pageSize: listInput.pageSize,
          scope: { type: "GLOBAL_USER" },
          sourceMode: sourceMode(listInput.provenance),
          state: "ACTIVE"
        });
        return projectList(refs, userId, response, now);
      });
    },

    patchSettings(userId, patch) {
      return safe(async () => {
        const current = await currentSettings(userId);
        const response = await input.settingsService.patch(userId, {
          ...patch,
          expectedMemoryRevision: current.settings.memoryRevision,
          expectedSettingsRevision: current.settings.settingsRevision
        });
        return settingsProjection(userId, response);
      });
    },

    reset(userId, resetInput) {
      return safe(async () => {
        if (resetInput.confirmationCopyVersion !==
          MEMORY_CONSUMER_CONFIRMATION_COPY_VERSION) {
          return failure("memory_contract_invalid");
        }
        const existing = await input.readResetState(userId);
        if (existing && existing !== "CANCELLED" && existing !== "SUCCEEDED") {
          return { status: "IN_PROGRESS" };
        }
        const current = await currentSettings(userId);
        const authorization = await input.explicitService.mintAuthorization(userId, {
          action: "BULK_DELETE",
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          expectedMemoryRevision: current.settings.memoryRevision,
          expectedSettingsRevision: current.settings.settingsRevision,
          operation: "DELETE_ALL_REUSABLE",
          requestNonce: resetInput.requestId
        });
        const admitted = await input.lifecycleService.deleteExplicit(userId, {
          expectedMemoryRevision: current.settings.memoryRevision,
          expectedSettingsRevision: current.settings.settingsRevision,
          mutationAuthorizationId: authorization.mutationAuthorizationId,
          operation: "DELETE_ALL_REUSABLE"
        });
        return {
          status: admitted.state === "SUCCEEDED" ? "COMPLETE" : "IN_PROGRESS"
        };
      });
    },

    search(userId, searchInput, context) {
      return safe(async () => {
        const now = clock();
        const response = await input.explicitService.search(userId, {
          category: searchInput.category
            ? storageCategory(searchInput.category)
            : undefined,
          cursor: resolvedCursor(refs, userId, searchInput.cursor, now),
          includePatterns: context?.authority !== "DELEGATED_MCP",
          pageSize: searchInput.pageSize,
          query: searchInput.query,
          scope: { type: "GLOBAL_USER" },
          sourceMode: sourceMode(searchInput.provenance),
          state: "ACTIVE"
        });
        return projectList(refs, userId, response, now);
      });
    },

    settings(userId) {
      return safe(async () => settingsProjection(userId, await currentSettings(userId)));
    }
  });
}
