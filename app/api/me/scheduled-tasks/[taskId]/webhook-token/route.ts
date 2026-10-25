import { defaultScheduledTaskHandlers } from "@/lib/server/scheduledTasks/defaultScheduledTasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Get token and Rotate token: issues a new webhook token, replacing any earlier one. */
export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return defaultScheduledTaskHandlers.issueWebhookToken(request, (await context.params).taskId);
}
