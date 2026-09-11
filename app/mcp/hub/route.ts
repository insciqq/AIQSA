import { createMcpHubHandler } from "@/lib/server/mcp/hubHandler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = createMcpHubHandler();

export async function GET(request: Request): Promise<Response> {
  return handler.GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return handler.POST(request);
}
