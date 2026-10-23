import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunnerGatewayRelay } from "./runnerGatewayRelay";
import { RUNNER_RELAY_PROOF_HEADER, runnerRelayProofKey, signRunnerRelayProof } from "./runnerGatewayProof";
import { workspaceCodeTokenHash } from "./codeMcpStore";
import { handleRunnerGatewayRequest, type RunnerGatewayBearerHandler } from "./runnerGateway";

// An unknown code bearer is refused by the code gateway exactly like any unknown bearer.
const codeGateway = vi.hoisted(() => ({ handleWorkspaceCodeMcpRequest: vi.fn(async (_request: Request, _tokenHash: string) =>
  Response.json({ error: "agent_authorization_required" }, { status: 401 })) }));
vi.mock("./codeMcpGateway", () => codeGateway);

const runnerToken = "synthetic-runner-token-".padEnd(48, "0");
const bearer = "b".repeat(43);
const endpoints = ["v1/responses", "v1/alpha/search", "mcp"];
// Stands in for another gateway client (the Codex Agent) that knows no grant for the bearer.
const agent = vi.fn<RunnerGatewayBearerHandler>(async () => null);

function gatewayRequest(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://app.invalid/api/internal/agent/${path}`, { method: "POST", body: "{}",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers } });
}

function relayProof(input: Readonly<{ bearer?: string; nowMs?: number; path?: string; token?: string }> = {}) {
  return signRunnerRelayProof(runnerRelayProofKey(input.token ?? runnerToken)!,
    { bearer: input.bearer ?? bearer, method: "POST", path: input.path ?? "v1/responses" }, input.nowMs);
}

