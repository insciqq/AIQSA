import { describe, expect, it, vi } from "vitest";
import { createAdminProviderCredentialTester } from "./credentialTester";
import { createAdminProviderCustomDiscoveryHandler } from "./customSetupDiscoveryHandlers";
import { verifyCustomSetupCatalogProof } from "./customSetupCatalogProof";

const now = Date.parse("2026-09-09T12:00:00.000Z");
const key = "synthetic-catalog-signing-key";
const endpoint = "https://gateway.example.test/v1";
const secret = "synthetic-catalog-credential";
const userId = "synthetic-admin";

async function discover(entries: unknown[]) {
  const dispatch = vi.fn(async () => Response.json({ data: entries }));
  const handler = createAdminProviderCustomDiscoveryHandler({
    now: () => new Date(now),
    proofKey: () => key,
    resolveAuth: async () => ({ expiresAt: new Date(now + 60_000), id: "synthetic-session", userId,
      user: { displayName: "Synthetic admin", email: null, id: userId, role: "admin", status: "active" } }),
    tester: createAdminProviderCredentialTester({ network: { dispatch,
      lookupHostname: async () => [{ address: "93.184.216.34", family: 4 as const }]
    } })
  });
  const response = await handler(new Request("http://localhost/api/admin/providers/custom-setup/discover", {
    body: JSON.stringify({ allowPrivateNetwork: false, apiRoot: `${endpoint}/`, authenticationMode: "bearer",
      responseTimeoutSeconds: 300, secret }),
    headers: { "content-type": "application/json" }, method: "POST"
  }));
  expect(response.status).toBe(200);
  const result = await response.json() as { catalogProof: string; responsesRequestIsolationDetected: boolean };
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(typeof result.catalogProof).toBe("string");
  return result;
}

describe("custom Responses catalog proof boundary", () => {
  it.each([
    { entries: [{ id: "one", owned_by: "codex-lb" }], detected: true },
    { entries: [{ id: "one", owned_by: "codex-lb" }, { id: "one", owned_by: "other" }], detected: false },
    { entries: [{ id: "one", owned_by: "codex-lb" }, { id: "one" }], detected: false },
    { entries: [], detected: false }
  ])("signs the complete validated catalog outcome, before duplicate metadata is lost (%#)", async ({ entries, detected }) => {
    const result = await discover(entries);
    expect(result.responsesRequestIsolationDetected).toBe(detected);
    expect(verifyCustomSetupCatalogProof({ endpoint, key, now, proof: result.catalogProof, secret, userId }))
      .toEqual({ detectedCodexLb: detected });
  });

  it("binds the receipt to the administrator, endpoint, credential and expiry without exposing the credential", async () => {
    const result = await discover([{ id: "one", owned_by: "codex-lb" }]);
    const input = { endpoint, key, now, proof: result.catalogProof, secret, userId };
    expect(Buffer.from(result.catalogProof.split(".")[0]!, "base64url").toString("utf8")).not.toContain(secret);
    for (const patch of [
      { endpoint: "https://other.example.test/v1" }, { secret: "different-synthetic-credential" },
      { userId: "other-synthetic-admin" }, { key: "another-signing-key" }, { now: now + 300_001 },
      { proof: `${result.catalogProof}tampered` }, { proof: "malformed" }
    ]) expect(verifyCustomSetupCatalogProof({ ...input, ...patch })).toBeNull();
    expect(verifyCustomSetupCatalogProof(input)).toEqual({ detectedCodexLb: true });
  });
});
