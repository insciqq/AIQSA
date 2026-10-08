import type { CatalogErrorResponse, CatalogResponse } from "../../contracts/catalog";
import type { CatalogDictation } from "../../contracts/speechToText";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  getRunAttachmentLimits,
  toCatalogAttachmentLimits,
  type RunAttachmentLimits
} from "../runs/attachmentLimits";
import { buildCurrentUserCatalog, type CatalogData } from "./currentUserCatalog";
import { withImageRoutes, type ImageRouteFacts } from "./imageRoutes";

export { buildCurrentUserCatalog } from "./currentUserCatalog";
export type { CatalogData } from "./currentUserCatalog";

export type CatalogHandlerDeps = {
  /** The image routes this user's chats can use; absent leaves only each model's own image input. */
  resolveImageRoutes?(userId: string): Promise<ImageRouteFacts>;
  loadCatalogData(userId: string): Promise<CatalogData | null>;
  /** Voice dictation for the account; absent omits it (no microphone), a failed read shows it unavailable. */
  resolveDictation?(): Promise<CatalogDictation>;
  resolveAuth: RequestAuthResolver;
  resolveRunAttachmentLimits?(): RunAttachmentLimits;
};

function catalogErrorJson(data: CatalogErrorResponse, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function catalogJson(data: CatalogResponse, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export function createCatalogHandler(deps: CatalogHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return catalogErrorJson({ error: "unauthorized" }, { status: 401 });
    }

    const data = await deps.loadCatalogData(auth.userId);

    if (!data) {
      return catalogErrorJson({ error: "user_not_found" }, { status: 404 });
    }

    const imageRoutes = await deps.resolveImageRoutes?.(auth.userId);
    const catalog = buildCurrentUserCatalog(data);
    if (imageRoutes) catalog.models = catalog.models.map((model) => withImageRoutes(model, imageRoutes));
    const dictation = deps.resolveDictation
      ? await deps.resolveDictation().catch((): CatalogDictation => ({ available: false, unavailableReason: "unavailable" }))
      : undefined;
    const response = {
      catalog: {
        ...catalog,
        ...(dictation ? { dictation } : {}),
        attachmentLimits: toCatalogAttachmentLimits(
          deps.resolveRunAttachmentLimits?.() ?? getRunAttachmentLimits()
        )
      }
    } satisfies CatalogResponse;

    return catalogJson(response);
  };
}
