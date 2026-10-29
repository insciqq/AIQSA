import type { PrismaClient } from "@prisma/client";
import { getDefaultMcpRuntimeCoordinator } from "../mcp/defaultRuntime";
import { MCP_APPROVAL_TTL_MS } from "../mcp/writeApproval";
import { prisma } from "../prisma";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import { createRetiredEngineRunFinder } from "../runs/retiredEngineRuns";
import type { RunRepository } from "../runs/runRepositoryContract";
import { defaultToolObservations } from "../toolObservations/defaultService";
import type { StorageAdapter } from "../uploads/storage";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { createRunSecretSource } from "../workspace/secrets/runSecrets";
import type { NativeEngineDeps } from "./execution";
import { engineTestFaults } from "./faults";
import type { NativeEngineHandlerDeps } from "./handlerSupport";
import { createNativeOrphanFinder, processBootedAt, type NativeRecoveryDeps } from "./recovery";
import { providerRuntimeResolver } from "../providerRuntime/defaultRuntime";
import { createNativeRunStore } from "./runStore";
import { createPrismaSubagentModelCatalog } from "./subagents/modelRoutes";
import { createSubagentThreadStore } from "./subagents/threadStore";
import { createToolCallStore } from "./toolCallStore";
import type { ToolRegistryServices } from "./toolRegistry";
import { createSavedToolResultReader } from "./toolResults";
import { createTranscriptRepository } from "./transcriptRepository";

/**
 * The call an approval continuation sends: the initiator's own Allow in this
 * chat, decided within the approval window and not yet used, with the
 * refused call it allows.
 */
export async function loadApprovedCall(
  client: Pick<PrismaClient, "mcpToolApproval">,
  input: Readonly<{ approvalId: string; chatId: string; userId: string }>,
  now = new Date()
): Promise<Readonly<{ providerCallId: string; toolName: string }> | null> {
  const row = await client.mcpToolApproval.findFirst({
    select: { toolCall: { select: { providerCallId: true, toolName: true } } },
    where: { chatId: input.chatId, consumedAt: null, decidedAt: { gt: new Date(now.getTime() - MCP_APPROVAL_TTL_MS) },
      decision: { in: ["allow_once", "allow_server"] }, id: input.approvalId, userId: input.userId }
  });
  return row?.toolCall ? { providerCallId: row.toolCall.providerCallId, toolName: row.toolCall.toolName } : null;
}

/** The engine's stores on the installation database and object storage. */
export function defaultNativeEngineDeps(storage: StorageAdapter, client: PrismaClient = prisma): NativeEngineDeps {
  let observations: ReturnType<typeof defaultToolObservations> | null = null;
  return {
    approvedCall: (input) => loadApprovedCall(client, input),
    faults: () => engineTestFaults(process.env),
    mcpBindingRows: (runId) => client.mcpRunBinding.findMany({
      select: { id: true, runtimeGenerationFingerprint: true, runtimeGenerationId: true }, where: { modelRunId: runId }
    }),
    observations: () => observations ??= defaultToolObservations(),
    runs: createNativeRunStore(client),
    savedResults: createSavedToolResultReader({ prisma: client, storage }),
    // A frozen model other than the parent's is admitted at its first use through the answer model's resolver.
    subagentModels: createPrismaSubagentModelCatalog({ prisma: client, runtime: providerRuntimeResolver }),
    subagentThreads: createSubagentThreadStore(client),
    toolCalls: createToolCallStore(client),
    transcripts: createTranscriptRepository(client)
  };
}

type AssistantOwners = NonNullable<ToolRegistryServices["selfService"]>["assistants"];

async function loadAssistantOwners() {
  const [{ defaultAssistantHandlerDeps }, { defaultAssistantDeletionHandlerDeps }] = await Promise.all([
    import("../assistants/defaultAssistants"), import("../assistants/defaultAssistantDeletion")
  ]);
  return { deletion: defaultAssistantDeletionHandlerDeps.repository, handlers: defaultAssistantHandlerDeps };
}

/**
 * The Studio Assistant routes' own dependencies, imported on first use: the
 * recovery scheduler loads this module at startup and must not pull in the
 * routes' defaults (sign-in, mail, MCP repositories) with it.
 */
function lazyAssistantOwners(): AssistantOwners {
  let loaded: ReturnType<typeof loadAssistantOwners> | null = null;
  const load = () => loaded ??= loadAssistantOwners().catch((error: unknown) => {
    loaded = null;
    throw error;
  });
  const repository = async () => (await load()).handlers.repository;
  return {
    deletion: { loadConsequences: async (userId, assistantId) => (await load()).deletion.loadConsequences(userId, assistantId) },
    loadCatalogData: async (userId) => (await load()).handlers.loadCatalogData(userId),
    repository: {
      getDetail: async (userId, assistantId, options) => (await repository()).getDetail(userId, assistantId, options),
      listForUser: async (userId) => (await repository()).listForUser(userId),
      listPublishableGroups: async (userId) => (await repository()).listPublishableGroups(userId),
      loadUserAccessibleMcpServerIds: async (userId) => (await repository()).loadUserAccessibleMcpServerIds(userId),
      loadUserMcpRunPlanView: async (userId) => (await repository()).loadUserMcpRunPlanView(userId)
    }
  };
}

/**
 * The owners behind the harness and self-service tools: the saved secrets
 * `read_secret` reads in any chat, and the Studio paths the self-service
 * tools change secrets, Skills and Assistants through.
 */
export function defaultNativeToolServices(storage: StorageAdapter, client: PrismaClient = prisma):
  Required<Pick<ToolRegistryServices, "secrets" | "selfService">> {
  return {
    secrets: createRunSecretSource(client),
    selfService: { assistants: lazyAssistantOwners(), db: client, storage }
  };
}

/** The native engine as every send entry point and the regenerate route admit it. */
export function defaultNativeEngineHandlerDeps(storage: StorageAdapter, client: PrismaClient = prisma): NativeEngineHandlerDeps {
  return {
    engine: defaultNativeEngineDeps(storage, client),
    findOrphans: createNativeOrphanFinder(client),
    findRetiredRuns: createRetiredEngineRunFinder(client),
    mcpRuntime: () => getDefaultMcpRuntimeCoordinator(),
    tools: defaultNativeToolServices(storage, client)
  };
}

/** The installation-wide recovery pass of the engine's runs. */
export function defaultNativeRecoveryDeps(input: Readonly<{
  repository: Pick<RunRepository, "failRun">;
  workspace?: WorkspaceCoordinator;
}>, client: PrismaClient = prisma): NativeRecoveryDeps {
  return {
    bootedAt: processBootedAt(),
    findOrphans: createNativeOrphanFinder(client),
    liveRunIds: () => activeRunControllerRegistry.ids(),
    repository: input.repository,
    runs: createNativeRunStore(client),
    ...(input.workspace ? { workspace: input.workspace } : {})
  };
}
