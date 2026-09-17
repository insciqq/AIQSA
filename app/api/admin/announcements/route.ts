import { handleAnnouncement } from "@/lib/server/announcements/defaultHandlers";
export const runtime = "nodejs";
export const GET = (request: Request) => handleAnnouncement(request, "list", true);
export const POST = (request: Request) => handleAnnouncement(request, "create", true);
