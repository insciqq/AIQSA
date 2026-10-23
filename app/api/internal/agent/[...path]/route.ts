import { handleRunnerGatewayRequest } from "@/lib/server/workspace/runnerGateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return handleRunnerGatewayRequest(request, (await context.params).path.join("/"));
}
