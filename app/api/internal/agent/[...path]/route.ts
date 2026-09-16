import { handleAgentGatewayRequest } from "@/lib/server/agents/gateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return handleAgentGatewayRequest(request, (await context.params).path.join("/"));
}
