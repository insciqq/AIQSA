import { getAuthConfig, type AuthConfig } from "../auth/config";
import type {
  CancelModelRunNotCancelableResponse,
  CancelModelRunSuccessResponse,
  GetModelRunResponse,
  ModelRunErrorResponse
} from "../../contracts/runs";
import type { RequestAuthResolver } from "../auth/requestAuth";
import type { ProviderAdapter, ProviderSearchAdapter } from "../providers/types";
import type { StorageAdapter } from "../uploads/storage";
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
  refreshProviderRunIfNeeded,
  sweepBootOrphanedRunsOnce
} from "./runRecovery";
import {
  ActiveLeafConflictError,
  ActiveRunConflictError,
  AttachmentLinkConflictError,
  McpRunPlanConflictError
} from "./runRepositoryContract";
import type { RunRepository } from "./runRepositoryContract";

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
  getConfig?: () => AuthConfig;
  mcp?: RunPreparationDeps["mcp"];
  providers: Record<string, ProviderAdapter>;
  repository: RunRepository;
  resolveAuth: RequestAuthResolver;
  searchProviders?: Record<string, ProviderSearchAdapter>;
  storage?: StorageAdapter;
};

const activeRunGateWindowMs = activeRunStaleMs;

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function runPreparationFailureResponse(failure: RunPreparationFailure): Response {
  return Response.json(
    {
      error: failure.code,
      ...(failure.message ? { message: failure.message } : {})
    },
    { status: failure.status }
  );
}

function modelRunErrorJson(data: ModelRunErrorResponse, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function modelRunJson(data: GetModelRunResponse, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function recoveryDeps(
  deps: Pick<RunHandlerDeps, "providers" | "repository" | "searchProviders" | "storage">
) {
  return {
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
        status: activeRun.status
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

    const recovery = recoveryDeps(deps);
    await sweepBootOrphanedRunsOnce(recovery);
    await reconcileStaleRuns(recovery, {
      userId: auth.userId
    });

    const params = await context.params;
    const chat = await deps.repository.findOwnedChat(params.chatId, auth.userId);
    if (!chat) {
      return Response.json({ error: "chat_not_found" }, { status: 404 });
    }

    const activeRunResponse = await activeRunConflictResponse(chat.id, deps.repository, auth.userId);
    if (activeRunResponse) {
      return activeRunResponse;
    }

    const body = await readJson(request);
    const expectedActiveLeaf = expectedActiveLeafFromBody(body, chat.activeLeafMessageId);
    if (!expectedActiveLeaf.ok) {
      return Response.json({ error: "expected_active_leaf_invalid" }, { status: 400 });
    }
    const preparation = await prepareRun(deps, {
      body,
      source: {
        chat: {
          ...chat,
          activeLeafMessageId: expectedActiveLeaf.value
        },
        kind: "send"
      },
      userId: auth.userId
    });
    if (!preparation.ok) {
      return runPreparationFailureResponse(preparation);
    }

    const preparedData = materializePreparedRunData(preparation.prepared);
    let created: {
      assistantMessageId: string;
      runId: string;
      userMessageId: string;
    };
    try {
      created = await deps.repository.createRun({
        chatId: preparedData.normalizedRequest.chatId,
        content: preparedData.normalizedRequest.content,
        defaults: {
          ...preparedData.defaults,
          controlDefaults: { ...preparedData.defaults.controlDefaults }
        },
        expectedActiveLeafId: preparedData.expectedActiveLeafId,
        ...(preparedData.mcpBindings ? { mcpBindings: preparedData.mcpBindings } : {}),
        modelId: preparedData.normalizedRequest.modelId,
        normalizedRequest: preparedData.normalizedRequest,
        provider: preparedData.normalizedRequest.provider,
        providerRequestPreview: preparedData.providerRequestPreview,
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

      throw error;
    }
    return createRunExecutionResponse({
      adapter: preparation.adapter,
      created,
      prepared: preparedData,
      repository: deps.repository,
      searchAdapter: preparation.searchAdapter,
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

    const body = await readJson(request);
    const preparation = await prepareRun(deps, {
      body,
      source: {
        kind: "regenerate",
        source
      },
      userId: auth.userId
    });
    if (!preparation.ok) {
      return runPreparationFailureResponse(preparation);
    }

    const preparedData = materializePreparedRunData(preparation.prepared);
    let created: {
      assistantMessageId: string;
      runId: string;
      userMessageId: string;
    };
    try {
      created = await deps.repository.createRegenerationRun({
        chatId: preparedData.normalizedRequest.chatId,
        defaults: {
          ...preparedData.defaults,
          controlDefaults: { ...preparedData.defaults.controlDefaults }
        },
        ...(preparedData.mcpBindings ? { mcpBindings: preparedData.mcpBindings } : {}),
        modelId: preparedData.normalizedRequest.modelId,
        normalizedRequest: preparedData.normalizedRequest,
        provider: preparedData.normalizedRequest.provider,
        providerRequestPreview: preparedData.providerRequestPreview,
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

      throw error;
    }
    return createRunExecutionResponse({
      adapter: preparation.adapter,
      created,
      prepared: preparedData,
      repository: deps.repository,
      searchAdapter: preparation.searchAdapter,
      userId: auth.userId
    });
  };
}

export function createGetModelRunHandler(
  deps: Pick<
    RunHandlerDeps,
    "getConfig" | "providers" | "repository" | "resolveAuth" | "searchProviders" | "storage"
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
    // The installation scheduler is the primary recovery owner. A GET may provide
    // a low-latency assist only when it has the complete provider-neutral adapter
    // set; otherwise it must remain a read and leave the checkpoint untouched.
    if (deps.searchProviders) {
      const recovery = recoveryDeps(deps);
      await refreshProviderRunIfNeeded(recovery, params.runId, auth.userId).catch(() => undefined);
      await reconcileStaleRuns(recovery, {
        runId: params.runId,
        userId: auth.userId
      }).catch(() => undefined);
    }
    const run = await deps.repository.getRunForUser(params.runId, auth.userId);

    if (!run) {
      return modelRunErrorJson({ error: "model_run_not_found" }, { status: 404 });
    }

    const response = { run } satisfies GetModelRunResponse;
    return modelRunJson(response);
  };
}

export function createCancelModelRunHandler(deps: RunHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ runId: string }> | { runId: string } }
  ): Promise<Response> {
    const config = deps.getConfig?.() ?? getAuthConfig();
    if (!config.configured) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
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
      return Response.json({ error: "model_run_not_found" }, { status: 404 });
    }

    if (cancellation.kind === "current") {
      return Response.json(
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
    const adapter = deps.providers[run.provider];
    activeRunControllerRegistry.abort(run.id);

    let providerCancelPreview: Record<string, unknown> | undefined;
    if (adapter?.cancel && run.providerResponseId) {
      try {
        await adapter.cancel(run.providerResponseId);
        providerCancelPreview = {
          provider: run.provider,
          status: "provider_cancel_succeeded"
        };
      } catch {
        providerCancelPreview = {
          error: "Provider cancellation failed",
          provider: run.provider,
          status: "provider_cancel_failed"
        };
      }
    }

    const previewPersisted = providerCancelPreview
      ? await deps.repository
          .updateCancelledRunProviderPreview({
            providerCancelPreview,
            runId: run.id,
            userId: auth.userId
          })
          .catch(() => false)
      : false;

    return Response.json({
      run: {
        id: run.id,
        ...(previewPersisted ? { providerCancelPreview } : {}),
        providerResponseId: run.providerResponseId,
        status: "cancelled"
      }
    } satisfies CancelModelRunSuccessResponse);
  };
}
