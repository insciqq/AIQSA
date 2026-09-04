import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { defaultMcpOperationalStatus } from "@/lib/server/mcp/defaultRuntime";
import { createUserMcpCatalogHandler } from "@/lib/server/mcp/handlers";

export const runtime = "nodejs";

export const GET = createUserMcpCatalogHandler({
  runtimeOperationalStatus: defaultMcpOperationalStatus,
  repository: mcpRepository,
  resolveAuth: resolveRequestAuth
});
