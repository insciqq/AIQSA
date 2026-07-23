import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createAdminMcpCatalogHandler, createAdminMcpCreateHandler } from "@/lib/server/mcp/handlers";

export const runtime = "nodejs";

const deps = {
  onRuntimeChanged: kickDefaultMcpRuntime,
  repository: mcpRepository,
  resolveAuth: resolveRequestAuth
};

export const GET = createAdminMcpCatalogHandler(deps);
export const POST = createAdminMcpCreateHandler(deps);
