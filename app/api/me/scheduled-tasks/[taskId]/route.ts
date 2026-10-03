import { defaultScheduledTaskHandlers } from "@/lib/server/scheduledTasks/defaultScheduledTasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ taskId: string }> };

export async function GET(request: Request, context: Context) {
  return defaultScheduledTaskHandlers.detail(request, (await context.params).taskId);
}
export async function PATCH(request: Request, context: Context) {
  return defaultScheduledTaskHandlers.update(request, (await context.params).taskId);
}
export async function DELETE(request: Request, context: Context) {
  return defaultScheduledTaskHandlers.remove(request, (await context.params).taskId);
}
