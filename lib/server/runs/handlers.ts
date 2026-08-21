import { getAuthConfig, type AuthConfig } from "../auth/config";
import type {
  CancelModelRunNotCancelableResponse,
  CancelModelRunSuccessResponse,
  ModelRunErrorResponse,
  RunOutcomeResponse
} from "../../contracts/runs";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";
import type { ProviderRuntimeResolver } from "../providerRuntime/runtimeResolver";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import type {
  NormalizedRunRequest,
  ProviderAdapter,
  ProviderRunRequest,
  ProviderSearchAdapter
} from "../providers/types";
import type { ProviderToolBridge } from "../tools/types";
import type { StorageAdapter } from "../uploads/storage";
import type { KnowledgeToolExecutor } from "../knowledge/toolExecutor";
import type { KnowledgeProviderDispatchLifecycle } from "../knowledge/providerDispatchLifecycle";
import type { MemoryToolEgressReceiptService } from "../memory/egress/receipts";
import { activeRunControllerRegistry, createRunExecutionResponse } from "./runExecution";
import {
  materializePreparedRunData,
  prepareRun,
  type RunPreparationDeps,
  type RunPreparationFailure
} from "./runPreparation";
import {
  activeRunStaleMs,
  reconcileStaleRuns,
  sweepBootOrphanedRunsOnce
} from "./runRecovery";
import {
  ActiveLeafConflictError,
  ActiveRunConflictError,
  AssistantRunConflictError,
  AttachmentLinkConflictError,
  KnowledgeRunPlanConflictError,
  McpRunPlanConflictError,
  ProviderAdmissionConflictError,
  SkillRunConflictError
} from "./runRepositoryContract";
import type { RunRepository } from "./runRepositoryContract";
import { serializeRunOutcome } from "./runOutcome";
import { MemoryPreparingRunConflictError } from "./preparingRun";
import { applyProviderRequestContextBudget } from "./runContextBudget";
import type {
  CreatedRun,
  PreparingRunMemoryMaterializer
} from "./runRepositoryContract";

export { ActiveLeafConflictError, ActiveRunConflictError };
export type {
  AcceptedRunDefaults,
  RunAttachmentRecord,
  RunChatUpdateRecord,
  RunControlRecord,
  RunRepository,
  StaleRunControlRecord
} from "./runRepositoryContract";

export type RunHandlerDeps = {
  allowFakeProvider?: boolean;
  assistants?: RunPreparationDeps["assistants"];
  getAttachmentLimits?: RunPreparationDeps["getAttachmentLimits"];
  getConfig?: () => AuthConfig;
  knowledgeAdmission?: RunPreparationDeps["knowledgeAdmission"];
  knowledgeExecutor?: KnowledgeToolExecutor;
  knowledgeProviderDispatch?: KnowledgeProviderDispatchLifecycle;
  memoryEgress?: MemoryToolEgressReceiptService;
  mcp?: RunPreparationDeps["mcp"];
  providerAdmission?: RunPreparationDeps["providerAdmission"];
  providerRuntime?: ProviderRuntimeResolver;
  providers: Record<string, ProviderAdapter>;
  repository: RunRepository;
  resolveAuth: RequestAuthResolver;
  runPolicy?: RunPreparationDeps["runPolicy"];
  searchProviders?: Record<string, ProviderSearchAdapter>;
  skills?: RunPreparationDeps["skills"];
  storage?: StorageAdapter;
};

const activeRunGateWindowMs = activeRunStaleMs;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function projectDraftFromBody(body: Record<string, unknown> | null):
  | Readonly<{ folderId: string | null; projectId: string }>
  | "invalid"
  | null {
  if (!body || body.projectDraft === undefined) return null;
  const value = body.projectDraft;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid";
  const draft = value as Record<string, unknown>;
  const folderId = draft.folderId ?? null;
  if (!uuidPattern.test(String(draft.projectId ?? "")) ||
    (folderId !== null && !uuidPattern.test(String(folderId))) ||
    Object.keys(draft).some((key) => key !== "folderId" && key !== "projectId")) return "invalid";
  return { folderId: folderId === null ? null : String(folderId), projectId: String(draft.projectId) };
}

