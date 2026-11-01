import { handleProxy } from "@/lib/server/proxies/defaultHandlers";

export const runtime = "nodejs";
export const GET = (request: Request) => handleProxy(request, "list", "personal");
export const POST = (request: Request) => handleProxy(request, "create", "personal");
