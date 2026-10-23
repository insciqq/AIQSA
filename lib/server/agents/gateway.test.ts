import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNNER_RELAY_PROOF_HEADER, runnerRelayProofKey, signRunnerRelayProof } from "../workspace/runnerGatewayProof";
import { handleRunnerGatewayRequest } from "../workspace/runnerGateway";
import { agentTokenHash } from "./store";
import { handleAgentGatewayRequest } from "./gateway";

const database = vi.hoisted(() => ({ agentRunBinding: { findUnique: vi.fn(async (_query: unknown) => null) } }));
vi.mock("../prisma", () => ({ prisma: database }));
// An unknown code bearer is refused by the code gateway exactly like an unknown Agent bearer.
const codeGateway = vi.hoisted(() => ({ handleWorkspaceCodeMcpRequest: vi.fn(async (_request: Request, _tokenHash: string) =>
  Response.json({ error: "agent_authorization_required" }, { status: 401 })) }));
vi.mock("../workspace/codeMcpGateway", () => codeGateway);

const runnerToken = "synthetic-runner-token-".padEnd(48, "0");
const bearer = "b".repeat(43);
const endpoints = ["v1/responses", "v1/alpha/search", "mcp"];

/** The route composes the runner gateway with the Agent's bearer handler. */
function route(request: Request, path: string) {
  return handleRunnerGatewayRequest(request, path, { agent: handleAgentGatewayRequest });
}

function gatewayRequest(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://app.invalid/api/internal/agent/${path}`, { method: "POST", body: "{}",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers } });
}

function relayProof(path: string) {
  return signRunnerRelayProof(runnerRelayProofKey(runnerToken)!, { bearer, method: "POST", path });
}

beforeEach(() => {
  vi.stubEnv("AIQSA_WORKSPACE_RUNNER_TOKEN", runnerToken);
  database.agentRunBinding.findUnique.mockClear();
  codeGateway.handleWorkspaceCodeMcpRequest.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Agent share of the runner gateway", () => {
  it("looks up the Agent binding only after the relay proof passed", async () => {
    for (const path of endpoints) {
      const response = await route(gatewayRequest(path), path);
      expect(response.status).toBe(401);
    }
    expect(database.agentRunBinding.findUnique).not.toHaveBeenCalled();
    for (const path of endpoints) {
      database.agentRunBinding.findUnique.mockClear();
      const response = await route(gatewayRequest(path, { [RUNNER_RELAY_PROOF_HEADER]: relayProof(path) }), path);
      // The synthetic bearer has no binding, so the lookup itself refuses it.
      expect(response.status).toBe(401);
      expect(database.agentRunBinding.findUnique).toHaveBeenCalledOnce();
      expect(database.agentRunBinding.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: agentTokenHash(bearer) } }));
    }
  });

  it("leaves a bearer that is no Agent grant to the code gateway on MCP only, never model or Search", async () => {
    for (const path of ["v1/responses", "v1/alpha/search"]) {
      const response = await route(gatewayRequest(path, { [RUNNER_RELAY_PROOF_HEADER]: relayProof(path) }), path);
      expect(response.status).toBe(401);
    }
    expect(codeGateway.handleWorkspaceCodeMcpRequest).not.toHaveBeenCalled();
    codeGateway.handleWorkspaceCodeMcpRequest.mockResolvedValueOnce(Response.json({ ok: true }));
    const request = gatewayRequest("mcp", { [RUNNER_RELAY_PROOF_HEADER]: relayProof("mcp") });
    const response = await route(request, "mcp");
    expect(response.status).toBe(200);
    expect(codeGateway.handleWorkspaceCodeMcpRequest).toHaveBeenCalledWith(request, agentTokenHash(bearer));
  });

  it("refuses a failed binding lookup without falling through to the code gateway", async () => {
    database.agentRunBinding.findUnique.mockRejectedValueOnce(new Error("database_unavailable"));
    const response = await route(gatewayRequest("mcp", { [RUNNER_RELAY_PROOF_HEADER]: relayProof("mcp") }), "mcp");
    expect(response.status).toBe(401);
    expect(codeGateway.handleWorkspaceCodeMcpRequest).not.toHaveBeenCalled();
  });
});
