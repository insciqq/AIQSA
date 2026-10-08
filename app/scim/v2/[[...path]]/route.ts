import { defaultScimHandler } from "@/lib/server/auth/scim/default";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ScimRouteContext = { params: Promise<{ path?: string[] }> };

async function handle(request: Request, context: ScimRouteContext): Promise<Response> {
  return defaultScimHandler(request, (await context.params).path ?? []);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
