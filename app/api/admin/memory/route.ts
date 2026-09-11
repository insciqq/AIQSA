import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { defaultAdminMemoryStatusService } from "@/lib/server/admin/memory/statusDefault";
import { createAdminMemoryStatusHandlers } from "@/lib/server/admin/memory/statusHandlers";
const statusHandlers = createAdminMemoryStatusHandlers({
  resolveAuth: resolveRequestAuth,
  service: defaultAdminMemoryStatusService
});

export const runtime = "nodejs";

export const GET = statusHandlers.GET;
export const POST = statusHandlers.POST;
export const PUT = statusHandlers.PUT;
