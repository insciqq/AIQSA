import type { ConnectorCatalogResponse } from "@/lib/contracts/connectors";
import type { AuthConfig } from "@/lib/server/auth/config";
import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import type { McpRepository } from "@/lib/server/mcp/repositoryContract";
import { userServerProjection } from "@/lib/server/mcp/handlers";
import { connectorById, connectorDraft, listConnectorCatalog } from "./catalog";

type ConnectorDeps = {
  getConfig?: () => Pick<AuthConfig, "mcpConnectorOAuth">;
  repository: McpRepository;
  resolveAuth: RequestAuthResolver;
  runtimeOperationalStatus?: (generationId: string) => import("@/lib/contracts/mcp").McpOperationalStatus;
};
type RouteContext = { params: Promise<{ connectorId: string }> | { connectorId: string } };

function errorJson(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function connectorOAuthAction(serverId: string): string {
  return `/api/me/connectors/oauth/connect?server=${encodeURIComponent(serverId)}`;
}

export function createConnectorCatalogHandler(deps: ConnectorDeps) {
  return async function GET(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const personal = await deps.repository.listUserServers(session.userId);
    const connected = new Map(personal.flatMap((server) => server.connectorKey ? [[server.connectorKey, userServerProjection(server, deps)] as const] : []));
    const config = deps.getConfig?.();
    const configured = deps.getConfig
      ? Object.fromEntries(
        listConnectorCatalog().map((connector) => [connector.id, connector.id === "notion" || Boolean(config?.mcpConnectorOAuth[connector.id])])
      )
      : undefined;
    const connectors: ConnectorCatalogResponse["connectors"] = listConnectorCatalog(configured).map((connector) => ({
      ...connector,
      ...(connected.has(connector.id) ? { connection: connected.get(connector.id) } : {})
    })) as ConnectorCatalogResponse["connectors"];
    return Response.json({ connectors }, { headers: { "Cache-Control": "no-store" } });
  };
}

export function createConnectorConnectHandler(deps: ConnectorDeps) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const connector = connectorById((await context.params).connectorId);
    if (!connector) return errorJson("connector_not_found", 404);
    if (connector.id !== "notion" && deps.getConfig && !deps.getConfig().mcpConnectorOAuth[connector.id]) {
      return errorJson("connector_unavailable", 503);
    }
    const createPersonalServer = deps.repository.createPersonalServer;
    if (!createPersonalServer) return errorJson("connector_unavailable", 503);
    const existing = (await deps.repository.listUserServers(session.userId)).find((server) => server.connectorKey === connector.id);
    if (existing) {
      return Response.json({
        oauthAction: connectorOAuthAction(existing.id),
      server: userServerProjection(existing, deps)
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const created = await createPersonalServer({
      connectorKey: connector.id,
      description: connector.description,
      draft: connectorDraft(connector),
      name: connector.label,
      userId: session.userId,
      values: {}
    });
    if (created.kind !== "ok") return errorJson(created.kind === "draft_validation_failed" ? "connector_unavailable" : "connector_setup_failed", created.kind === "draft_validation_failed" ? 422 : 503);
    return Response.json({
      oauthAction: connectorOAuthAction(created.value.id),
      server: userServerProjection(created.value, deps)
    }, { headers: { "Cache-Control": "no-store" }, status: 201 });
  };
}

export function createConnectorDeleteHandler(deps: ConnectorDeps) {
  return async function DELETE(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const connector = connectorById((await context.params).connectorId);
    if (!connector) return errorJson("connector_not_found", 404);
    const existing = (await deps.repository.listUserServers(session.userId)).find((server) => server.connectorKey === connector.id);
    if (!existing) return errorJson("connector_not_found", 404);
    const deletePersonalServer = deps.repository.deletePersonalServer;
    if (!deletePersonalServer) return errorJson("connector_unavailable", 503);
    const deleted = await deletePersonalServer({ serverId: existing.id, userId: session.userId });
    return deleted.kind === "ok" ? Response.json({ status: "disconnected" }) : errorJson("connector_not_found", 404);
  };
}
