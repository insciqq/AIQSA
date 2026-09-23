import { workspaceUploadHandlers } from "@/lib/server/uploads/defaultWorkspaceUploads";
import type { UploadRouteContext } from "@/lib/server/uploads/workspaceUploadHandlers";

export const runtime = "nodejs";
// This exact route bypasses Next Proxy body cloning. The shared handler applies
// origin, session, target, concurrency and streaming byte guards before reading.
export const PUT = (request: Request, context: UploadRouteContext) => workspaceUploadHandlers().part(request, context);
