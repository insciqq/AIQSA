import { adminUsageLimitsHandlers } from "@/lib/server/usageLimits/defaultHandlers";

export const runtime = "nodejs";
export const PATCH = adminUsageLimitsHandlers.updateInstallation;