async function readJson(
  request: Request
): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  return [
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null,
    requestBodyErrorResponse(value)
  ];
}

function runPreparationFailureResponse(failure: RunPreparationFailure): Response {
  return Response.json(
    {
      ...(failure.actual ? { actual: failure.actual } : {}),
      error: failure.code,
      ...(failure.limits ? { limits: failure.limits } : {}),
      ...(failure.message ? { message: failure.message } : {})
    },
    { status: failure.status }
  );
}

const PRIVATE_RUN_CACHE_CONTROL = "private, no-store, max-age=0";

function privateModelRunJson(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", PRIVATE_RUN_CACHE_CONTROL);
  return Response.json(data, { ...init, headers });
}

function modelRunErrorJson(data: ModelRunErrorResponse, init?: ResponseInit): Response {
  return privateModelRunJson(data, init);
}

function modelRunJson(data: RunOutcomeResponse, init?: ResponseInit): Response {
  return privateModelRunJson(data, init);
}

function recoveryDeps(
  deps: Pick<
    RunHandlerDeps,
    | "getAttachmentLimits"
    | "knowledgeAdmission"
    | "knowledgeExecutor"
    | "knowledgeProviderDispatch"
    | "memoryEgress"
    | "mcp"
    | "providerAdmission"
    | "providerRuntime"
    | "providers"
    | "repository"
    | "searchProviders"
    | "storage"
  >
) {
  return {
    ...(deps.getAttachmentLimits ? { getAttachmentLimits: deps.getAttachmentLimits } : {}),
    ...(deps.knowledgeAdmission ? { knowledgeAdmission: deps.knowledgeAdmission } : {}),
    ...(deps.knowledgeExecutor ? { knowledgeExecutor: deps.knowledgeExecutor } : {}),
    ...(deps.knowledgeProviderDispatch
      ? { knowledgeProviderDispatch: deps.knowledgeProviderDispatch }
      : {}),
    ...(deps.memoryEgress ? { memoryEgress: deps.memoryEgress } : {}),
    ...(deps.mcp ? { mcp: deps.mcp } : {}),
    ...(deps.providerAdmission ? { providerAdmission: deps.providerAdmission } : {}),
    ...(deps.providerRuntime ? { providerRuntime: deps.providerRuntime } : {}),
    providers: deps.providers,
    registry: activeRunControllerRegistry,
    repository: deps.repository,
    ...(deps.searchProviders ? { searchProviders: deps.searchProviders } : {}),
    ...(deps.storage ? { storage: deps.storage } : {})
  };
}

function isActiveRunConflictError(error: unknown): error is ActiveRunConflictError {
  return error instanceof ActiveRunConflictError || (error instanceof Error && error.name === "ActiveRunConflictError");
}

function isActiveLeafConflictError(error: unknown): error is ActiveLeafConflictError {
  return error instanceof ActiveLeafConflictError || (error instanceof Error && error.name === "ActiveLeafConflictError");
}

function isAttachmentLinkConflictError(error: unknown): error is AttachmentLinkConflictError {
  return error instanceof AttachmentLinkConflictError || (error instanceof Error && error.name === "AttachmentLinkConflictError");
}

function isMcpRunPlanConflictError(error: unknown): error is McpRunPlanConflictError {
  return error instanceof McpRunPlanConflictError ||
    (error instanceof Error && error.name === "McpRunPlanConflictError");
}

function isKnowledgeRunPlanConflictError(
  error: unknown
): error is KnowledgeRunPlanConflictError {
  return error instanceof KnowledgeRunPlanConflictError ||
    (error instanceof Error && error.name === "KnowledgeRunPlanConflictError");
}

function isProviderAdmissionConflictError(
  error: unknown
): error is ProviderAdmissionConflictError {
  return error instanceof ProviderAdmissionConflictError ||
    (error instanceof Error && error.name === "ProviderAdmissionConflictError");
}

function isAssistantRunConflictError(error: unknown): error is AssistantRunConflictError {
  return error instanceof AssistantRunConflictError ||
    (error instanceof Error && error.name === "AssistantRunConflictError");
}

