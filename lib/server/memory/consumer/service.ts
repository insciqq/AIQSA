import type { MemoryDeletionState } from "@prisma/client";
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
import { memorySha256 } from "../persistence/lexical";
import {
  ExplicitMemoryServiceError,
  type ExplicitMemoryService,
  type MemoryMutationAuthorizationContext
} from "../explicit/service";
import {
  MemoryLifecycleServiceError,
  type MemoryLifecycleService
} from "../lifecycle/service";
import {
  MemorySettingsServiceError,
  type MemorySettingsService
} from "../settings/service";
import {
  defaultMemoryConsumerRefService,
  type MemoryConsumerRefService
} from "./ref";

export type MemoryConsumerServiceErrorCode =
  | "memory_action_failed"
  | "memory_changed"
  | "memory_contract_invalid"
  | "memory_not_found"
  | "memory_preparing"
  | "memory_reset_in_progress"
  | "memory_secret_rejected"
  | "memory_unavailable";

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
  get(userId: string, memoryRef: string): Promise<MemoryConsumerItemResponse>;
  list(
    userId: string,
    input: MemoryConsumerListInput
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
    input: MemoryConsumerSearchInput
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
    case "memory_egress_consent_required":
    case "memory_egress_admin_owned":
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
    response.egress.reviewRequired ||
    !response.capabilities.naturalLanguageActionsAvailable ||
    !response.capabilities.retrievalAvailable ||
    response.settings.learnAutomatically &&
      !response.capabilities.automaticLearningAvailable ||
    response.settings.referenceChatHistory &&
      !response.capabilities.pastChatIndexingAvailable ||
    response.settings.synthesisEnabled &&
      !response.capabilities.synthesisAvailable ||
    response.settings.decayEnabled && !response.capabilities.decayAvailable
  ) return "UNAVAILABLE";
  if (response.settings.referenceChatHistory &&
    response.historyIndexing.state === "INDEXING") return "PREPARING";
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
  return {
    allowedActions: ["EDIT", "FORGET"],
    category: category(summary.category),
    createdAt: summary.createdAt,
    memoryRef: refs.mintItem(userId, {
      allowedOperations: ["READ", "EDIT", "FORGET"],
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
  settingsService: MemorySettingsService;
}>): MemoryConsumerService {
  const clock = input.clock ?? (() => new Date());
  const refs = input.refs ?? defaultMemoryConsumerRefService;

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
        const target = refs.resolveItem(userId, memoryRef, "EDIT", clock());
        if (!target) return failure("memory_not_found");
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
      return safe(async () => {
        const target = refs.resolveItem(userId, memoryRef, "FORGET", clock());
        if (!target) return failure("memory_not_found");
        const authorization = await input.explicitService.mintAuthorization(userId, {
          action: "FORGET",
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          expectedTargetVersionId: target.factVersionId,
          requestNonce: forgetInput.requestId,
          targetFactId: target.factId
        }, mutationAuthorizationContext(context));
        await input.lifecycleService.forget(userId, target.factId, {
          expectedVersionId: target.factVersionId,
          mutationAuthorizationId: authorization.mutationAuthorizationId
        });
        return { status: "FORGOTTEN" };
      });
    },

    get(userId, memoryRef) {
      return safe(async () => {
        const now = clock();
        const target = refs.resolveItem(userId, memoryRef, "READ", now);
        if (!target) return failure("memory_not_found");
        const detail = await input.explicitService.get(userId, target.factId);
        const currentVersionId = detail.memory.currentVersionId ??
          detail.memory.actionVersionId;
        if (detail.memory.factState !== "ACTIVE" || !currentVersionId) {
          return failure("memory_not_found");
        }
        if (currentVersionId !== target.factVersionId) {
          return failure("memory_changed");
        }
        return projectItem(refs, userId, detail.memory, now);
      });
    },

    list(userId, listInput) {
      return safe(async () => {
        const now = clock();
        const response = await input.explicitService.list(userId, {
          category: listInput.category
            ? storageCategory(listInput.category)
            : undefined,
          cursor: resolvedCursor(refs, userId, listInput.cursor, now),
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

    search(userId, searchInput) {
      return safe(async () => {
        const now = clock();
        const response = await input.explicitService.search(userId, {
          category: searchInput.category
            ? storageCategory(searchInput.category)
            : undefined,
          cursor: resolvedCursor(refs, userId, searchInput.cursor, now),
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
