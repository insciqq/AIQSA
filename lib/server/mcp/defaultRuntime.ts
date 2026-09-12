import { createMcpClientSessionFactory } from "./clientSessionFactory";
import {
  createDefaultMcpOAuthRuntimeProvider,
  mcpOAuthService
} from "./defaultOAuth";
import {
  createToolHiveRuntimeLifecycle,
  getDefaultToolHiveDriver
} from "./defaultToolHive";
import { McpRuntimeCoordinator } from "./runtimeCoordinator";
import { createPrismaMcpRuntimeRepository } from "./runtimeRepository";
import { createMcpSafeFetch } from "./safeFetch";
import { createToolHiveMcpSessionFactory } from "./toolhiveSessionFactory";
import { prepareMcpRunPlan } from "./runPlan";
import {
  createPrismaMcpCapabilityCatalogLoader,
  createPrismaMcpProjectRunPlanLoader,
  createPrismaMcpRunPlanLoader
} from "./runPlanRepository";
import { prisma } from "../prisma";
import { createSystemModelRoleResolver } from "../providerRuntime/systemModelRole";
import { createAcceptedStructuredOutputExecutor } from "../providerRuntime/structuredOutputExecutor";
import { createMcpSemanticRouter } from "./router";
import { filterMcpToolsForUser } from "./toolAccess";

const DEFAULT_RUNTIME_LIMITS = {
  maxListPages: 16,
  maxToolArgumentBytes: 64 * 1_024,
  maxToolMetadataBytes: 256 * 1_024,
  maxToolResultBytes: 128 * 1_024,
  maxToolSchemaBytes: 64 * 1_024,
  maxTools: 256
} as const;

type McpRuntimeGlobal = typeof globalThis & {
  __aiqsaMcpRuntimeCoordinator?: McpRuntimeCoordinator;
};

function createDefaultMcpRuntimeCoordinator(): McpRuntimeCoordinator {
  const toolHiveDriver = getDefaultToolHiveDriver();
  const directSessions = createMcpClientSessionFactory({
    authProviderForLaunch: async (launch) => launch.oauthConnectionId
      ? createDefaultMcpOAuthRuntimeProvider(launch.oauthConnectionId)
      : undefined,
    fetch: createMcpSafeFetch(),
    async fetchForLaunch(launch) {
      const baseFetch = createMcpSafeFetch({
        allowInsecureHttp: true,
        allowPrivateNetwork: launch.trustedInternalHttp === true || launch.allowPrivateNetwork === true
      });
      return launch.oauthConnectionId
        ? mcpOAuthService.createRuntimeFetch(launch.oauthConnectionId, baseFetch, launch.url)
        : baseFetch;
    },
    limits: DEFAULT_RUNTIME_LIMITS
  });
  return new McpRuntimeCoordinator({
    repository: createPrismaMcpRuntimeRepository({
      oauthRedirectUri: (serverId) => new URL(
        `/api/me/mcp/${encodeURIComponent(serverId)}/oauth/callback`,
        process.env.AIQSA_APP_BASE_URL?.trim() || "http://localhost:3000"
      ).toString(),
      reconcileOAuthConnections: () => mcpOAuthService.reconcileDisconnecting()
    }),
    runtimeLifecycle: createToolHiveRuntimeLifecycle(toolHiveDriver),
    sessions: createToolHiveMcpSessionFactory({
      directSessions,
      driver: toolHiveDriver
    })
  });
}

export function getDefaultMcpRuntimeCoordinator(): McpRuntimeCoordinator {
  const scope = globalThis as McpRuntimeGlobal;
  const coordinator = scope.__aiqsaMcpRuntimeCoordinator ?? createDefaultMcpRuntimeCoordinator();
  scope.__aiqsaMcpRuntimeCoordinator = coordinator;
  coordinator.start();
  return coordinator;
}

export function kickDefaultMcpRuntime(userId?: string): void {
  getDefaultMcpRuntimeCoordinator().kick(userId);
}

export function defaultMcpOperationalStatus(generationId: string) {
  // Status reads must not create/start the coordinator or wake idle workloads.
  return (globalThis as McpRuntimeGlobal).__aiqsaMcpRuntimeCoordinator
    ?.operationalStatus(generationId) ?? "inactive";
}

