import { handleProxy } from "@/lib/server/proxies/defaultHandlers";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  return handleProxy(request, "update", "administrator", (await context.params).id);
}
export async function DELETE(request: Request, context: Context) {
  return handleProxy(request, "delete", "administrator", (await context.params).id);
}
