import { workspaceUploadHandlers } from "@/lib/server/uploads/defaultWorkspaceUploads";

export const runtime = "nodejs";
export const GET = (request: Request) => workspaceUploadHandlers().config(request);
export const POST = (request: Request) => workspaceUploadHandlers().create(request);
