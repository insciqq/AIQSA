import { defaultScheduledTaskHandlers } from "@/lib/server/scheduledTasks/defaultScheduledTasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return defaultScheduledTaskHandlers.markSeen(request, (await context.params).taskId);
}