async function expectRefusedBeforeLookup(request: Request, path = "v1/responses") {
  const response = await handleRunnerGatewayRequest(request, path, { agent });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "agent_authorization_required" });
  expect(agent).not.toHaveBeenCalled();
  expect(codeGateway.handleWorkspaceCodeMcpRequest).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv("AIQSA_WORKSPACE_RUNNER_TOKEN", runnerToken);
  agent.mockClear();
  codeGateway.handleWorkspaceCodeMcpRequest.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runner gateway ingress", () => {
  it("refuses a direct request with a well-formed bearer but no relay proof, exactly like a bad bearer", async () => {
    for (const path of endpoints) await expectRefusedBeforeLookup(gatewayRequest(path), path);
    await expectRefusedBeforeLookup(gatewayRequest("v1/responses",
      { authorization: "Bearer not-a-run-bearer", [RUNNER_RELAY_PROOF_HEADER]: relayProof() }));
  });

  it("hands the bearer on only once a current relay proof for that endpoint is present", async () => {
    for (const path of endpoints) {
      agent.mockClear();
      const response = await handleRunnerGatewayRequest(gatewayRequest(path, { [RUNNER_RELAY_PROOF_HEADER]: relayProof({ path }) }), path, { agent });
      expect(response.status).toBe(401);
      expect(agent).toHaveBeenCalledOnce();
      expect(agent).toHaveBeenCalledWith(expect.any(Request), path, bearer);
    }
  });

  it("refuses spoofed, garbled, replayed or foreign proofs before any lookup", async () => {
    // Exact skew boundaries are pinned in runnerGatewayProof.test.ts with a fixed clock.
    const now = Date.now();
    const guessedKeyProof = relayProof({ token: "guest-guessed-runner-token-".padEnd(48, "0") });
    for (const proof of ["v1", "v1.1791374400.guest-supplied-proof", `${relayProof()}, ${relayProof()}`, guessedKeyProof,
      relayProof({ nowMs: now - 120_000 }), relayProof({ nowMs: now + 120_000 }),
      relayProof({ path: "mcp" }), relayProof({ bearer: "c".repeat(43) })]) {
      await expectRefusedBeforeLookup(gatewayRequest("v1/responses", { [RUNNER_RELAY_PROOF_HEADER]: proof }));
    }
    await expectRefusedBeforeLookup(gatewayRequest("v1/responses",
      { [RUNNER_RELAY_PROOF_HEADER]: relayProof(), origin: "https://public.example" }));
  });

  it("serves an unclaimed bearer only as a Workspace code bearer on MCP, never model or Search", async () => {
    for (const path of ["v1/responses", "v1/alpha/search"]) {
      const response = await handleRunnerGatewayRequest(gatewayRequest(path, { [RUNNER_RELAY_PROOF_HEADER]: relayProof({ path }) }), path);
      expect(response.status).toBe(401);
    }
    expect(codeGateway.handleWorkspaceCodeMcpRequest).not.toHaveBeenCalled();
    codeGateway.handleWorkspaceCodeMcpRequest.mockResolvedValueOnce(Response.json({ ok: true }));
    const request = gatewayRequest("mcp", { [RUNNER_RELAY_PROOF_HEADER]: relayProof({ path: "mcp" }) });
    // Without any other gateway client the code gateway still answers alone.
    const response = await handleRunnerGatewayRequest(request, "mcp");
    expect(response.status).toBe(200);
    expect(codeGateway.handleWorkspaceCodeMcpRequest).toHaveBeenCalledWith(request, workspaceCodeTokenHash(bearer));
    codeGateway.handleWorkspaceCodeMcpRequest.mockClear();
    await expectRefusedBeforeLookup(gatewayRequest("mcp"), "mcp");
    await expectRefusedBeforeLookup(gatewayRequest("mcp", { [RUNNER_RELAY_PROOF_HEADER]: relayProof({ path: "mcp" }),
      origin: "https://public.example" }), "mcp");
  });

  it("lets a claimed bearer's handler answer and never reaches the code gateway for it", async () => {
    agent.mockResolvedValueOnce(Response.json({ agent: true }));
    const response = await handleRunnerGatewayRequest(gatewayRequest("mcp", { [RUNNER_RELAY_PROOF_HEADER]: relayProof({ path: "mcp" }) }),
      "mcp", { agent });
    expect(await response.json()).toEqual({ agent: true });
    expect(codeGateway.handleWorkspaceCodeMcpRequest).not.toHaveBeenCalled();
    agent.mockRejectedValueOnce(new Error("lookup_failed"));
    const failed = await handleRunnerGatewayRequest(gatewayRequest("mcp", { [RUNNER_RELAY_PROOF_HEADER]: relayProof({ path: "mcp" }) }),
      "mcp", { agent });
    expect(failed.status).toBe(401);
    expect(codeGateway.handleWorkspaceCodeMcpRequest).not.toHaveBeenCalled();
  });

  it("refuses every request when the app has no runner token", async () => {
    for (const value of [undefined, "", "   "]) {
      vi.stubEnv("AIQSA_WORKSPACE_RUNNER_TOKEN", value);
      await expectRefusedBeforeLookup(gatewayRequest("mcp", { [RUNNER_RELAY_PROOF_HEADER]: relayProof({ path: "mcp" }) }), "mcp");
    }
  });

  it("hands on a request relayed by the runner relay", async () => {
    const relay = createRunnerGatewayRelay("http://app.invalid", runnerToken, async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      return handleRunnerGatewayRequest(new Request(url, init), url.pathname.replace(/^\/api\/internal\/agent\//u, ""), { agent });
    });
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    try {
      for (const path of endpoints) {
        agent.mockClear();
        codeGateway.handleWorkspaceCodeMcpRequest.mockClear();
        const response = await fetch(`http://127.0.0.1:${(relay.address() as AddressInfo).port}/${path}`, {
          method: "POST", body: "{}", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json",
            [RUNNER_RELAY_PROOF_HEADER]: "v1.1791374400.guest-supplied-proof" } });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "agent_authorization_required" });
        expect(agent).toHaveBeenCalledOnce();
        expect(codeGateway.handleWorkspaceCodeMcpRequest).toHaveBeenCalledTimes(path === "mcp" ? 1 : 0);
      }
    } finally {
      relay.closeAllConnections();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });
});
