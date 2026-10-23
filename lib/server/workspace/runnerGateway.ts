import { handleWorkspaceCodeMcpRequest } from "./codeMcpGateway";
import { workspaceCodeTokenHash } from "./codeMcpStore";
import { RUNNER_RELAY_PROOF_HEADER, runnerRelayProofKey, verifyRunnerRelayProof } from "./runnerGatewayProof";

/**
 * Serves a run bearer of another gateway client (the Codex Agent's run
 * grants) and returns null when the bearer is not one of its grants. It runs
 * only after the relay proof passed.
 */
export type RunnerGatewayBearerHandler = (request: Request, path: string, bearer: string) => Promise<Response | null>;

const refused = () => Response.json({ error: "agent_authorization_required" }, { status: 401 });

/**
 * App side of the runner gateway (`/api/internal/agent/*`). Works across
 * app/worker processes. Only requests relayed by the Workspace runner carry a
 * valid relay proof; any other request is refused before its bearer is looked
 * up, like a bad bearer. A bearer that no other handler serves may be a
 * Workspace code grant: MCP only, never the model or Search endpoints.
 */
export async function handleRunnerGatewayRequest(
  request: Request,
  path: string,
  options: Readonly<{ agent?: RunnerGatewayBearerHandler }> = {}
): Promise<Response> {
  const auth = request.headers.get("authorization");
  const token = auth?.match(/^Bearer ([a-zA-Z0-9_-]{43})$/u)?.[1];
  if (!token || request.headers.has("origin") || !verifyRunnerRelayProof(
    runnerRelayProofKey(process.env.AIQSA_WORKSPACE_RUNNER_TOKEN), request.headers.get(RUNNER_RELAY_PROOF_HEADER),
    { bearer: token, method: request.method, path })) return refused();
  try {
    const served = options.agent ? await options.agent(request, path, token) : null;
    if (served) return served;
    if (request.method === "POST" && path === "mcp") return await handleWorkspaceCodeMcpRequest(request, workspaceCodeTokenHash(token));
    return refused();
  } catch {
    return refused();
  }
}
