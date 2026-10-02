import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { createUserMcpCatalogHandler } from "@/lib/server/mcp/handlers";

export const runtime = "nodejs";

export const GET = createUserMcpCatalogHandler({
  repository: mcpRepository,
  resolveAuth: resolveRequestAuth
});
