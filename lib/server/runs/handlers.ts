import { McpToolAccessDeniedError } from "../mcp/toolAccess";
import { SkillCatalogAuthorityChangedError } from "../skills/catalogRelevanceService";
import { InstructionPresetError } from "../instructions/store";
import { decodeArtifactEdit } from "../../contracts/artifacts";
import {
  MCP_APPROVAL_CONTINUATION_KIND,
  MCP_APPROVAL_CONTINUATION_UNAVAILABLE,
  mcpApprovalContinuationText
} from "../../contracts/mcpApprovals";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isChatPdfPolicyUnavailableError, chatPdfFingerprint } from "../uploads/chatPdfAdmission";
import { ChatPdfPreparationError } from "../uploads/chatPdfCore";
import { chatPdfRunSnapshot } from "../uploads/chatPdfRunContinuation";
import { acceptedRunSnapshot } from "./acceptedRunSnapshot";
import { WorkspaceFollowupError } from "./workspaceFollowupPersistence";
import { WorkspaceSecretError } from "../workspace/secrets/validation";
import type { PreparingRunAdmissionResponse } from "../../contracts/runs";
import type { UsageLimitRefusalResponse } from "../../contracts/usageLimits";
import { decideUsageAdmission } from "../../domain/usageLimits";
import type { UsageLimitStatus, UsageLimitsRepository } from "../usageLimits/repository";
import { applyPreparingMaterialization, createPreparingMemoryMaterializer } from "./preparingRunMaterialization";
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
  ProviderAdapter,
  ProviderSearchAdapter
} from "../providers/types";
import type { ProviderToolBridge } from "../tools/types";
import type { StorageAdapter } from "../uploads/storage";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import type { KnowledgeToolExecutor } from "../knowledge/toolExecutor";
import type { KnowledgeProviderDispatchLifecycle } from "../knowledge/providerDispatchLifecycle";
import type { MemoryToolEgressReceiptService } from "../memory/egress/receipts";
import type { ChatTitleGenerator } from "../chats/titleGeneration";
import { activeRunControllerRegistry, createRunExecutionResponse } from "./runExecution";
import {
  materializePreparedRunData,
  preparePdfRetry,
  prepareRun,
  type RunPreparationDeps,
  type MaterializedPreparedRunData,
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
  ScheduledOccurrenceConflictError,
  SkillRunConflictError,
  WorkspaceRunConflictError
} from "./runRepositoryContract";
import type { RunRepository, ScheduledOccurrenceAdmission } from "./runRepositoryContract";
import { serializeRunOutcome } from "./runOutcome";
import { MemoryPreparingRunConflictError } from "./preparingRun";
import { logEvent, runWithContext, type EventFields } from "../observability";
import { logRunPersistence, runDatabaseFailureCode } from "./runObservability";
import { retainRunPrismaCode } from "./prismaRepositoryObservability";
import { observedFailure } from "../providers/providerObservability";
import type {
  CreatedRun
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
  memorySearchAdmission?: RunPreparationDeps["memorySearchAdmission"];
  memorySearch?: import("../memory/search/runtime").MemorySearchService;
  workspaceFollowup?: Readonly<{
    findAdmission(admissionKey: string, userId: string): Promise<PreparingRunAdmissionResponse | null>;
    kick(): void;
  }>;
  vision?: import("../vision/service").VisionAnalysisService;
  observations?: import("../toolObservations/sourceAdapters").ToolObservationService;
  images?: import("../images/service").ImageGenerationService;
  artifacts?: import("../artifacts/service").ArtifactService;
  allowFakeProvider?: boolean;
  assistants?: RunPreparationDeps["assistants"];
  instructions?: RunPreparationDeps["instructions"];
  chatTitleGenerator?: ChatTitleGenerator;
  chatPdf?: NonNullable<RunPreparationDeps["chatPdf"]> & Readonly<{
    findAdmission(admissionKey: string, userId: string): Promise<PreparingRunAdmissionResponse | null>;
    kick(): void;
    loadRetry?(input: Readonly<{ assistantMessageId: string; chatId: string; userId: string; userMessageId: string }>): Promise<Readonly<{
      adapter: ProviderAdapter;
      prepared: MaterializedPreparedRunData;
      toolBridge?: ProviderToolBridge;
    }> | null>;
  }>;
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
  agentPolicy?: RunPreparationDeps["agentPolicy"];
  runPolicy?: RunPreparationDeps["runPolicy"];
  /** Server-only: the scheduled task occurrence a send of this handler admits. */
  scheduledOccurrence?: ScheduledOccurrenceAdmission;
  searchProviders?: Record<string, ProviderSearchAdapter>;
  skills?: RunPreparationDeps["skills"];
  skillCatalogRelevance?: RunPreparationDeps["skillCatalogRelevance"];
  skillTools?: import("../skills/toolService").SkillToolService;
  storage?: StorageAdapter;
  /**
   * The usage limits every new run's admission checks (`usageLimitRefusal`).
   * Required, so no entry point can admit runs without them.
   */
  usageLimits: Pick<UsageLimitsRepository, "loadUsageLimitStatus">;
  workspace?: RunPreparationDeps["workspace"];
  workspaceCoordinator?: WorkspaceCoordinator;
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

function personalDraftFromBody(body: Record<string, unknown> | null):
  | Readonly<{
      folderId: string | null;
      memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
    }>
  | "invalid"
  | null {
  if (!body || body.personalDraft === undefined) return null;
  const value = body.personalDraft;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid";
  const draft = value as Record<string, unknown>;
  const folderId = draft.folderId ?? null;
  const memoryMode = draft.memoryMode;
  if (
    (folderId !== null && !uuidPattern.test(String(folderId))) ||
    !["EXCLUDED", "NORMAL", "TEMPORARY"].includes(String(memoryMode)) ||
    Object.keys(draft).some((key) => key !== "folderId" && key !== "memoryMode")
  ) {
    return "invalid";
  }
  return {
    folderId: folderId === null ? null : String(folderId),
    memoryMode: memoryMode as "EXCLUDED" | "NORMAL" | "TEMPORARY"
  };
}

async function readJson(
  request: Request
): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "artifactIntent") &&
    (value as Record<string, unknown>).artifactIntent !== "create") return [null, Response.json({ error: "artifact_intent_invalid" }, { status: 400 })];
  if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "artifactEdit") &&
    !decodeArtifactEdit((value as Record<string, unknown>).artifactEdit)) {
    return [null, Response.json({ error: "artifact_edit_invalid" }, { status: 400 })];
  }
  return [
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null,
    requestBodyErrorResponse(value)
  ];
}

