import type {
  ComposerConfigKnowledgeBase,
  ComposerConfigMcpServer,
  ComposerConfigResponse
} from "../../contracts/composerConfig";
import type { AssistantSummary } from "../../contracts/assistants";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { buildCurrentUserCatalog, type CatalogData } from "../catalog/currentUserCatalog";
import {
  getRunAttachmentLimits,
  toCatalogAttachmentLimits,
  type RunAttachmentLimits
} from "../runs/attachmentLimits";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

export type ComposerConfigHandlerDeps = Readonly<{
  listAssistants(userId: string, catalogData: CatalogData): Promise<AssistantSummary[]>;
  listKnowledgeBases(userId: string): Promise<ComposerConfigKnowledgeBase[]>;
  listMcpServers(userId: string): Promise<ComposerConfigMcpServer[]>;
  loadCatalogData(userId: string): Promise<CatalogData | null>;
  resolveAuth: RequestAuthResolver;
  resolveRunAttachmentLimits?(): RunAttachmentLimits;
}>;

function errorJson(
  error: "invalid_query" | "unauthorized" | "user_not_found",
  status: number
): Response {
  return Response.json({ error }, {
    headers: { "Cache-Control": PRIVATE_CACHE_CONTROL },
    status
  });
}

export function createComposerConfigHandler(deps: ComposerConfigHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return errorJson("unauthorized", 401);
    if (new URL(request.url).searchParams.size > 0) {
      return errorJson("invalid_query", 400);
    }

    const catalogData = await deps.loadCatalogData(auth.userId);
    if (!catalogData) return errorJson("user_not_found", 404);

    const [assistants, knowledgeBases, mcpServers] = await Promise.all([
      deps.listAssistants(auth.userId, catalogData),
      deps.listKnowledgeBases(auth.userId),
      deps.listMcpServers(auth.userId)
    ]);
    return Response.json({
      composerConfig: {
        assistants,
        catalog: {
          ...buildCurrentUserCatalog(catalogData),
          attachmentLimits: toCatalogAttachmentLimits(
            deps.resolveRunAttachmentLimits?.() ?? getRunAttachmentLimits()
          )
        },
        knowledgeBases,
        mcpServers
      }
    } satisfies ComposerConfigResponse, {
      headers: { "Cache-Control": PRIVATE_CACHE_CONTROL }
    });
  };
}
