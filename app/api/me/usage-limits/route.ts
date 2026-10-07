import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { usageLimitsRepository } from "@/lib/server/usageLimits/defaultRepository";
import { createUserUsageLimitStatusHandler } from "@/lib/server/usageLimits/userStatus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = createUserUsageLimitStatusHandler({
  repository: usageLimitsRepository,
  resolveAuth: resolveRequestAuth
});
