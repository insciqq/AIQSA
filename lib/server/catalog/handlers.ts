import type { CatalogErrorResponse, CatalogResponse } from "../../contracts/catalog";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { buildCurrentUserCatalog, type CatalogData } from "./currentUserCatalog";

export { buildCurrentUserCatalog } from "./currentUserCatalog";
export type { CatalogData } from "./currentUserCatalog";

export type CatalogHandlerDeps = {
  loadCatalogData(userId: string): Promise<CatalogData | null>;
  resolveAuth: RequestAuthResolver;
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

    const response = {
      catalog: buildCurrentUserCatalog(data)
    } satisfies CatalogResponse;

    return catalogJson(response);
  };
}
