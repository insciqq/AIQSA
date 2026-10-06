import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createAgentRelay } from "./relay";
import { AGENT_RELAY_PROOF_HEADER, agentRelayProofKey, verifyAgentRelayProof } from "./relayProof";

const runnerToken = "synthetic-runner-token-".padEnd(48, "0");
const bearer = "b".repeat(43);

describe("Agent relay", () => {
  it("forwards only fresh headers with its own proof, never a guest-supplied one", async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    const relay = createAgentRelay("http://app.invalid", runnerToken, upstream);
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    try {
      const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
      for (const path of ["v1/responses", "v1/alpha/search", "mcp"]) {
        upstream.mockClear();
        const response = await fetch(`${relayUrl}/${path}`, { method: "POST", body: "{\"probe\":1}", headers: {
          authorization: `Bearer ${bearer}`, "content-type": "application/json", "mcp-protocol-version": "2025-11-25",
          [AGENT_RELAY_PROOF_HEADER]: "v1.1791374400.guest-supplied-proof", cookie: "aiqsa_session=guest",
          "x-aiqsa-runtime-peer": "v1.guest.guest"
        } });
        expect(response.status).toBe(200);
        expect(upstream).toHaveBeenCalledOnce();
        const [target, init] = upstream.mock.calls[0]!;
        expect(target).toBe(`http://app.invalid/api/internal/agent/${path}`);
        const headers = new Headers(init?.headers);
        expect([...headers.keys()].sort()).toEqual(
          ["accept", "authorization", "content-type", "mcp-protocol-version", AGENT_RELAY_PROOF_HEADER]);
        const proof = headers.get(AGENT_RELAY_PROOF_HEADER);
        expect(verifyAgentRelayProof(agentRelayProofKey(runnerToken), proof, { bearer, method: "POST", path })).toBe(true);
        expect(verifyAgentRelayProof(agentRelayProofKey(runnerToken), proof,
          { bearer, method: "POST", path: path === "mcp" ? "v1/responses" : "mcp" })).toBe(false);
        expect(await new Response(init?.body).text()).toBe("{\"probe\":1}");
      }
    } finally {
      relay.closeAllConnections();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("refuses to start without a usable runner token", () => {
    for (const token of ["", "   ", "t".repeat(31)]) {
      expect(() => createAgentRelay("http://app.invalid", token)).toThrow("agent_relay_config_invalid");
    }
  });
});
