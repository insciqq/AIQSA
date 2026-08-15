import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { defaultMemoryHealthService } from "@/lib/server/memory/health/prismaHealth";
import { createGetMemoryHealthHandler } from "@/lib/server/memory/health/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createGetMemoryHealthHandler({
  resolveAuth: resolveRequestAuth,
  service: defaultMemoryHealthService
});
