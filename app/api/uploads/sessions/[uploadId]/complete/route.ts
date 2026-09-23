import { workspaceUploadHandlers } from "@/lib/server/uploads/defaultWorkspaceUploads";
import type { UploadRouteContext } from "@/lib/server/uploads/workspaceUploadHandlers";

export const runtime = "nodejs";
export const POST = (request: Request, context: UploadRouteContext) => workspaceUploadHandlers().complete(request, context);
