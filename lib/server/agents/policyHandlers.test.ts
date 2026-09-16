import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_POLICY } from "@/lib/contracts/agentPolicy";
import { createAgentPolicyHandlers } from "./policyHandlers";

const { version, ...values } = DEFAULT_AGENT_POLICY;
const request = (body: unknown = { ...values, expectedVersion: version }) => new Request("http://local.test/api/admin/workspace/agent", {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});
function fixture() {
  const resolveAuth = vi.fn().mockResolvedValue({ userId: "admin", user: { role: "admin", status: "active" } });
  const repository = { read: vi.fn().mockResolvedValue(DEFAULT_AGENT_POLICY), update: vi.fn().mockResolvedValue({ ...DEFAULT_AGENT_POLICY, version: 2 }) };
  return { resolveAuth, repository, ...createAgentPolicyHandlers({ resolveAuth, repository }) };
}
describe("Agent policy administration", () => {
  it("requires an active administrator for reads and writes", async () => {
    const f = fixture();
    for (const auth of [null, { userId: "u", user: { role: "user", status: "active" } }, { userId: "u", user: { role: "admin", status: "disabled" } }]) {
      f.resolveAuth.mockResolvedValue(auth);
      expect((await f.GET(request())).status).toBe(auth ? 403 : 401);
      expect((await f.PATCH(request())).status).toBe(auth ? 403 : 401);
    }
    expect(f.repository.read).not.toHaveBeenCalled();
    expect(f.repository.update).not.toHaveBeenCalled();
  });
  it("saves the whole block with its expected version and prevents caching", async () => {
    const f = fixture();
    const response = await f.PATCH(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(f.repository.update).toHaveBeenCalledWith({ ...values, expectedVersion: 1, userId: "admin" });
    f.repository.update.mockResolvedValue(null);
    expect((await f.PATCH(request())).status).toBe(409);
  });
  it("rejects partial, additive and invalid settings without touching the policy", async () => {
    const f = fixture();
    for (const body of [null, { expectedVersion: 1 }, { ...values, expectedVersion: 1, version: 1 },
      { ...values, expectedVersion: 1, maxToolCalls: -1 }, { ...values, expectedVersion: 1, limitsEnabled: "false" },
      { ...values, expectedVersion: 1, unexpected: true }]) expect((await f.PATCH(request(body))).status).toBe(400);
    expect(f.repository.update).not.toHaveBeenCalled();
  });
});
