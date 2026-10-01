import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { getAuthConfig } from "@/lib/server/auth/config";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { createConnectorConnectHandler, createConnectorDeleteHandler } from "@/lib/server/connectors/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const deps = { getConfig: () => getAuthConfig(), repository: mcpRepository, resolveAuth: resolveRequestAuth };
export const POST: AsyncRouteHandler<ReturnType<typeof createConnectorConnectHandler>> = createConnectorConnectHandler(deps);
export const DELETE: AsyncRouteHandler<ReturnType<typeof createConnectorDeleteHandler>> = createConnectorDeleteHandler(deps);
