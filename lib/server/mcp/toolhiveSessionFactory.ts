import type {
  McpRuntimeSession,
  McpRuntimeSessionFactory
} from "./runtimeCoordinator";
import type { ToolHiveMcpRuntimeDriver } from "./toolhiveRuntimeDriver";

type ToolHiveSessionDriver = Pick<
  ToolHiveMcpRuntimeDriver,
  "deleteOwnedWorkload" | "ensureReadyWorkload"
>;

export function createToolHiveMcpSessionFactory(input: Readonly<{
  directSessions: McpRuntimeSessionFactory;
  driver: ToolHiveSessionDriver;
}>): McpRuntimeSessionFactory {
  return {
    async create(launch) {
      if (!launch.toolHive) return input.directSessions.create(launch);
      const local = launch.toolHive;
      const session: { current?: McpRuntimeSession } = {};
      try {
        await input.driver.ensureReadyWorkload({
          cmdArguments: local.cmdArguments,
          envVars: local.envVars,
          generationToken: local.generationToken,
          image: local.image
        }, {
          probe: async (url) => {
            await launch.onConnecting?.();
            const candidate = await input.directSessions.create({
              ...launch,
              allowPrivateNetwork: true,
              headers: {},
              trustedInternalHttp: true,
              toolHive: undefined,
              url
            });
            session.current = candidate;
          },
          timeoutMs: launch.startupTimeoutMs
        });
      } catch (error) {
        await session.current?.close().catch(() => undefined);
        throw error;
      }
      if (!session.current) throw new Error("mcp_toolhive_session_unavailable");

      const active = session.current;
      return {
        callTool: (request) => active.callTool(request),
        close: () => active.close(),
        async dispose() {
          await active.close().catch(() => undefined);
          await input.driver.deleteOwnedWorkload(local.generationToken).catch(() => undefined);
        },
        exactKnownSecrets: () => active.exactKnownSecrets?.() ?? [],
        fatalResponseErrorCode: () => active.fatalResponseErrorCode?.() ?? null,
        isClosed: () => active.isClosed?.() ?? false,
        listTools: (signal) => active.listTools(signal),
        serverEvidence: () => active.serverEvidence?.() ?? null
      };
    }
  };
}
