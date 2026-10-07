import { adminUsageLimitsHandlers } from "@/lib/server/usageLimits/defaultHandlers";

export const runtime = "nodejs";
type Context = { params: Promise<{ userId: string }> };
export async function PUT(request: Request, context: Context) {
  return adminUsageLimitsHandlers.putUser(request, (await context.params).userId);
}
export async function DELETE(request: Request, context: Context) {
  return adminUsageLimitsHandlers.deleteUser(request, (await context.params).userId);
}