const loadRunPlan = createPrismaMcpRunPlanLoader();
const loadProjectRunPlan = createPrismaMcpProjectRunPlanLoader();
const loadCapabilityCatalog = createPrismaMcpCapabilityCatalogLoader();
const systemModelRole = createSystemModelRoleResolver(prisma);
const defaultMcpSemanticRouter = createMcpSemanticRouter({
  executeStructuredOutput: createAcceptedStructuredOutputExecutor(prisma),
  resolveSystemModel: () => systemModelRole.resolve()
});

async function prepareExactMcpRunPlan(
  userId: string,
  serverIds: readonly string[],
  toolNames?: readonly string[],
  signal?: AbortSignal
) {
  let coordinator: McpRuntimeCoordinator | null = null;
  const currentCoordinator = () => {
    coordinator ??= getDefaultMcpRuntimeCoordinator();
    return coordinator;
  };
  signal?.throwIfAborted();
  await currentCoordinator().ensureUserServersReady(userId, serverIds, signal);
  signal?.throwIfAborted();
  return prepareMcpRunPlan({
    allowedServerIds: serverIds,
    ...(toolNames ? { allowedToolNames: toolNames } : {}),
    isGenerationLive: (generationId) => currentCoordinator().hasLiveGeneration(generationId),
    load: () => loadRunPlan(userId, serverIds),
    reconcile: async () => {
      signal?.throwIfAborted();
      await currentCoordinator().reconcileNow(userId);
    }
  });
}

async function prepareExactProjectMcpRunPlan(userId: string, serverIds: readonly string[]) {
  let coordinator: McpRuntimeCoordinator | null = null;
  const currentCoordinator = () => {
    coordinator ??= getDefaultMcpRuntimeCoordinator();
    return coordinator;
  };
  // Project execution never calls ensureUserServersReady: that operation can
  // create or reconcile a member's personal McpUserServer row.  The loader
  // below selects an already-running installation/shared generation instead.
  return prepareMcpRunPlan({
    allowedServerIds: serverIds,
    isGenerationLive: (generationId) => currentCoordinator().hasLiveGeneration(generationId),
    load: () => loadProjectRunPlan(userId, serverIds)
  });
}

export const defaultMcpRunPlan = {
  filterTools: filterMcpToolsForUser,
  catalog(userId: string) {
    return loadCapabilityCatalog(userId);
  },
  async materialize(
    userId: string,
    tools: readonly Readonly<{
      namespacedName: string;
      revisionId: string;
      serverId: string;
    }>[],
    signal?: AbortSignal
  ) {
    const serverIds = [...new Set(tools.map((tool) => tool.serverId))];
    const toolNames = tools.map((tool) => tool.namespacedName);
    const plan = await prepareExactMcpRunPlan(userId, serverIds, toolNames, signal);
    if (!plan.ok) return plan;
    const revisions = new Map(plan.snapshot.servers.map((server) => [server.serverId, server.revisionId]));
    if (tools.some((tool) => revisions.get(tool.serverId) !== tool.revisionId)) {
      return {
        code: "mcp_not_ready" as const,
        issues: [{
          errorCode: "mcp_revision_changed",
          name: "Selected MCP tool",
          readiness: "unavailable" as const
        }],
        ok: false as const
      };
    }
    return plan;
  },
  inspect(userId: string, tools: readonly Readonly<{
    namespacedName: string;
    revisionId: string;
    serverId: string;
  }>[]) {
    const serverIds = [...new Set(tools.map((tool) => tool.serverId))];
    return prepareMcpRunPlan({
      allowedServerIds: serverIds,
      allowedToolNames: tools.map((tool) => tool.namespacedName),
      isGenerationLive: (generationId) => (globalThis as McpRuntimeGlobal)
        .__aiqsaMcpRuntimeCoordinator?.hasLiveGeneration(generationId) ?? false,
      load: () => loadRunPlan(userId, serverIds)
    });
  },
  async prepare(
    userId: string,
    options?: Readonly<{ allowedServerIds?: readonly string[] }>
  ) {
    const serverIds = options?.allowedServerIds ??
      (await loadCapabilityCatalog(userId)).servers.map((server) => server.serverId);
    return prepareExactMcpRunPlan(userId, serverIds);
  },
  async prepareProject(userId: string, serverIds: readonly string[]) {
    return prepareExactProjectMcpRunPlan(userId, serverIds);
  },
  router: defaultMcpSemanticRouter
};
