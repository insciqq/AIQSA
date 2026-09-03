import {
  MEMORY_MCP_CONNECTED_APPS_MAX,
  decodeMemoryMcpConnectionId,
  memoryMcpConnectedAppResponseSchema,
  memoryMcpConnectedAppsResponseSchema,
  type MemoryMcpConnectedApp
} from "../../contracts/memoryMcpConnectedApps";
import type { RequestAuthResolver } from "../auth/requestAuth";
import type { InboundMcpConnectedApp } from "./oauth/repository";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

export type ConnectedAppsService = Readonly<{
  listConnectedApps(userId: string): Promise<readonly InboundMcpConnectedApp[]>;
  revokeConnectedApp(userId: string, grantId: string): Promise<boolean>;
}>;

type ConnectedAppsHandlerDeps = Readonly<{
  resolveAuth: RequestAuthResolver;
  service: ConnectedAppsService;
}>;

type ConnectionRouteContext = Readonly<{
  params: Promise<{ connectionId: string }> | { connectionId: string };
}>;

function json(body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

function hasNoSearchParams(request: Request): boolean {
  return [...new URL(request.url).searchParams].length === 0;
}

function project(app: InboundMcpConnectedApp): MemoryMcpConnectedApp {
  return {
    connectionId: app.grantId,
    clientName: app.clientName,
    clientOrigin: app.clientOrigin,
    connectedAt: app.connectedAt.toISOString(),
    lastUsedAt: app.lastUsedAt?.toISOString() ?? null,
    revokedAt: app.revokedAt?.toISOString() ?? null,
    state: app.state
  };
}

function safeList(apps: readonly InboundMcpConnectedApp[]) {
  return memoryMcpConnectedAppsResponseSchema.parse({
    apps: apps.slice(0, MEMORY_MCP_CONNECTED_APPS_MAX).map(project)
  });
}

export function createListMemoryMcpConnectedAppsHandler(
  deps: ConnectedAppsHandlerDeps
) {
  return async function GET(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "connected_apps_contract_invalid" }, 400);
    }
    try {
      return json(safeList(await deps.service.listConnectedApps(session.userId)));
    } catch {
      return json({ error: "connected_apps_unavailable" }, 500);
    }
  };
}

export function createRevokeMemoryMcpConnectedAppHandler(
  deps: ConnectedAppsHandlerDeps
) {
  return async function DELETE(
    request: Request,
    context: ConnectionRouteContext
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "connected_apps_contract_invalid" }, 400);
    }
    const connectionId = decodeMemoryMcpConnectionId(
      (await context.params).connectionId
    );
    if (!connectionId) {
      return json({ error: "connected_apps_contract_invalid" }, 400);
    }
    try {
      const revoked = await deps.service.revokeConnectedApp(
        session.userId,
        connectionId
      );
      if (!revoked) return json({ error: "connected_app_not_found" }, 404);
      const app = (await deps.service.listConnectedApps(session.userId))
        .find((candidate) => candidate.grantId === connectionId);
      if (!app) return json({ error: "connected_apps_unavailable" }, 500);
      return json(memoryMcpConnectedAppResponseSchema.parse({ app: project(app) }));
    } catch {
      return json({ error: "connected_apps_unavailable" }, 500);
    }
  };
}
