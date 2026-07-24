import { adminRunProfileHandlerDeps } from "@/lib/server/admin/runProfiles/defaultRunProfiles";
import {
  createAdminRunProfileCatalogHandler,
  createAdminRunProfileUpdateHandler
} from "@/lib/server/admin/runProfiles/handlers";

export const runtime = "nodejs";

export const GET = createAdminRunProfileCatalogHandler(adminRunProfileHandlerDeps);
export const PUT = createAdminRunProfileUpdateHandler(adminRunProfileHandlerDeps);