function isSkillRunConflictError(error: unknown): error is SkillRunConflictError {
  return error instanceof SkillRunConflictError ||
    (error instanceof Error && error.name === "SkillRunConflictError");
}

function isMemoryPreparingRunConflictError(
  error: unknown
): error is MemoryPreparingRunConflictError {
  return error instanceof MemoryPreparingRunConflictError ||
    (error instanceof Error && error.name === "MemoryPreparingRunConflictError");
}

function createPreparingMemoryMaterializer(
  prepared: ReturnType<typeof materializePreparedRunData>,
  adapter: ProviderAdapter,
  bridge: ProviderToolBridge | undefined
): PreparingRunMemoryMaterializer {
  return (personalContext, memoryActionAnswerResult) => {
    const normalizedRequest: NormalizedRunRequest = {
      ...prepared.normalizedRequest,
      ...(personalContext ? { personalContext } : {}),
      prompt: {
        ...prepared.normalizedRequest.prompt,
        ...(memoryActionAnswerResult ? { memoryActionAnswerResult } : {})
      }
    };
    const request: ProviderRunRequest = {
      ...prepared.providerRequest,
      ...normalizedRequest,
      ...(personalContext ? { personalContext } : {})
    };
    const budgeted = applyProviderRequestContextBudget({
      ...(bridge ? { bridge } : {}),
      request
    });
    if (!budgeted.ok || !budgeted.request.context) return null;
    const finalNormalizedRequest: NormalizedRunRequest = {
      ...normalizedRequest,
      context: budgeted.request.context
    };
    const providerRequest: ProviderRunRequest = {
      ...budgeted.request,
      ...finalNormalizedRequest,
      attachments: budgeted.request.attachments
    };
    return {
      contextTruncation: budgeted.contextTruncation ?? prepared.contextTruncation,
      normalizedRequest: finalNormalizedRequest,
      providerRequest,
      providerRequestPreview: adapter.buildRequestPreview(providerRequest)
    };
  };
}

function applyPreparingMaterialization(
  prepared: ReturnType<typeof materializePreparedRunData>,
  created: CreatedRun
): ReturnType<typeof materializePreparedRunData> {
  return created.materializedRequest
    ? {
        ...prepared,
        contextTruncation: created.materializedRequest.contextTruncation,
        normalizedRequest: created.materializedRequest.normalizedRequest,
        providerRequest: created.materializedRequest.providerRequest,
        providerRequestPreview: { ...created.materializedRequest.providerRequestPreview }
      }
    : prepared;
}

async function acceptedRuntimeBinding(
  deps: RunHandlerDeps,
  runId: string,
  searchOptionIds: readonly string[] = []
): Promise<{
  adapter: ProviderAdapter;
  searchRuntimes: Record<string, ProviderRuntimeBinding>;
  toolBridge?: ProviderToolBridge;
} | null> {
  if (!deps.providerRuntime) {
    throw new Error("provider_runtime_not_configured");
  }

  const answer = await deps.providerRuntime.resolve(runId, "answer");
  const searchRuntimes: Record<string, ProviderRuntimeBinding> = {};
  for (const optionId of searchOptionIds) {
    try {
      const runtime = await deps.providerRuntime.resolve(runId, "search", `search:${optionId}`);
      searchRuntimes[optionId] = runtime;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "provider_run_binding_not_found") {
        throw error;
      }
    }
  }

  return {
    adapter: answer.adapter,
    searchRuntimes,
    ...(answer.toolBridge ? { toolBridge: answer.toolBridge } : {})
  };
}

function expectedActiveLeafFromBody(
  body: Readonly<Record<string, unknown>> | null,
  fallback: string | null
): { ok: true; value: string | null } | { ok: false } {
  if (!body || !("expectedActiveLeafId" in body)) {
    return { ok: true, value: fallback };
  }

  if (body.expectedActiveLeafId === null) {
    return { ok: true, value: null };
  }

  return typeof body.expectedActiveLeafId === "string" && body.expectedActiveLeafId.trim()
    ? { ok: true, value: body.expectedActiveLeafId.trim() }
    : { ok: false };
}

