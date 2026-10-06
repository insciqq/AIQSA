import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentRelay } from "./relay";
import { AGENT_RELAY_PROOF_HEADER, agentRelayProofKey, signAgentRelayProof } from "./relayProof";
import { agentTokenHash } from "./store";
import { handleAgentGatewayRequest } from "./gateway";

const database = vi.hoisted(() => ({ agentRunBinding: { findUnique: vi.fn(async (_query: unknown) => null) } }));
vi.mock("../prisma", () => ({ prisma: database }));

const runnerToken = "synthetic-runner-token-".padEnd(48, "0");
const bearer = "b".repeat(43);
const endpoints = ["v1/responses", "v1/alpha/search", "mcp"];

function gatewayRequest(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://app.invalid/api/internal/agent/${path}`, { method: "POST", body: "{}",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers } });
}

function relayProof(input: Readonly<{ bearer?: string; nowMs?: number; path?: string; token?: string }> = {}) {
  return signAgentRelayProof(agentRelayProofKey(input.token ?? runnerToken)!,
    { bearer: input.bearer ?? bearer, method: "POST", path: input.path ?? "v1/responses" }, input.nowMs);
}

async function expectRefusedBeforeLookup(request: Request, path = "v1/responses") {
  const response = await handleAgentGatewayRequest(request, path);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "agent_authorization_required" });
  expect(database.agentRunBinding.findUnique).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv("AIQSA_WORKSPACE_RUNNER_TOKEN", runnerToken);
  database.agentRunBinding.findUnique.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Agent gateway ingress", () => {
  it("refuses a direct request with a well-formed bearer but no relay proof, exactly like a bad bearer", async () => {
    for (const path of endpoints) await expectRefusedBeforeLookup(gatewayRequest(path), path);
    await expectRefusedBeforeLookup(gatewayRequest("v1/responses",
      { authorization: "Bearer not-a-run-bearer", [AGENT_RELAY_PROOF_HEADER]: relayProof() }));
  });

  it("looks up the bearer only once a current relay proof for that endpoint is present", async () => {
    for (const path of endpoints) {
      database.agentRunBinding.findUnique.mockClear();
      const response = await handleAgentGatewayRequest(gatewayRequest(path, { [AGENT_RELAY_PROOF_HEADER]: relayProof({ path }) }), path);
      // The synthetic bearer has no binding, so the lookup itself refuses it.
      expect(response.status).toBe(401);
      expect(database.agentRunBinding.findUnique).toHaveBeenCalledOnce();
      expect(database.agentRunBinding.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: agentTokenHash(bearer) } }));
    }
  });

  it("refuses spoofed, garbled, replayed or foreign proofs before any lookup", async () => {
    // Exact skew boundaries are pinned in relayProof.test.ts with a fixed clock.
    const now = Date.now();
    const guessedKeyProof = relayProof({ token: "guest-guessed-runner-token-".padEnd(48, "0") });
    for (const proof of ["v1", "v1.1791374400.guest-supplied-proof", `${relayProof()}, ${relayProof()}`, guessedKeyProof,
      relayProof({ nowMs: now - 120_000 }), relayProof({ nowMs: now + 120_000 }),
      relayProof({ path: "mcp" }), relayProof({ bearer: "c".repeat(43) })]) {
      await expectRefusedBeforeLookup(gatewayRequest("v1/responses", { [AGENT_RELAY_PROOF_HEADER]: proof }));
    }
    await expectRefusedBeforeLookup(gatewayRequest("v1/responses",
      { [AGENT_RELAY_PROOF_HEADER]: relayProof(), origin: "https://public.example" }));
  });

  it("refuses every request when the app has no runner token", async () => {
    for (const value of [undefined, "", "   "]) {
      vi.stubEnv("AIQSA_WORKSPACE_RUNNER_TOKEN", value);
      await expectRefusedBeforeLookup(gatewayRequest("mcp", { [AGENT_RELAY_PROOF_HEADER]: relayProof({ path: "mcp" }) }), "mcp");
    }
  });

  it("reaches the binding lookup for a request relayed by the runner relay", async () => {
    const relay = createAgentRelay("http://app.invalid", runnerToken, async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      return handleAgentGatewayRequest(new Request(url, init), url.pathname.replace(/^\/api\/internal\/agent\//u, ""));
    });
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    try {
      for (const path of endpoints) {
        database.agentRunBinding.findUnique.mockClear();
        const response = await fetch(`http://127.0.0.1:${(relay.address() as AddressInfo).port}/${path}`, {
          method: "POST", body: "{}", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json",
            [AGENT_RELAY_PROOF_HEADER]: "v1.1791374400.guest-supplied-proof" } });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "agent_authorization_required" });
        expect(database.agentRunBinding.findUnique).toHaveBeenCalledOnce();
        expect(database.agentRunBinding.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { tokenHash: agentTokenHash(bearer) } }));
      }
    } finally {
      relay.closeAllConnections();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });
});
