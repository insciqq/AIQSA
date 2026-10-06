import { adminUsageLimitsHandlers } from "@/lib/server/usageLimits/defaultHandlers";

export const runtime = "nodejs";
type Context = { params: Promise<{ groupId: string }> };
export async function PUT(request: Request, context: Context) {
  return adminUsageLimitsHandlers.putGroup(request, (await context.params).groupId);
}