async function activeRunConflictResponse(
  chatId: string,
  repository: RunRepository,
  userId: string,
  options: { includeStale?: boolean } = {}
): Promise<Response | null> {
  const since = options.includeStale ? new Date(0) : new Date(Date.now() - activeRunGateWindowMs);
  const activeRun = await repository.findRecentActiveRunForChat({ chatId, since, userId });

  if (!activeRun) {
    return null;
  }

  return Response.json(
    {
      error: "active_run_in_progress",
      run: {
        id: activeRun.id,
        status: activeRun.status === "preparing" ? "streaming" : activeRun.status
      }
    },
    { status: 409 }
  );
}

async function activeRunInsertConflictResponse(
  chatId: string,
  repository: RunRepository,
  userId: string
): Promise<Response> {
  return (
    (await activeRunConflictResponse(chatId, repository, userId, { includeStale: true })) ??
    Response.json({ error: "active_run_in_progress" }, { status: 409 })
  );
}

export function createSendMessageHandler(deps: RunHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ chatId: string }> | { chatId: string } }
  ): Promise<Response> {
    const config = deps.getConfig?.() ?? getAuthConfig();

    if (!config.configured) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const [body, bodyError] = await readJson(request);
    if (bodyError) {
      return bodyError;
    }

    const recovery = recoveryDeps(deps);
    await sweepBootOrphanedRunsOnce(recovery);
    await reconcileStaleRuns(recovery, {
      userId: auth.userId
    });

    const params = await context.params;
    let chat = await deps.repository.findOwnedChat(params.chatId, auth.userId);
    let projectChat: Readonly<{ folderId: string | null }> | null = null;
    const projectDraft = projectDraftFromBody(body);
    if (projectDraft === "invalid" ||
      (projectDraft && !chat && !uuidPattern.test(params.chatId))) {
      return Response.json({ error: "project_draft_invalid" }, { status: 400 });
    }
    if (!chat && projectDraft) {
      if (!deps.repository.loadProjectFirstSend || body?.expectedActiveLeafId !== null) {
        return Response.json({ error: "project_draft_invalid" }, { status: 400 });
      }
      chat = await deps.repository.loadProjectFirstSend({
        chatId: params.chatId,
        folderId: projectDraft.folderId,
        projectId: projectDraft.projectId,
        userId: auth.userId
      });
      if (chat) projectChat = { folderId: projectDraft.folderId };
    }
    if (!chat) {
      return Response.json({ error: projectDraft ? "project_not_found" : "chat_not_found" }, { status: 404 });
    }
    if (chat && projectDraft && !projectChat) {
      return Response.json({ error: "project_draft_conflict" }, { status: 409 });
    }

    const activeRunResponse = await activeRunConflictResponse(chat.id, deps.repository, auth.userId);
    if (activeRunResponse) {
      return activeRunResponse;
    }

    const expectedActiveLeaf = expectedActiveLeafFromBody(body, chat.activeLeafMessageId);
    if (!expectedActiveLeaf.ok) {
      return Response.json({ error: "expected_active_leaf_invalid" }, { status: 400 });
    }
    const preparation = await prepareRun(deps, {
      body,
      signal: request.signal,
      source: {
        chat: {
          ...chat,
          activeLeafMessageId: expectedActiveLeaf.value
        },
        ...(projectChat ? { draftProjectChat: true } : {}),
        kind: "send"
      },
      userId: auth.userId
    });
    if (!preparation.ok) {
      return runPreparationFailureResponse(preparation);
    }

    let preparedData = materializePreparedRunData(preparation.prepared);
    let created: CreatedRun;
    try {
      created = await deps.repository.createRun({
        ...(preparedData.assistant ? { assistant: preparedData.assistant } : {}),
        chatId: preparedData.normalizedRequest.chatId,
        content: preparedData.normalizedRequest.content,
        ...(preparedData.defaults
          ? {
              defaults: {
                ...preparedData.defaults,
                controlDefaults: { ...preparedData.defaults.controlDefaults }
              }
            }
          : {}),
        expectedActiveLeafId: preparedData.expectedActiveLeafId,
        ...(preparedData.initialChatMode
          ? { initialChatMode: preparedData.initialChatMode }
          : {}),
        ...(preparedData.knowledgeAdmissionPlan
          ? { knowledgeAdmissionPlan: preparedData.knowledgeAdmissionPlan }
          : {}),
        ...(preparedData.mcpBindings ? { mcpBindings: preparedData.mcpBindings } : {}),
        ...(preparedData.skillBindings ? { skillBindings: preparedData.skillBindings } : {}),
        providerAdmissionPlan: preparedData.providerAdmissionPlan,
        ...(preparedData.project ? { project: preparedData.project } : {}),
        modelId: preparedData.normalizedRequest.modelId,
        memoryMaterializer: createPreparingMemoryMaterializer(
          preparedData,
          preparation.adapter,
          preparation.toolBridge
        ),
        normalizedRequest: preparedData.normalizedRequest,
        provider: preparedData.normalizedRequest.provider,
        providerRequestPreview: preparedData.providerRequestPreview,
        ...(projectChat ? { projectChat } : {}),
        signal: request.signal,
        userId: auth.userId
      });
    } catch (error) {
      if (isActiveRunConflictError(error)) {
        return activeRunInsertConflictResponse(chat.id, deps.repository, auth.userId);
      }

      if (isActiveLeafConflictError(error)) {
        return Response.json({ error: "active_leaf_changed" }, { status: 409 });
      }

      if (isAttachmentLinkConflictError(error)) {
        return Response.json({ error: "attachment_not_available" }, { status: 409 });
      }

      if (isMcpRunPlanConflictError(error)) {
        return Response.json({ error: "mcp_not_ready" }, { status: 409 });
      }

      if (isKnowledgeRunPlanConflictError(error)) {
        return Response.json({ error: "knowledge_base_not_available" }, { status: 409 });
      }

      if (isProviderAdmissionConflictError(error)) {
        return Response.json({ error: "provider_admission_changed" }, { status: 409 });
      }

      if (isAssistantRunConflictError(error)) {
        return Response.json({ error: "assistant_not_available" }, { status: 409 });
      }

      if (isSkillRunConflictError(error)) {
        return Response.json({ error: "skill_not_available" }, { status: 409 });
      }

      if (isMemoryPreparingRunConflictError(error)) {
        return Response.json({
          error: error instanceof MemoryPreparingRunConflictError
            ? error.code
            : "memory_preparing_run_conflict"
        }, { status: 409 });
      }

      throw error;
    }
    preparedData = applyPreparingMaterialization(preparedData, created);
    const runtime = await acceptedRuntimeBinding(
      deps,
      created.runId,
      preparedData.normalizedRequest.searchPlan.options.map((option) => option.optionId)
    );
    return createRunExecutionResponse({
      adapter: runtime?.adapter ?? preparation.adapter,
      created,
      prepared: preparedData,
      repository: deps.repository,
      ...(deps.knowledgeAdmission ? { knowledgeAdmission: deps.knowledgeAdmission } : {}),
      ...(deps.knowledgeExecutor ? { knowledgeExecutor: deps.knowledgeExecutor } : {}),
      ...(deps.knowledgeProviderDispatch
        ? { knowledgeProviderDispatch: deps.knowledgeProviderDispatch }
        : {}),
      ...(deps.memoryEgress ? { memoryEgress: deps.memoryEgress } : {}),
      ...(deps.mcp ? { mcp: deps.mcp } : {}),
      ...(deps.providerAdmission ? { providerAdmission: deps.providerAdmission } : {}),
      ...(runtime?.searchRuntimes ? { searchRuntimes: runtime.searchRuntimes } : {}),
      toolBridge: runtime?.toolBridge ?? preparation.toolBridge,
      userId: auth.userId
    });
  };
}

