import { workspaceUploadHandlers } from "@/lib/server/uploads/defaultWorkspaceUploads";
import type { UploadRouteContext } from "@/lib/server/uploads/workspaceUploadHandlers";

export const runtime = "nodejs";
export const GET = (request: Request, context: UploadRouteContext) => workspaceUploadHandlers().get(request, context);
export const DELETE = (request: Request, context: UploadRouteContext) => workspaceUploadHandlers().cancel(request, context);
