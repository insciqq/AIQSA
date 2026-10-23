import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunnerGatewayRelay } from "./runnerGatewayRelay";
import { RUNNER_RELAY_PROOF_HEADER, runnerRelayProofKey, signRunnerRelayProof } from "./runnerGatewayProof";
import { workspaceCodeTokenHash } from "./codeMcpStore";
import { handleRunnerGatewayRequest } from "./runnerGateway";

// An unknown code bearer is refused by the code gateway exactly like any unknown bearer.
const codeGateway = vi.hoisted(() => ({ handleWorkspaceCodeMcpRequest: vi.fn(async (_request: Request, _tokenHash: string) =>
  Response.json({ error: "agent_authorization_required" }, { status: 401 })) }));
vi.mock("./codeMcpGateway", () => codeGateway);

const runnerToken = "synthetic-runner-token-".padEnd(48, "0");
const bearer = "b".repeat(43);
// The model and Search endpoints served the removed Codex Agent; nothing serves them now.
const retiredEndpoints = ["v1/responses", "v1/alpha/search"];

function gatewayRequest(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://app.invalid/api/internal/agent/${path}`, { method: "POST", body: "{}",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers } });
}

function relayProof(input: Readonly<{ bearer?: string; nowMs?: number; path?: string; token?: string }> = {}) {
  return signRunnerRelayProof(runnerRelayProofKey(input.token ?? runnerToken)!,
    { bearer: input.bearer ?? bearer, method: "POST", path: input.path ?? "mcp" }, input.nowMs);
}

async function expectRefusedBeforeLookup(request: Request, path = "mcp") {
  const response = await handleRunnerGatewayRequest(request, path);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "agent_authorization_required" });
  expect(codeGateway.handleWorkspaceCodeMcpRequest).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv("AIQSA_WORKSPACE_RUNNER_TOKEN", runnerToken);
  codeGateway.handleWorkspaceCodeMcpRequest.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runner gateway ingress", () => {
  it("refuses a direct request with a well-formed bearer but no relay proof, exactly like a bad bearer", async () => {
    for (const path of ["mcp", ...retiredEndpoints]) await expectRefusedBeforeLookup(gatewayRequest(path), path);
    await expectRefusedBeforeLookup(gatewayRequest("mcp",
      { authorization: "Bearer not-a-run-bearer", [RUNNER_RELAY_PROOF_HEADER]: relayProof() }));
  });

  it("refuses spoofed, garbled, replayed or foreign proofs before any lookup", async () => {
    // Exact skew boundaries are pinned in runnerGatewayProof.test.ts with a fixed clock.
    const now = Date.now();
    const guessedKeyProof = relayProof({ token: "guest-guessed-runner-token-".padEnd(48, "0") });
    for (const proof of ["v1", "v1.1791374400.guest-supplied-proof", `${relayProof()}, ${relayProof()}`, guessedKeyProof,
      relayProof({ nowMs: now - 120_000 }), relayProof({ nowMs: now + 120_000 }),
      relayProof({ path: "v1/responses" }), relayProof({ bearer: "c".repeat(43) })]) {
      await expectRefusedBeforeLookup(gatewayRequest("mcp", { [RUNNER_RELAY_PROOF_HEADER]: proof }));
    }
    await expectRefusedBeforeLookup(gatewayRequest("mcp",
      { [RUNNER_RELAY_PROOF_HEADER]: relayProof(), origin: "https://public.example" }));
  });

  it("serves a relayed bearer only as a Workspace code bearer on MCP, never on the retired model or Search endpoints", async () => {
    for (const path of retiredEndpoints) {
      const response = await handleRunnerGatewayRequest(gatewayRequest(path, { [RUNNER_RELAY_PROOF_HEADER]: relayProof({ path }) }), path);
      expect(response.status).toBe(401);
    }
    expect(codeGateway.handleWorkspaceCodeMcpRequest).not.toHaveBeenCalled();
    codeGateway.handleWorkspaceCodeMcpRequest.mockResolvedValueOnce(Response.json({ ok: true }));
    const request = gatewayRequest("mcp", { [RUNNER_RELAY_PROOF_HEADER]: relayProof() });
    const response = await handleRunnerGatewayRequest(request, "mcp");
    expect(response.status).toBe(200);
    expect(codeGateway.handleWorkspaceCodeMcpRequest).toHaveBeenCalledWith(request, workspaceCodeTokenHash(bearer));
  });

  it("answers a failed code grant lookup like a bad bearer", async () => {
    codeGateway.handleWorkspaceCodeMcpRequest.mockRejectedValueOnce(new Error("lookup_failed"));
    const failed = await handleRunnerGatewayRequest(gatewayRequest("mcp", { [RUNNER_RELAY_PROOF_HEADER]: relayProof() }), "mcp");
    expect(failed.status).toBe(401);
    expect(await failed.json()).toEqual({ error: "agent_authorization_required" });
  });

  it("refuses every request when the app has no runner token", async () => {
    for (const value of [undefined, "", "   "]) {
      vi.stubEnv("AIQSA_WORKSPACE_RUNNER_TOKEN", value);
      await expectRefusedBeforeLookup(gatewayRequest("mcp", { [RUNNER_RELAY_PROOF_HEADER]: relayProof() }));
    }
  });

  it("hands on a request relayed by the runner relay, which forwards nothing but MCP", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      return handleRunnerGatewayRequest(new Request(url, init), url.pathname.replace(/^\/api\/internal\/agent\//u, ""));
    });
    const relay = createRunnerGatewayRelay("http://app.invalid", runnerToken, upstream);
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    try {
      const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
      const send = (path: string) => fetch(`${relayUrl}/${path}`, {
        method: "POST", body: "{}", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json",
          [RUNNER_RELAY_PROOF_HEADER]: "v1.1791374400.guest-supplied-proof" } });
      const response = await send("mcp");
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "agent_authorization_required" });
      expect(codeGateway.handleWorkspaceCodeMcpRequest).toHaveBeenCalledOnce();
      for (const path of retiredEndpoints) {
        expect((await send(path)).status).toBe(404);
      }
      expect(upstream).toHaveBeenCalledOnce();
    } finally {
      relay.closeAllConnections();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });
});
