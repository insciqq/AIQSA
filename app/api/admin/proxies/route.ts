import { handleProxy } from "@/lib/server/proxies/defaultHandlers";

export const runtime = "nodejs";
export const GET = (request: Request) => handleProxy(request, "list", "administrator");
export const POST = (request: Request) => handleProxy(request, "create", "administrator");
