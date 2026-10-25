import { defaultScheduledTaskWebhookIntake } from "@/lib/server/scheduledTasks/defaultWebhookIntake";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** An automation webhook's event; the token travels only in a header (`webhookIntake.ts`). */
export async function POST(request: Request, context: { params: Promise<{ publicId: string }> }) {
  return defaultScheduledTaskWebhookIntake(request, (await context.params).publicId);
}