export function createRegenerateModelRunHandler(deps: RunHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ messageId: string }> | { messageId: string } }
  ): Promise<Response> {
    const config = deps.getConfig?.() ?? getAuthConfig();

    if (!config.configured) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const [body, bodyError] = await readJson(request);
    if (bodyError) {
      return bodyError;
    }

    const recovery = recoveryDeps(deps);
    await sweepBootOrphanedRunsOnce(recovery);
    await reconcileStaleRuns(recovery, {
      userId: auth.userId
    });

    const params = await context.params;
    const source = await deps.repository.findRegenerationSource(params.messageId, auth.userId);
    if (!source) {
      return Response.json({ error: "message_not_found_or_not_regeneratable" }, { status: 404 });
    }

    const activeRunResponse = await activeRunConflictResponse(source.chat.id, deps.repository, auth.userId);
    if (activeRunResponse) {
      return activeRunResponse;
    }

    const preparation = await prepareRun(deps, {
      body,
      signal: request.signal,
      source: {
        kind: "regenerate",
        source
      },
      userId: auth.userId
    });
    if (!preparation.ok) {
      return runPreparationFailureResponse(preparation);
    }

    let preparedData = materializePreparedRunData(preparation.prepared);
    let created: CreatedRun;
    try {
      created = await deps.repository.createRegenerationRun({
        ...(preparedData.assistant ? { assistant: preparedData.assistant } : {}),
        chatId: preparedData.normalizedRequest.chatId,
        ...(preparedData.defaults
          ? {
              defaults: {
                ...preparedData.defaults,
                controlDefaults: { ...preparedData.defaults.controlDefaults }
              }
            }
          : {}),
        ...(preparedData.knowledgeAdmissionPlan
          ? { knowledgeAdmissionPlan: preparedData.knowledgeAdmissionPlan }
          : {}),
        ...(preparedData.mcpBindings ? { mcpBindings: preparedData.mcpBindings } : {}),
        ...(preparedData.skillBindings ? { skillBindings: preparedData.skillBindings } : {}),
        providerAdmissionPlan: preparedData.providerAdmissionPlan,
        ...(preparedData.project ? { project: preparedData.project } : {}),
        modelId: preparedData.normalizedRequest.modelId,
        memoryMaterializer: createPreparingMemoryMaterializer(
          preparedData,
          preparation.adapter,
          preparation.toolBridge
        ),
        normalizedRequest: preparedData.normalizedRequest,
        preSendAssistantMessageId: source.assistantMessage?.id ?? null,
        provider: preparedData.normalizedRequest.provider,
        providerRequestPreview: preparedData.providerRequestPreview,
        signal: request.signal,
        userId: auth.userId,
        userMessageId: source.userMessage.id
      });
    } catch (error) {
      if (isActiveRunConflictError(error)) {
        return activeRunInsertConflictResponse(source.chat.id, deps.repository, auth.userId);
      }

      if (isActiveLeafConflictError(error)) {
        return Response.json({ error: "active_leaf_changed" }, { status: 409 });
      }

      if (isMcpRunPlanConflictError(error)) {
        return Response.json({ error: "mcp_not_ready" }, { status: 409 });
      }

      if (isKnowledgeRunPlanConflictError(error)) {
        return Response.json({ error: "knowledge_base_not_available" }, { status: 409 });
      }

      if (isProviderAdmissionConflictError(error)) {
        return Response.json({ error: "provider_admission_changed" }, { status: 409 });
      }

      if (isAssistantRunConflictError(error)) {
        return Response.json({ error: "assistant_not_available" }, { status: 409 });
      }

      if (isSkillRunConflictError(error)) {
        return Response.json({ error: "skill_not_available" }, { status: 409 });
      }

      if (isMemoryPreparingRunConflictError(error)) {
        return Response.json({
          error: error instanceof MemoryPreparingRunConflictError
            ? error.code
            : "memory_preparing_run_conflict"
        }, { status: 409 });
      }

      throw error;
    }
    preparedData = applyPreparingMaterialization(preparedData, created);
    const runtime = await acceptedRuntimeBinding(
      deps,
      created.runId,
      preparedData.normalizedRequest.searchPlan.options.map((option) => option.optionId)
    );
    return createRunExecutionResponse({
      adapter: runtime?.adapter ?? preparation.adapter,
      created,
      prepared: preparedData,
      repository: deps.repository,
      ...(deps.knowledgeAdmission ? { knowledgeAdmission: deps.knowledgeAdmission } : {}),
      ...(deps.knowledgeExecutor ? { knowledgeExecutor: deps.knowledgeExecutor } : {}),
      ...(deps.knowledgeProviderDispatch
        ? { knowledgeProviderDispatch: deps.knowledgeProviderDispatch }
        : {}),
      ...(deps.memoryEgress ? { memoryEgress: deps.memoryEgress } : {}),
      ...(deps.mcp ? { mcp: deps.mcp } : {}),
      ...(deps.providerAdmission ? { providerAdmission: deps.providerAdmission } : {}),
      ...(runtime?.searchRuntimes ? { searchRuntimes: runtime.searchRuntimes } : {}),
      toolBridge: runtime?.toolBridge ?? preparation.toolBridge,
      userId: auth.userId
    });
  };
}

