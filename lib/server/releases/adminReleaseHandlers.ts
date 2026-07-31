import type {
  AdminReleaseStatus,
  AdminReleaseStatusErrorResponse
} from "../../contracts/adminRelease";
import type { AdminRepository } from "../auth/adminRepositoryContract";
import type { RequestAuthResolver } from "../auth/requestAuth";

export type AdminReleaseStatusHandlerDeps = Readonly<{
  readStatus(): Promise<AdminReleaseStatus>;
  repository: Pick<AdminRepository, "findAdminUser">;
  resolveAuth: RequestAuthResolver;
}>;

function errorJson(data: AdminReleaseStatusErrorResponse, status: number): Response {
  return Response.json(data, { status });
}

export function createAdminReleaseStatusHandler(deps: AdminReleaseStatusHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return errorJson({ error: "unauthorized" }, 401);

    const user = await deps.repository.findAdminUser(auth.userId);
    if (!user || user.role !== "admin" || user.status !== "active") {
      return errorJson({ error: "forbidden" }, 403);
    }

    return Response.json(await deps.readStatus());
  };
}
