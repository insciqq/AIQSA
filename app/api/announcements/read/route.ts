import { handleAnnouncement } from "@/lib/server/announcements/defaultHandlers";
export const runtime = "nodejs";
export const POST = (request: Request) => handleAnnouncement(request, "read");