export function createGetModelRunHandler(
  deps: Pick<
    RunHandlerDeps,
    | "getConfig"
    | "getAttachmentLimits"
    | "knowledgeAdmission"
    | "knowledgeExecutor"
    | "knowledgeProviderDispatch"
    | "memoryEgress"
    | "mcp"
    | "providerAdmission"
    | "providerRuntime"
    | "providers"
    | "repository"
    | "resolveAuth"
    | "searchProviders"
    | "storage"
  >
) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ runId: string }> | { runId: string } }
  ): Promise<Response> {
    const config = deps.getConfig?.() ?? getAuthConfig();
    if (!config.configured) {
      return modelRunErrorJson({ error: "unauthorized" }, { status: 401 });
    }

    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return modelRunErrorJson({ error: "unauthorized" }, { status: 401 });
    }

    const params = await context.params;
    // The installation scheduler is the primary recovery owner. A GET may assist
    // only through the same guarded stale-run boundary; eagerly recovering a fresh
    // run can create a second owner when route runtimes do not share process state.
    if (deps.providerRuntime || deps.searchProviders || deps.knowledgeExecutor) {
      const recovery = recoveryDeps(deps);
      await reconcileStaleRuns(recovery, {
        runId: params.runId,
        userId: auth.userId
      }).catch(() => undefined);
    }
    const run = await deps.repository.getRunOutcomeForUser(params.runId, auth.userId);

    if (!run) {
      return modelRunErrorJson({ error: "model_run_not_found" }, { status: 404 });
    }

    return modelRunJson(serializeRunOutcome(run));
  };
}

