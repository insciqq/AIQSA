import type { FetchLike, OAuthClientProvider } from "@modelcontextprotocol/client";
import type { McpClientCredentialsAuthProvider } from "./clientCredentials";
import {
  McpClientSession,
  McpClientSessionError,
  type McpClientSessionLimits
} from "./clientSession";
import { redactMcpToolCallResult } from "./resultRedaction";
import type { McpCallResultCeiling } from "./responseGuard";
import type { McpResponseWireLimits } from "./responseLimits";
import type { McpRuntimeLaunch, McpRuntimeSessionFactory } from "./runtimeCoordinator";

export function createMcpClientSessionFactory(input: Readonly<{
  authProviderForLaunch?: (launch: McpRuntimeLaunch) => Promise<OAuthClientProvider | undefined>;
  callResultCeiling?: McpCallResultCeiling;
  /** The installation sign-in of a client-credentials launch; its tokens are shared per server. */
  clientCredentialsProviderForLaunch?: (launch: McpRuntimeLaunch) => McpClientCredentialsAuthProvider | undefined;
  fetch: FetchLike;
  fetchForLaunch?: (launch: McpRuntimeLaunch) => FetchLike | Promise<FetchLike>;
  limits: McpClientSessionLimits;
  responseLimits?: Partial<McpResponseWireLimits>;
}>): McpRuntimeSessionFactory {
  return {
    async create(launch) {
      launch.signal?.throwIfAborted();
      let url: URL;
      try {
        if (!launch.url) throw new Error("invalid direct launch");
        url = new URL(launch.url);
      } catch {
        throw new McpClientSessionError({
          code: "mcp_session_configuration_invalid",
          operation: "session"
        });
      }

      const oauthProvider = launch.oauthConnectionId
        ? await input.authProviderForLaunch?.(launch)
        : undefined;
      const clientCredentials = launch.clientCredentials
        ? input.clientCredentialsProviderForLaunch?.(launch)
        : undefined;
      if ((launch.oauthConnectionId && !oauthProvider) || (launch.clientCredentials && !clientCredentials) ||
        (launch.oauthConnectionId && launch.clientCredentials)) {
        throw new McpClientSessionError({
          code: "mcp_session_configuration_invalid",
          operation: "session"
        });
      }
      if (clientCredentials) {
        // Sign in before connecting, so a refused or unreachable token
        // endpoint fails the launch with its own code.
        await clientCredentials.token();
        launch.signal?.throwIfAborted();
      }
      const authProvider = oauthProvider ?? clientCredentials;
      // The exact secrets a result may echo: the sign-in's, or what the OAuth provider reports.
      const exactKnownSecrets = (): readonly string[] => {
        if (clientCredentials) return clientCredentials.exactKnownSecrets();
        if (!oauthProvider || !("exactKnownSecrets" in oauthProvider) ||
          typeof oauthProvider.exactKnownSecrets !== "function") return [];
        const values: unknown = oauthProvider.exactKnownSecrets.call(oauthProvider);
        return Array.isArray(values)
          ? values.filter((value): value is string => typeof value === "string")
          : [];
      };
      const launchFetch = await input.fetchForLaunch?.(launch) ?? input.fetch;
      const session = new McpClientSession({
        ...(authProvider ? { authProvider } : {}),
        ...(input.callResultCeiling ? { callResultCeiling: input.callResultCeiling } : {}),
        fetch: clientCredentials ? clientCredentials.observeFetch(launchFetch) : launchFetch,
        headers: launch.headers,
        limits: input.limits,
        onInventoryStale: launch.onToolsChanged,
        requestTimeoutMs: launch.callTimeoutMs,
        ...(input.responseLimits ? { responseLimits: input.responseLimits } : {}),
        url
      });
      try {
        launch.signal?.throwIfAborted();
        await session.initialize({ signal: launch.signal, timeoutMs: launch.startupTimeoutMs });
        launch.signal?.throwIfAborted();
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
            return redactMcpToolCallResult(result, exactKnownSecrets());
          } catch {
            throw new McpClientSessionError({
              code: "mcp_call_result_invalid",
              operation: "call_tool"
            });
          }
        },
        fatalResponseErrorCode: () => session.fatalResponseErrorCode(),
        close: () => session.close(),
        exactKnownSecrets: () => [...exactKnownSecrets()],
        isClosed: () => session.isClosed(),
        ping: (options) => session.ping(options),
        async listTools(signal, options) {
          return [...await session.listAllTools({
            ...(signal ? { signal } : {}),
            timeoutMs: options?.requestTimeoutMs ?? launch.callTimeoutMs
          })];
        },
        serverEvidence: () => session.serverEvidence
      };
    }
  };
}
