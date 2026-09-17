import { handleAnnouncement } from "@/lib/server/announcements/defaultHandlers";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return handleAnnouncement(request, "detail", true, (await context.params).id);
}
export async function PATCH(request: Request, context: Context) {
  return handleAnnouncement(request, "update", true, (await context.params).id);
}
export async function DELETE(request: Request, context: Context) {
  return handleAnnouncement(request, "delete", true, (await context.params).id);
}