export function createCancelModelRunHandler(deps: RunHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ runId: string }> | { runId: string } }
  ): Promise<Response> {
    const config = deps.getConfig?.() ?? getAuthConfig();
    if (!config.configured) {
      return privateModelRunJson({ error: "unauthorized" }, { status: 401 });
    }

    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return privateModelRunJson({ error: "unauthorized" }, { status: 401 });
    }

    const params = await context.params;
    const cancellation = await deps.repository.cancelRun({
      payload: {
        code: "model_run_cancelled",
        message: "Model run cancelled"
      },
      runId: params.runId,
      userId: auth.userId
    });

    if (cancellation.kind === "not_found") {
      return privateModelRunJson({ error: "model_run_not_found" }, { status: 404 });
    }

    if (cancellation.kind === "current") {
      return privateModelRunJson(
        {
          error: "model_run_not_cancelable",
          run: {
            id: cancellation.run.id,
            status: cancellation.run.status
          }
        } satisfies CancelModelRunNotCancelableResponse,
        { status: 409 }
      );
    }

    const run = cancellation.run;
    activeRunControllerRegistry.abort(run.id);

    if (run.providerResponseId) {
      try {
        const adapter = deps.providerRuntime
          ? (await deps.providerRuntime.resolve(run.id, "answer")).adapter
          : deps.providers[run.provider];
        if (adapter?.cancel) {
          await adapter.cancel(run.providerResponseId);
        }
      } catch {
        // Durable local cancellation already won; provider cancellation is best effort.
      }
    }

    return privateModelRunJson({
      run: {
        id: run.id,
        status: "cancelled"
      }
    } satisfies CancelModelRunSuccessResponse);
  };
}
