import { handleAnnouncement } from "@/lib/server/announcements/defaultHandlers";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAnnouncement(request, "detail", false, (await context.params).id);
}
