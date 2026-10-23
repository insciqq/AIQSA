import { handleWorkspaceCodeMcpRequest } from "./codeMcpGateway";
import { workspaceCodeTokenHash } from "./codeMcpStore";
import { RUNNER_RELAY_PROOF_HEADER, runnerRelayProofKey, verifyRunnerRelayProof } from "./runnerGatewayProof";

const refused = () => Response.json({ error: "agent_authorization_required" }, { status: 401 });

/**
 * App side of the runner gateway (`/api/internal/agent/*`). Works across
 * app/worker processes. Only requests relayed by the Workspace runner carry a
 * valid relay proof; any other request is refused before its bearer is looked
 * up, like a bad bearer. The bearer may only be a Workspace code grant, served
 * on MCP and nowhere else.
 */
export async function handleRunnerGatewayRequest(request: Request, path: string): Promise<Response> {
  const auth = request.headers.get("authorization");
  const token = auth?.match(/^Bearer ([a-zA-Z0-9_-]{43})$/u)?.[1];
  if (!token || request.headers.has("origin") || !verifyRunnerRelayProof(
    runnerRelayProofKey(process.env.AIQSA_WORKSPACE_RUNNER_TOKEN), request.headers.get(RUNNER_RELAY_PROOF_HEADER),
    { bearer: token, method: request.method, path })) return refused();
  try {
    if (request.method === "POST" && path === "mcp") return await handleWorkspaceCodeMcpRequest(request, workspaceCodeTokenHash(token));
    return refused();
  } catch {
    return refused();
  }
}
