import { MCP_INVENTORY_SESSION_LIMITS } from "./clientSession";
import { createMcpClientSessionFactory } from "./clientSessionFactory";
import { getMcpRequestMaxBytes } from "./responseLimits";
import {
  createDefaultMcpOAuthRuntimeProvider,
  mcpOAuthService
} from "./defaultOAuth";
import { personalMcpAddressPolicy } from "./defaultPersonalNetwork";
import { mcpDestinationSafeFetchOptions } from "./personalNetworkPolicy";
import { McpRuntimeCoordinator, type McpRuntimeLaunch } from "./runtimeCoordinator";
import { createPrismaMcpRuntimeRepository } from "./runtimeRepository";
import { createMcpSafeFetch, type McpAddressPolicy, type McpSafeFetchOptions } from "./safeFetch";
import type { McpOAuthService } from "./oauthService";
import { prepareMcpRunPlan } from "./runPlan";
import {
  createPrismaMcpCapabilityCatalogLoader,
  createPrismaMcpProjectRunPlanLoader,
  createPrismaMcpRunPlanLoader
} from "./runPlanRepository";
import { filterMcpToolsForUser } from "./toolAccess";
import { reportSubsystemFailure, reportSubsystemHealthy } from "../observability";
import { observedFailureCode } from "../providers/providerObservability";

const DEFAULT_RUNTIME_LIMITS = {
  ...MCP_INVENTORY_SESSION_LIMITS,
  get maxToolArgumentBytes() { return getMcpRequestMaxBytes(); }
} as const;

type McpRuntimeGlobal = typeof globalThis & {
  __aiqsaMcpRuntimeCoordinator?: McpRuntimeCoordinator;
};

type LaunchFetch = Awaited<ReturnType<McpOAuthService["createRuntimeFetch"]>>;

/**
 * The transport of one runtime launch. Each request of a personal runtime
 * re-checks the personal network policy; installation runtimes keep their
 * reviewed permission. Seams are injectable for tests.
 */
export function createDefaultMcpLaunchFetch(deps: Readonly<{
  createSafeFetch?: (options: McpSafeFetchOptions) => LaunchFetch;
  oauthRuntimeFetch?: McpOAuthService["createRuntimeFetch"];
  personalAddressPolicy?: McpAddressPolicy;
}> = {}): (launch: McpRuntimeLaunch) => Promise<LaunchFetch> {
  const createSafeFetch = deps.createSafeFetch ?? createMcpSafeFetch;
  const personalAddressPolicy = deps.personalAddressPolicy ?? personalMcpAddressPolicy;
  const oauthRuntimeFetch = deps.oauthRuntimeFetch ??
    ((connectionId, baseFetch, serverUrl) => mcpOAuthService.createRuntimeFetch(connectionId, baseFetch, serverUrl));
  return async (launch) => {
    const baseFetch = createSafeFetch(mcpDestinationSafeFetchOptions({
      allowInsecureHttp: true,
      allowPrivateNetwork: launch.allowPrivateNetwork === true,
      personal: launch.personalRuntime === true
    }, personalAddressPolicy));
    return launch.oauthConnectionId ? oauthRuntimeFetch(launch.oauthConnectionId, baseFetch, launch.url) : baseFetch;
  };
}

function createDefaultMcpRuntimeCoordinator(): McpRuntimeCoordinator {
  const directSessions = createMcpClientSessionFactory({
    authProviderForLaunch: async (launch) => launch.oauthConnectionId
      ? createDefaultMcpOAuthRuntimeProvider(launch.oauthConnectionId)
      : undefined,
    fetch: createMcpSafeFetch(),
    fetchForLaunch: createDefaultMcpLaunchFetch(),
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
    sessions: directSessions
  });
}

export function getDefaultMcpRuntimeCoordinator(): McpRuntimeCoordinator {
  const scope = globalThis as McpRuntimeGlobal;
  try {
    const coordinator = scope.__aiqsaMcpRuntimeCoordinator ?? createDefaultMcpRuntimeCoordinator();
    scope.__aiqsaMcpRuntimeCoordinator = coordinator;
    coordinator.start();
    reportSubsystemHealthy("mcp", "startup");
    return coordinator;
  } catch (error) {
    reportSubsystemFailure({ subsystem: "mcp", stage: "startup", code: observedFailureCode(error), action: "retry" });
    throw error;
  }
}

export function kickDefaultMcpRuntime(userId?: string): void {
  getDefaultMcpRuntimeCoordinator().kick(userId);
}

const loadRunPlan = createPrismaMcpRunPlanLoader();
const loadProjectRunPlan = createPrismaMcpProjectRunPlanLoader();
const loadCapabilityCatalog = createPrismaMcpCapabilityCatalogLoader();

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

async function prepareExactProjectMcpRunPlan(userId: string, serverIds: readonly string[], toolNames?: readonly string[]) {
  let coordinator: McpRuntimeCoordinator | null = null;
  const currentCoordinator = () => {
    coordinator ??= getDefaultMcpRuntimeCoordinator();
    return coordinator;
  };
  // Project execution never calls ensureUserServersReady: that operation can
  // create or reconcile a member's personal McpUserServer row. It starts the
  // servers' installation-owned shared runtimes instead, so a cold process,
  // an idle member or a stale inventory never leaves the Project without MCP.
  // The loader applies the initiator's tool restrictions to that runtime.
  const ensureShared = () => currentCoordinator().ensureSharedServersReady(serverIds);
  await ensureShared();
  return prepareMcpRunPlan({
    allowedServerIds: serverIds,
    ...(toolNames ? { allowedToolNames: toolNames } : {}),
    isGenerationLive: (generationId) => currentCoordinator().hasLiveGeneration(generationId),
    load: () => loadProjectRunPlan(userId, serverIds),
    reconcile: ensureShared
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
    options?: Readonly<{ allowedServerIds?: readonly string[]; allowedToolNames?: readonly string[] }>
  ) {
    const serverIds = options?.allowedServerIds ??
      (await loadCapabilityCatalog(userId)).servers.map((server) => server.serverId);
    return prepareExactMcpRunPlan(userId, serverIds, options?.allowedToolNames);
  },
  async prepareProject(userId: string, serverIds: readonly string[], options?: Readonly<{ allowedToolNames?: readonly string[] }>) {
    return prepareExactProjectMcpRunPlan(userId, serverIds, options?.allowedToolNames);
  }
};
