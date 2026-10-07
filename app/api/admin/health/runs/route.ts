import { createAdminHealthRunLookupHandler } from "@/lib/server/admin/health/runLookup";
import { adminHealthRunLookup } from "@/lib/server/admin/health/runLookupDefault";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";

export const runtime = "nodejs";

export const GET = createAdminHealthRunLookupHandler({ resolveAuth: resolveRequestAuth, lookup: adminHealthRunLookup });
