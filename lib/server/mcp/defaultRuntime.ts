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
import { createPrismaMcpRunPlanLoader } from "./runPlanRepository";

const DEFAULT_RUNTIME_LIMITS = {
  maxListPages: 16,
  maxToolArgumentBytes: 64 * 1_024,
  maxToolMetadataBytes: 256 * 1_024,
  maxToolResultBytes: 128 * 1_024,
  maxToolSchemaBytes: 64 * 1_024,
  maxTools: 128
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
        allowInsecureHttp: launch.trustedInternalHttp === true || process.env.NODE_ENV !== "production",
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

const loadRunPlan = createPrismaMcpRunPlanLoader();

export const defaultMcpRunPlan = {
  prepare(userId: string) {
    let coordinator: McpRuntimeCoordinator | null = null;
    const currentCoordinator = () => {
      coordinator ??= getDefaultMcpRuntimeCoordinator();
      return coordinator;
    };
    return prepareMcpRunPlan({
      isGenerationLive: (generationId) => currentCoordinator().hasLiveGeneration(generationId),
      load: () => loadRunPlan(userId),
      reconcile: () => currentCoordinator().reconcileNow(userId)
    });
  }
};
