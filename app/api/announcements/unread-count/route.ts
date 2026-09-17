import { handleAnnouncement } from "@/lib/server/announcements/defaultHandlers";

export const runtime = "nodejs";
export const GET = (request: Request) => handleAnnouncement(request, "count");
