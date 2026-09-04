import type { FetchLike, OAuthClientProvider } from "@modelcontextprotocol/client";
import {
  McpClientSession,
  McpClientSessionError,
  type McpClientSessionLimits
} from "./clientSession";
import { redactMcpToolCallResult } from "./resultRedaction";
import type { McpResponseWireLimits } from "./responseLimits";
import type { McpRuntimeLaunch, McpRuntimeSessionFactory } from "./runtimeCoordinator";

export function createMcpClientSessionFactory(input: Readonly<{
  authProviderForLaunch?: (launch: McpRuntimeLaunch) => Promise<OAuthClientProvider | undefined>;
  fetch: FetchLike;
  fetchForLaunch?: (launch: McpRuntimeLaunch) => FetchLike | Promise<FetchLike>;
  limits: McpClientSessionLimits;
  responseLimits?: Partial<McpResponseWireLimits>;
}>): McpRuntimeSessionFactory {
  return {
    async create(launch) {
      let url: URL;
      try {
        if (!launch.url || launch.toolHive) throw new Error("invalid direct launch");
        if (launch.oauthConnectionId && launch.trustedInternalHttp) throw new Error("invalid local oauth launch");
        url = new URL(launch.url);
      } catch {
        throw new McpClientSessionError({
          code: "mcp_session_configuration_invalid",
          operation: "session"
        });
      }

      const authProvider = launch.oauthConnectionId
        ? await input.authProviderForLaunch?.(launch)
        : undefined;
      if (launch.oauthConnectionId && !authProvider) {
        throw new McpClientSessionError({
          code: "mcp_session_configuration_invalid",
          operation: "session"
        });
      }
      const session = new McpClientSession({
        ...(authProvider ? { authProvider } : {}),
        fetch: await input.fetchForLaunch?.(launch) ?? input.fetch,
        headers: launch.headers,
        limits: input.limits,
        onInventoryStale: launch.onToolsChanged,
        requestTimeoutMs: launch.callTimeoutMs,
        ...(input.responseLimits ? { responseLimits: input.responseLimits } : {}),
        url
      });
      try {
        await session.initialize({ timeoutMs: launch.startupTimeoutMs });
      } catch (error) {
        await session.close();
        throw error;
      }

      return {
        async callTool({ arguments: toolArguments, name, signal }) {
          const result = await session.callTool(name, toolArguments, {
            ...(signal ? { signal } : {}),
            timeoutMs: launch.callTimeoutMs
          });
          try {
            const exactKnownSecrets = authProvider && "exactKnownSecrets" in authProvider &&
              typeof authProvider.exactKnownSecrets === "function"
              ? authProvider.exactKnownSecrets.call(authProvider)
              : [];
            return redactMcpToolCallResult(
              result,
              Array.isArray(exactKnownSecrets)
                ? exactKnownSecrets.filter((value): value is string => typeof value === "string")
                : []
            );
          } catch {
            throw new McpClientSessionError({
              code: "mcp_call_result_invalid",
              operation: "call_tool"
            });
          }
        },
        fatalResponseErrorCode: () => session.fatalResponseErrorCode(),
        close: () => session.close(),
        exactKnownSecrets() {
          if (!authProvider || !("exactKnownSecrets" in authProvider) ||
            typeof authProvider.exactKnownSecrets !== "function") return [];
          const values = authProvider.exactKnownSecrets.call(authProvider);
          return Array.isArray(values)
            ? values.filter((value): value is string => typeof value === "string")
            : [];
        },
        isClosed: () => session.isClosed(),
        ping: (options) => session.ping(options),
        async listTools(signal) {
          return [...await session.listAllTools({
            ...(signal ? { signal } : {}),
            timeoutMs: launch.callTimeoutMs
          })];
        },
        serverEvidence: () => session.serverEvidence
      };
    }
  };
}