/**
 * A continuation turn after an MCP approval (`systemTurn`). The turn's text
 * is the server's, written from the user's own Allow in this chat; the body's
 * text and attachments are ignored. Null for an ordinary send.
 */
async function approvalContinuationBody(
  deps: RunHandlerDeps,
  body: Record<string, unknown> | null,
  chatId: string,
  userId: string
): Promise<Record<string, unknown> | "invalid" | "unavailable" | null> {
  if (!body || !Object.hasOwn(body, "systemTurn")) return null;
  const turn = body.systemTurn;
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return "invalid";
  const { approvalId, kind } = turn as Record<string, unknown>;
  if (Object.keys(turn).sort().join(",") !== "approvalId,kind" || kind !== MCP_APPROVAL_CONTINUATION_KIND ||
    typeof approvalId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(approvalId)) return "invalid";
  const approval = await deps.repository.loadMcpApprovalContinuation?.({ approvalId, chatId, userId }) ?? null;
  if (!approval) return "unavailable";
  const {
    artifactEdit: _artifactEdit,
    artifactIntent: _artifactIntent,
    attachmentIds: _attachmentIds,
    content: _content,
    systemTurn: _systemTurn,
    text: _text,
    ...rest
  } = body;
  return { ...rest, content: { blocks: [{ type: "text", text: mcpApprovalContinuationText(approval) }] } };
}

function runPreparationFailureResponse(failure: RunPreparationFailure): Response {
  return Response.json(
    {
      ...(failure.actual ? { actual: failure.actual } : {}),
      error: failure.code,
      ...(failure.limits ? { limits: failure.limits } : {}),
      ...(failure.skillBudget ?? {}),
      ...(failure.skillValidation ? {
        field: failure.skillValidation.field, actual: failure.skillValidation.actual, limit: failure.skillValidation.limit
      } : {}),
      ...(failure.message ? { message: failure.message } : {})
    },
    { status: failure.status }
  );
}

const PRIVATE_RUN_CACHE_CONTROL = "private, no-store, max-age=0";
const STOP_REJECTION_WINDOW_MS = 30_000;
const STOP_REJECTION_STATE = Symbol.for("aiqsa.run-stop-rejections.v1");
type StopRejection = "unauthorized" | "not_found";
const globalForStopRejections = globalThis as typeof globalThis & {
  [STOP_REJECTION_STATE]?: Partial<Record<StopRejection, number>>;
};

function logStopAdmission(fields: EventFields["run_stop_admission"]): void {
  if (fields.outcome === "unauthorized" || fields.outcome === "not_found") {
    // Two fixed process-wide slots survive route-bundle reloads. Neither keys
    // nor values retain unverified request identifiers or caller metadata.
    const recent = globalForStopRejections[STOP_REJECTION_STATE] ??= {};
    const now = performance.now();
    const previous = recent[fields.outcome];
    if (previous !== undefined && now - previous < STOP_REJECTION_WINDOW_MS) return;
    recent[fields.outcome] = now;
  }
  // Keep the pair together so suppressing a rejected admission cannot leave
  // one requested event per rejected request. Accepted work is never deduped.
  logEvent("run_stop_requested", {});
  logEvent("run_stop_admission", fields);
}

function privateModelRunJson(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", PRIVATE_RUN_CACHE_CONTROL);
  return Response.json(data, { ...init, headers });
}

function protectRunHandler<Context>(stage: "send" | "regenerate" | "cancel",
  handler: (request: Request, context: Context) => Promise<Response>) {
  return async function POST(request: Request, context: Context): Promise<Response> {
    try {
      return await handler(request, context);
    } catch (error) {
      const failure = observedFailure(error);
      logEvent("run_http_failed", { error, stage, code: failure.code, reason: failure.reason,
        prisma_code: runDatabaseFailureCode(error) });
      return privateModelRunJson({ error: "internal_error" }, { status: 500 });
    }
  };
}

function modelRunErrorJson(data: ModelRunErrorResponse, init?: ResponseInit): Response {
  return privateModelRunJson(data, init);
}

/**
 * The usage-limit guard of a new run, checked once per admission after the
 * request, its chat and the active-run gate are authorized and before any
 * preparation; continuations of an accepted run never pass here. Budgets apply
 * to every run, message limits only to interactive ones. Returns the refusal
 * (429 with the facts and `retry-after`), or null to admit; a status that
 * cannot be read refuses as unavailable, never admits.
 */
