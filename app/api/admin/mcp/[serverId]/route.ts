import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createAdminMcpDeleteHandler, createAdminMcpUpdateHandler } from "@/lib/server/mcp/handlers";

export const runtime = "nodejs";

const deps = {
  onRuntimeChanged: kickDefaultMcpRuntime,
  repository: mcpRepository,
  resolveAuth: resolveRequestAuth
};

export const DELETE = createAdminMcpDeleteHandler(deps);
export const PATCH = createAdminMcpUpdateHandler(deps);
