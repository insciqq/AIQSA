import { defaultMemoryMcpHandler } from "../../lib/server/memoryMcp/default";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return defaultMemoryMcpHandler.GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return defaultMemoryMcpHandler.POST(request);
}
