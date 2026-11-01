import { handleProxy } from "@/lib/server/proxies/defaultHandlers";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  return handleProxy(request, "check", "personal", (await context.params).id);
}
