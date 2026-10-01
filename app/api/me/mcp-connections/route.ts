import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { defaultMcpOperationalStatus, getDefaultMcpRuntimeCoordinator, kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createPersonalMcpCreateHandler, createPersonalMcpListHandler } from "@/lib/server/mcp/personalHandlers";
import { preparePersonalMcpOAuthDraft } from "@/lib/server/mcp/personalOAuthDiscovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const deps = {
  onConnectionChanged: (userId: string, serverId: string) => getDefaultMcpRuntimeCoordinator()
    .ensureUserServersReady(userId, [serverId], AbortSignal.timeout(20_000)),
  onRuntimeChanged: kickDefaultMcpRuntime,
  prepareOAuthDraft: preparePersonalMcpOAuthDraft,
  repository: mcpRepository,
  resolveAuth: resolveRequestAuth,
  runtimeOperationalStatus: defaultMcpOperationalStatus
};
export const GET = createPersonalMcpListHandler(deps);
export const POST = createPersonalMcpCreateHandler(deps);