async function usageLimitRefusal(
  deps: Pick<RunHandlerDeps, "usageLimits">,
  input: Readonly<{ interactive: boolean; stage: "send" | "regenerate"; userId: string }>
): Promise<Response | null> {
  const now = new Date();
  let status: UsageLimitStatus;
  try {
    status = await deps.usageLimits.loadUsageLimitStatus(input.userId, now).catch(retainRunPrismaCode);
  } catch (error) {
    logEvent("run_http_failed", { stage: input.stage, code: "usage_limits_unavailable",
      prisma_code: runDatabaseFailureCode(error) });
    return privateModelRunJson({ error: "usage_limits_unavailable" }, { status: 503 });
  }
  const decision = decideUsageAdmission({ ...status, interactive: input.interactive, now });
  if (decision.ok) return null;
  const body: UsageLimitRefusalResponse = { error: decision.code, usageLimit: decision.facts };
  return privateModelRunJson(body, { headers: { "retry-after": String(decision.retryAfterSeconds) }, status: 429 });
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
    | "artifacts"
    | "skillTools"
    | "observations"
    | "vision"
    | "images"
    | "memoryEgress"
    | "memorySearch"
    | "mcp"
    | "providerAdmission"
    | "providerRuntime"
    | "providers"
    | "repository"
    | "searchProviders"
    | "storage"
    | "workspaceCoordinator"
  >
) {
  return {
    ...(deps.getAttachmentLimits ? { getAttachmentLimits: deps.getAttachmentLimits } : {}),
    ...(deps.knowledgeAdmission ? { knowledgeAdmission: deps.knowledgeAdmission } : {}),
    ...(deps.knowledgeExecutor ? { knowledgeExecutor: deps.knowledgeExecutor } : {}),
    ...(deps.knowledgeProviderDispatch
      ? { knowledgeProviderDispatch: deps.knowledgeProviderDispatch }
      : {}),
    ...(deps.images ? { images: deps.images } : {}),
    ...(deps.vision ? { vision: deps.vision } : {}),
    ...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
    ...(deps.skillTools ? { skillTools: deps.skillTools } : {}),
    ...(deps.observations ? { observations: deps.observations } : {}),
    ...(deps.memoryEgress ? { memoryEgress: deps.memoryEgress } : {}),
    ...(deps.memorySearch ? { memorySearch: deps.memorySearch } : {}),
    ...(deps.mcp ? { mcp: deps.mcp } : {}),
    ...(deps.providerAdmission ? { providerAdmission: deps.providerAdmission } : {}),
    ...(deps.providerRuntime ? { providerRuntime: deps.providerRuntime } : {}),
    providers: deps.providers,
    registry: activeRunControllerRegistry,
    repository: deps.repository,
    ...(deps.searchProviders ? { searchProviders: deps.searchProviders } : {}),
    ...(deps.storage ? { storage: deps.storage } : {}),
    ...(deps.workspaceCoordinator ? { workspace: deps.workspaceCoordinator } : {})
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

function isWorkspaceRunConflictError(error: unknown): error is WorkspaceRunConflictError {
  return error instanceof WorkspaceRunConflictError ||
    (error instanceof Error && error.name === "WorkspaceRunConflictError");
}

function isScheduledOccurrenceConflictError(error: unknown): error is ScheduledOccurrenceConflictError {
  return error instanceof ScheduledOccurrenceConflictError ||
    (error instanceof Error && error.name === "ScheduledOccurrenceConflictError");
}

/**
 * The stable code of a Workspace secret failure during admission: the saved
 * secrets exceed a limit, or they could not be read or locked. Null for any
 * other error.
 */
function workspaceSecretAdmissionCode(error: unknown): "workspace_secret_limit" | "workspace_secret_unavailable" | null {
  if (!(error instanceof WorkspaceSecretError || (error instanceof Error && error.name === "WorkspaceSecretError"))) return null;
  return (error as WorkspaceSecretError).code === "workspace_secret_limit" ? "workspace_secret_limit" : "workspace_secret_unavailable";
}

async function acceptedRuntimeBinding(
  deps: RunHandlerDeps,
  runId: string,
  searchOptionIds: readonly string[] = []
): Promise<{
  adapter: ProviderAdapter;
  agentResponses?: ProviderRuntimeBinding["agentResponses"];
  searchRuntimes: Record<string, ProviderRuntimeBinding>;
  structuredOutputAdapter?: ProviderRuntimeBinding["structuredOutputAdapter"];
  toolBridge?: ProviderToolBridge;
} | null> {
  return runWithContext({ run_id: runId }, async () => {
    try {
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
        ...(answer.agentResponses ? { agentResponses: answer.agentResponses } : {}),
        searchRuntimes,
        ...(answer.structuredOutputAdapter
          ? { structuredOutputAdapter: answer.structuredOutputAdapter }
          : {}),
        ...(answer.toolBridge ? { toolBridge: answer.toolBridge } : {})
      };
    } catch (error) {
      const failure = observedFailure(error);
      logEvent("run_execution", { error, run_id: runId, stage: "dispatch", outcome: "failed",
        code: failure.code, reason: failure.reason });
      throw error;
    }
  });
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

function pdfAdmissionKey(kind: "send" | "regenerate", sourceId: string, userId: string, body: Record<string, unknown> | null) {
  // Current composers send an invocation identity; explicit expected-leaf
  // clients also retain duplicate Send semantics across a lost response.
  return chatPdfFingerprint({ body, kind, sourceId, userId,
    nonce: body?.admissionId ?? (kind === "send" && body && "expectedActiveLeafId" in body ? null : randomUUID()) });
}

function deferredPdfInput(prepared: ReturnType<typeof materializePreparedRunData>, admissionKey: string, sourceMessageId?: string) {
  return prepared.chatPdfAdmissions?.length ? {
    chatPdfAdmissions: prepared.chatPdfAdmissions,
    ...(prepared.chatPdfAdmissions.some(({ route }) => route !== "direct_pdf")
      ? { deferredPdf: { admissionKey, snapshot: chatPdfRunSnapshot(prepared, sourceMessageId) } } : {})
  } : {};
}

async function admittedPdfResponse(deps: RunHandlerDeps, created: CreatedRun, userId: string): Promise<Response> {
  const run = await deps.repository.getRunOutcomeForUser(created.runId, userId);
  if (!run) return Response.json({ error: "model_run_not_found" }, { status: 404 });
  deps.chatPdf?.kick();
  deps.workspaceFollowup?.kick();
  return Response.json({ assistantMessageId: created.assistantMessageId, userMessageId: created.userMessageId,
    ...serializeRunOutcome(run) }, { status: 202, headers: { "Cache-Control": "no-store" } });
}

export function createSendMessageHandler(deps: RunHandlerDeps) {
  return protectRunHandler("send", async function POST(
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
    const admissionKey = pdfAdmissionKey("send", params.chatId, auth.userId, body);
    const duplicate = await deps.workspaceFollowup?.findAdmission(admissionKey, auth.userId) ??
      await deps.chatPdf?.findAdmission(admissionKey, auth.userId);
    if (duplicate) { deps.chatPdf?.kick(); deps.workspaceFollowup?.kick(); return Response.json(duplicate, { status: 202, headers: { "Cache-Control": "no-store" } }); }
    let chat = await deps.repository.findOwnedChat(params.chatId, auth.userId);
    let personalChat: Readonly<{
      defaultProviderModelId: string | null;
      folderId: string | null;
      memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
    }> | null = null;
    let projectChat: Readonly<{ folderId: string | null }> | null = null;
    const projectDraft = projectDraftFromBody(body);
    const personalDraft = personalDraftFromBody(body);
    const personalTemporaryPayload = body?.chatMode === "TEMPORARY";
    if (
      projectDraft === "invalid" ||
      personalDraft === "invalid" ||
      (projectDraft && personalDraft) ||
      (personalDraft && (personalDraft.memoryMode === "TEMPORARY") !== personalTemporaryPayload) ||
      ((projectDraft || personalDraft) && !chat && !uuidPattern.test(params.chatId))
    ) {
      if (personalDraft) {
        return Response.json({ error: "personal_draft_invalid" }, { status: 400 });
      }
      return Response.json({ error: "project_draft_invalid" }, { status: 400 });
    }
    if (!chat && personalDraft) {
      if (!deps.repository.loadPersonalFirstSend || body?.expectedActiveLeafId !== null) {
        return Response.json({ error: "personal_draft_invalid" }, { status: 400 });
      }
      chat = await deps.repository.loadPersonalFirstSend({
        chatId: params.chatId,
        folderId: personalDraft.folderId,
        memoryMode: personalDraft.memoryMode,
        userId: auth.userId
      });
      if (chat) {
        personalChat = {
          defaultProviderModelId: chat.defaultModelId || null,
          folderId: personalDraft.folderId,
          memoryMode: personalDraft.memoryMode
        };
      }
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
      return Response.json({
        error: projectDraft
          ? "project_not_found"
          : personalDraft
            ? "chat_not_created"
            : "chat_not_found"
      }, { status: 404 });
    }
    if (chat && personalDraft && !personalChat) {
      const matchingMode = personalDraft.memoryMode === "TEMPORARY"
        ? chat.memoryMode === "NORMAL" || chat.memoryMode === "TEMPORARY"
        : chat.memoryMode === personalDraft.memoryMode;
      if (chat.project || chat.folderId !== personalDraft.folderId || !matchingMode) {
        return Response.json({ error: "personal_draft_conflict" }, { status: 409 });
      }
    }
    if (chat && projectDraft && !projectChat) {
      const matchesPersistedProjectChat = chat.id === params.chatId &&
        chat.project?.projectId === projectDraft.projectId &&
        chat.projectFolderId === projectDraft.folderId;
      if (!matchesPersistedProjectChat) {
        return Response.json({ error: "project_draft_conflict" }, { status: 409 });
      }
    }
    const continuationBody = await approvalContinuationBody(deps, body, chat.id, auth.userId);
    if (continuationBody === "invalid") return Response.json({ error: "system_turn_invalid" }, { status: 400 });
    if (continuationBody === "unavailable") {
      return Response.json({ error: MCP_APPROVAL_CONTINUATION_UNAVAILABLE }, { status: 409 });
    }
    const sendBody = continuationBody ?? body;

    const activeRun = await deps.repository.findRecentActiveRunForChat({
      chatId: chat.id, since: new Date(Date.now() - activeRunGateWindowMs), userId: auth.userId
    });
    // A scheduled send never waits behind a retiring Workspace run: the chat counts as busy.
    const predecessorRunId = deps.workspaceFollowup && !deps.scheduledOccurrence && activeRun?.answerComplete &&
      !activeRun.workspaceWaitPending && activeRun.assistantMessageId === chat.activeLeafMessageId ? activeRun.id : null;
    if (activeRun && !predecessorRunId) {
      return Response.json({ error: "active_run_in_progress", run: {
        id: activeRun.id, status: activeRun.status === "preparing"
          ? activeRun.workspaceWaitPending ? "queued" : "streaming" : activeRun.status
      } }, { status: 409 });
    }

    const expectedActiveLeaf = expectedActiveLeafFromBody(body, chat.activeLeafMessageId);
    if (!expectedActiveLeaf.ok) {
      return Response.json({ error: "expected_active_leaf_invalid" }, { status: 400 });
    }
    const usageRefusal = await usageLimitRefusal(deps, {
      interactive: !deps.scheduledOccurrence, stage: "send", userId: auth.userId
    });
    if (usageRefusal) return usageRefusal;
    const scopeFingerprint = chatPdfFingerprint({ chatId: chat.id, project: chat.project ?? null, memoryMode: chat.memoryMode ?? null });
    const preparation = await prepareRun(deps, {
      body: sendBody,
      skillCatalogDecision: {
        operationKey: admissionKey,
        authorizeScope: async () => {
          const currentAuth = await deps.resolveAuth(request);
          if (currentAuth?.userId !== auth.userId) throw new SkillCatalogAuthorityChangedError();
          const current = personalChat && personalDraft
            ? await deps.repository.loadPersonalFirstSend?.({ chatId: params.chatId,
                folderId: personalDraft.folderId, memoryMode: personalDraft.memoryMode, userId: auth.userId })
            : projectChat && projectDraft
              ? await deps.repository.loadProjectFirstSend?.({ chatId: params.chatId,
                  folderId: projectDraft.folderId, projectId: projectDraft.projectId, userId: auth.userId })
              : await deps.repository.findOwnedChat(params.chatId, auth.userId);
          if (!current || current.activeLeafMessageId !== expectedActiveLeaf.value ||
            chatPdfFingerprint({ chatId: current.id, project: current.project ?? null, memoryMode: current.memoryMode ?? null }) !== scopeFingerprint) {
            throw new SkillCatalogAuthorityChangedError();
          }
        }
      },
      signal: request.signal,
      source: {
        chat: {
          ...chat,
          activeLeafMessageId: expectedActiveLeaf.value
        },
        ...(projectChat ? { draftProjectChat: true } : {}),
        ...(personalChat ? { draftPersonalChat: true } : {}),
        kind: "send",
        ...(deps.scheduledOccurrence ? { scheduledOccurrence: deps.scheduledOccurrence } : {})
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
        ...(predecessorRunId ? { workspaceFollowup: {
          admissionKey, predecessorRunId, snapshot: acceptedRunSnapshot(preparedData)
        } } : {}),
        ...deferredPdfInput(preparedData, admissionKey),
        ...(preparedData.assistant ? { assistant: preparedData.assistant } : {}),
        ...(preparedData.chatAssistant ? { chatAssistant: preparedData.chatAssistant } : {}),
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
        ...(preparedData.workspaceAdmissionPlan
          ? { workspaceAdmissionPlan: preparedData.workspaceAdmissionPlan }
          : {}),
        workspaceEnabled: preparedData.normalizedRequest.workspace?.enabled === true,
        providerAdmissionPlan: preparedData.providerAdmissionPlan,
        ...(preparedData.project ? { project: preparedData.project } : {}),
        modelId: preparedData.normalizedRequest.modelId,
        memoryMaterializer: createPreparingMemoryMaterializer(
          preparedData,
          preparation.adapter,
          preparation.toolBridge
        ),
        normalizedRequest: preparedData.normalizedRequest,
        ...(personalChat ? { personalChat } : {}),
        ...(preparedData.followupAdmission ? { followupAdmission: preparedData.followupAdmission } : {}),
        provider: preparedData.normalizedRequest.provider,
        providerRequestPreview: preparedData.providerRequestPreview,
        ...(projectChat ? { projectChat } : {}),
        ...(deps.scheduledOccurrence ? {
          scheduledOccurrence: deps.scheduledOccurrence,
          ...(preparedData.scheduledUnavailableSources ? { scheduledUnavailableSources: preparedData.scheduledUnavailableSources } : {})
        } : {}),
        signal: request.signal,
        ...(continuationBody ? { systemTurnKind: MCP_APPROVAL_CONTINUATION_KIND } : {}),
        userId: auth.userId
      });
    } catch (error) {
      const duplicate = await deps.workspaceFollowup?.findAdmission(admissionKey, auth.userId) ??
        await deps.chatPdf?.findAdmission(admissionKey, auth.userId);
      if (duplicate) { deps.chatPdf?.kick(); deps.workspaceFollowup?.kick(); return Response.json(duplicate, { status: 202, headers: { "Cache-Control": "no-store" } }); }
      if (isScheduledOccurrenceConflictError(error)) {
        return Response.json({ error: "scheduled_task_occurrence_unavailable" }, { status: 409 });
      }
      if (error instanceof WorkspaceFollowupError) return Response.json({ error: error.code }, { status: 409 });
      if (error instanceof InstructionPresetError) return Response.json({ error: error.code }, { status: 409 });
      if ((error instanceof ChatPdfPreparationError || isChatPdfPolicyUnavailableError(error))) return Response.json({ error: error.code }, { status: 409 });
      if (isActiveRunConflictError(error)) {
        return activeRunInsertConflictResponse(chat.id, deps.repository, auth.userId);
      }

      if (isActiveLeafConflictError(error)) {
        return Response.json({ error: "active_leaf_changed" }, { status: 409 });
      }

      if (isAttachmentLinkConflictError(error)) {
        return Response.json({ error: "attachment_not_available" }, { status: 409 });
      }

      if (error instanceof McpToolAccessDeniedError) {
        return Response.json({ error: error.code }, { status: 409 });
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

      if (isWorkspaceRunConflictError(error)) {
        return Response.json({ error: error.code }, { status: 409 });
      }

      // Saved secrets are frozen at admission: a limit stays until the owner
      // removes secrets, while unreadable storage may recover.
      const secretCode = workspaceSecretAdmissionCode(error);
      if (secretCode) {
        return Response.json({ error: secretCode }, { status: secretCode === "workspace_secret_limit" ? 409 : 503 });
      }

      throw error;
    }
    if (created.deferredPdf || created.deferredWorkspace) return admittedPdfResponse(deps, created, auth.userId);
    preparedData = applyPreparingMaterialization(preparedData, created);
    const runtime = await acceptedRuntimeBinding(
      deps,
      created.runId,
      preparedData.normalizedRequest.searchPlan.options.map((option) => option.optionId)
    );
    return createRunExecutionResponse({
      adapter: runtime?.adapter ?? preparation.adapter,
      ...(runtime?.agentResponses ? { agentResponses: runtime.agentResponses } : {}),
      created,
      prepared: preparedData,
      repository: deps.repository,
      ...(deps.knowledgeAdmission ? { knowledgeAdmission: deps.knowledgeAdmission } : {}),
      ...(deps.knowledgeExecutor ? { knowledgeExecutor: deps.knowledgeExecutor } : {}),
      ...(deps.knowledgeProviderDispatch
        ? { knowledgeProviderDispatch: deps.knowledgeProviderDispatch }
        : {}),
      ...(deps.chatTitleGenerator ? { chatTitleGenerator: deps.chatTitleGenerator } : {}),
      ...(deps.images ? { images: deps.images } : {}),
      ...(deps.vision ? { vision: deps.vision } : {}),
      ...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
      ...(deps.skillTools ? { skillTools: deps.skillTools } : {}),
      ...(deps.observations ? { observations: deps.observations } : {}),
      ...(deps.memoryEgress ? { memoryEgress: deps.memoryEgress } : {}),
      ...(deps.memorySearch ? { memorySearch: deps.memorySearch } : {}),
      ...(deps.mcp ? { mcp: deps.mcp } : {}),
      ...(deps.providerAdmission ? { providerAdmission: deps.providerAdmission } : {}),
      ...(runtime?.searchRuntimes ? { searchRuntimes: runtime.searchRuntimes } : {}),
      ...(runtime?.structuredOutputAdapter
        ? { structuredOutputAdapter: runtime.structuredOutputAdapter }
        : {}),
      ...(deps.workspaceCoordinator ? { workspace: deps.workspaceCoordinator } : {}),
      toolBridge: runtime?.toolBridge ?? preparation.toolBridge,
      userId: auth.userId
    });
  });
}

export function createRegenerateModelRunHandler(deps: RunHandlerDeps) {
  return protectRunHandler("regenerate", async function POST(
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
    const admissionKey = pdfAdmissionKey("regenerate", params.messageId, auth.userId, body);
    const duplicate = await deps.chatPdf?.findAdmission(admissionKey, auth.userId);
    if (duplicate) { deps.chatPdf?.kick(); return Response.json(duplicate, { status: 202, headers: { "Cache-Control": "no-store" } }); }
    const source = await deps.repository.findRegenerationSource(params.messageId, auth.userId);
    if (!source) {
      return Response.json({ error: "message_not_found_or_not_regeneratable" }, { status: 404 });
    }

    const activeRunResponse = await activeRunConflictResponse(source.chat.id, deps.repository, auth.userId);
    if (activeRunResponse) {
      return activeRunResponse;
    }
    // Every regeneration, edit and document retry is a new interactive run.
    const usageRefusal = await usageLimitRefusal(deps, { interactive: true, stage: "regenerate", userId: auth.userId });
    if (usageRefusal) return usageRefusal;

    const retry = body?.retryPdfPreparation === true && source.assistantMessage
      ? await deps.chatPdf?.loadRetry?.({ assistantMessageId: source.assistantMessage.id,
          chatId: source.chat.id, userId: auth.userId, userMessageId: source.userMessage.id })
      : null;
    if (body?.retryPdfPreparation === true && !retry) {
      return Response.json({ error: "pdf_preparation_unavailable" }, { status: 409 });
    }
    if (retry) {
      if (body?.artifactIntent !== undefined && body.artifactIntent !== retry.prepared.normalizedRequest.artifactIntent) return Response.json({ error: "artifact_intent_unavailable" }, { status: 409 });
      const artifactEdit = retry.prepared.normalizedRequest.artifactEdit;
      const requestedEdit = body?.artifactEdit === undefined ? undefined : decodeArtifactEdit(body.artifactEdit);
      if (requestedEdit && (!artifactEdit || requestedEdit.artifactId !== artifactEdit.artifactId || requestedEdit.versionId !== artifactEdit.versionId)) {
        return Response.json({ error: "artifact_edit_unavailable" }, { status: 409 });
      }
      if (artifactEdit) {
        const target = await deps.artifacts?.validateEditTarget({ ...artifactEdit, chatId: source.chat.id, ownerUserId: auth.userId });
        if (!target?.ok) return Response.json({ error: target?.code ?? "artifact_edit_unavailable" }, { status: 409 });
      }
    }
    const scopeFingerprint = chatPdfFingerprint({ chatId: source.chat.id, project: source.chat.project ?? null,
      memoryMode: source.chat.memoryMode ?? null, userMessage: source.userMessage });
    const preparation = retry ? await preparePdfRetry(deps, { ...retry, signal: request.signal,
      userId: auth.userId, userMessageId: source.userMessage.id }) : await prepareRun(deps, {
      body,
      skillCatalogDecision: {
        operationKey: admissionKey,
        authorizeScope: async () => {
          const currentAuth = await deps.resolveAuth(request);
          if (currentAuth?.userId !== auth.userId) throw new SkillCatalogAuthorityChangedError();
          const current = await deps.repository.findRegenerationSource(params.messageId, auth.userId);
          if (!current || chatPdfFingerprint({ chatId: current.chat.id, project: current.chat.project ?? null,
            memoryMode: current.chat.memoryMode ?? null, userMessage: current.userMessage }) !== scopeFingerprint) {
            throw new SkillCatalogAuthorityChangedError();
          }
        }
      },
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
    // A PDF retry reuses its frozen preparation: it rechecks that the chat is
    // still bound to the same Assistant but never replays the override change.
    const chatAssistant = preparedData.chatAssistant && retry
      ? { assistantId: preparedData.chatAssistant.assistantId, bind: false, overridesPatch: {} }
      : preparedData.chatAssistant;
    let created: CreatedRun;
    try {
      created = await deps.repository.createRegenerationRun({
        ...deferredPdfInput(preparedData, admissionKey, source.assistantMessage?.id),
        ...(preparedData.assistant ? { assistant: preparedData.assistant } : {}),
        ...(chatAssistant ? { chatAssistant } : {}),
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
        ...(preparedData.workspaceAdmissionPlan
          ? { workspaceAdmissionPlan: preparedData.workspaceAdmissionPlan }
          : {}),
        workspaceEnabled: preparedData.normalizedRequest.workspace?.enabled === true,
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
        ...(preparedData.followupAdmission ? { followupAdmission: preparedData.followupAdmission } : {}),
        provider: preparedData.normalizedRequest.provider,
        providerRequestPreview: preparedData.providerRequestPreview,
        signal: request.signal,
        userId: auth.userId,
        userMessageId: source.userMessage.id
      });
    } catch (error) {
      const duplicate = await deps.chatPdf?.findAdmission(admissionKey, auth.userId);
      if (duplicate) { deps.chatPdf?.kick(); return Response.json(duplicate, { status: 202, headers: { "Cache-Control": "no-store" } }); }
      if (error instanceof InstructionPresetError) return Response.json({ error: error.code }, { status: 409 });
      if ((error instanceof ChatPdfPreparationError || isChatPdfPolicyUnavailableError(error))) return Response.json({ error: error.code }, { status: 409 });
      if (isActiveRunConflictError(error)) {
        return activeRunInsertConflictResponse(source.chat.id, deps.repository, auth.userId);
      }

      if (isActiveLeafConflictError(error)) {
        return Response.json({ error: "active_leaf_changed" }, { status: 409 });
      }

      if (error instanceof McpToolAccessDeniedError) {
        return Response.json({ error: error.code }, { status: 409 });
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

      if (isWorkspaceRunConflictError(error)) {
        return Response.json({ error: error.code }, { status: 409 });
      }

      const secretCode = workspaceSecretAdmissionCode(error);
      if (secretCode) {
        return Response.json({ error: secretCode }, { status: secretCode === "workspace_secret_limit" ? 409 : 503 });
      }

      throw error;
    }
    if (created.deferredPdf) return admittedPdfResponse(deps, created, auth.userId);
    preparedData = applyPreparingMaterialization(preparedData, created);
    const runtime = await acceptedRuntimeBinding(
      deps,
      created.runId,
      preparedData.normalizedRequest.searchPlan.options.map((option) => option.optionId)
    );
    return createRunExecutionResponse({
      adapter: runtime?.adapter ?? preparation.adapter,
      ...(runtime?.agentResponses ? { agentResponses: runtime.agentResponses } : {}),
      created,
      prepared: preparedData,
      repository: deps.repository,
      ...(deps.knowledgeAdmission ? { knowledgeAdmission: deps.knowledgeAdmission } : {}),
      ...(deps.knowledgeExecutor ? { knowledgeExecutor: deps.knowledgeExecutor } : {}),
      ...(deps.knowledgeProviderDispatch
        ? { knowledgeProviderDispatch: deps.knowledgeProviderDispatch }
        : {}),
      ...(deps.chatTitleGenerator ? { chatTitleGenerator: deps.chatTitleGenerator } : {}),
      ...(deps.images ? { images: deps.images } : {}),
      ...(deps.vision ? { vision: deps.vision } : {}),
      ...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
      ...(deps.skillTools ? { skillTools: deps.skillTools } : {}),
      ...(deps.observations ? { observations: deps.observations } : {}),
      ...(deps.memoryEgress ? { memoryEgress: deps.memoryEgress } : {}),
      ...(deps.memorySearch ? { memorySearch: deps.memorySearch } : {}),
      ...(deps.mcp ? { mcp: deps.mcp } : {}),
      ...(deps.providerAdmission ? { providerAdmission: deps.providerAdmission } : {}),
      ...(runtime?.searchRuntimes ? { searchRuntimes: runtime.searchRuntimes } : {}),
      ...(runtime?.structuredOutputAdapter
        ? { structuredOutputAdapter: runtime.structuredOutputAdapter }
        : {}),
      ...(deps.workspaceCoordinator ? { workspace: deps.workspaceCoordinator } : {}),
      toolBridge: runtime?.toolBridge ?? preparation.toolBridge,
      userId: auth.userId
    });
  });
}

export function createGetModelRunHandler(
  deps: Pick<
    RunHandlerDeps,
    | "getConfig"
    | "getAttachmentLimits"
    | "knowledgeAdmission"
    | "knowledgeExecutor"
    | "knowledgeProviderDispatch"
    | "artifacts"
    | "skillTools"
    | "observations"
    | "vision"
    | "images"
    | "memoryEgress"
    | "memorySearch"
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

export function createCancelModelRunHandler(deps: Omit<RunHandlerDeps, "usageLimits">) {
  return protectRunHandler("cancel", async function POST(
    request: Request,
    context: { params: Promise<{ runId: string }> | { runId: string } }
  ): Promise<Response> {
    const config = deps.getConfig?.() ?? getAuthConfig();
    if (!config.configured) {
      logStopAdmission({ outcome: "unauthorized" });
      return privateModelRunJson({ error: "unauthorized" }, { status: 401 });
    }

    const auth = await deps.resolveAuth(request);
    if (!auth) {
      logStopAdmission({ outcome: "unauthorized" });
      return privateModelRunJson({ error: "unauthorized" }, { status: 401 });
    }

    const params = await context.params;
    let cancellation: Awaited<ReturnType<RunRepository["cancelRun"]>>;
    try {
      cancellation = await deps.repository.cancelRun({
        payload: {
          code: "model_run_cancelled",
          message: "Model run cancelled"
        },
        runId: params.runId,
        userId: auth.userId
      });
    } catch (error) {
      logStopAdmission({ outcome: "failed", prisma_code: runDatabaseFailureCode(error) });
      throw error;
    }

    if (cancellation.kind === "not_found") {
      logStopAdmission({ outcome: "not_found" });
      return privateModelRunJson({ error: "model_run_not_found" }, { status: 404 });
    }

    if (cancellation.kind === "current") {
      logStopAdmission({ run_id: cancellation.run.id, outcome: "not_cancelable" });
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
    logStopAdmission({ run_id: run.id, outcome: "accepted" });
    return runWithContext({ run_id: run.id }, async () => {
      logRunPersistence(run.id, "cancel", "confirmed");
      await settleCancelledRun(deps, run, auth.userId);
      return privateModelRunJson({
        run: {
          id: run.id,
          status: "cancelled"
        }
      } satisfies CancelModelRunSuccessResponse);
    });
  });
}

type RunStopDeps = Pick<RunHandlerDeps, "providerRuntime" | "providers" | "repository" | "workspaceCoordinator">;
type CancelledRun = Extract<Awaited<ReturnType<RunRepository["cancelRun"]>>, { kind: "cancelled" }>["run"];

/**
 * The rest of Stop once the durable cancellation won: the run executing in
 * this process is aborted and its terminal handling awaited, or a Workspace
 * reservation no executor owns is released; then the provider is asked to
 * cancel its response.
 */
async function settleCancelledRun(deps: RunStopDeps, run: CancelledRun, userId: string): Promise<void> {
  const aborted = activeRunControllerRegistry.abort(run.id);
  const settled = aborted ? activeRunControllerRegistry.settled(run.id) : null;
  if (settled) {
    // Stop means the run's terminal handling (tool cancellation, Workspace
    // quiescence and session settlement) is done before the client re-reads
    // the chat; the wait is bounded so a wedged executor cannot hang Stop.
    await Promise.race([
      settled,
      new Promise<void>((resolve) => setTimeout(resolve, 20_000).unref?.())
    ]);
  } else if (deps.workspaceCoordinator) {
    // PDF preparation may own a controller without an answer settlement
    // promise. Release its Workspace reservation here as well as orphaned work.
    await deps.workspaceCoordinator.settle({
      outcome: "cancelled",
      runId: run.id,
      userId
    }).catch(() => undefined);
  }

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
}

/**
 * Stops a run through the Stop path with a server-chosen terminal cause that
 * the run keeps (a scheduled run's deadline records `run_deadline`, not
 * `model_run_cancelled`). Only an active run is stopped; a settled or
 * missing one is left as it is.
 */
export async function stopModelRun(
  deps: RunStopDeps,
  input: Readonly<{ payload: Readonly<{ code: string; message: string }>; runId: string; userId: string }>
): Promise<"stopped" | "not_cancelable" | "not_found"> {
  const cancellation = await deps.repository.cancelRun({
    payload: { code: input.payload.code, message: input.payload.message }, runId: input.runId, userId: input.userId
  });
  if (cancellation.kind === "not_found") return "not_found";
  if (cancellation.kind === "current") return "not_cancelable";
  const run = cancellation.run;
  await runWithContext({ run_id: run.id }, async () => {
    logRunPersistence(run.id, "cancel", "confirmed");
    await settleCancelledRun(deps, run, input.userId);
  });
  return "stopped";
}
