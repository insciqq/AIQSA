import { describe, expect, it, vi } from "vitest";
import type { AdminProviderConnection } from "../../../contracts/adminProviders";
import type { HealthFinding } from "./healthRules";
import { createAdminAttentionSummaryService } from "./summary";

const connections = [{
  activeChecks: [], activeVersion: 0, assignments: [], defaultCredentialId: null,
  credentials: [{ activeVersion: { activatedAt: "2026-10-01T00:00:00.000Z", revokedAt: null }, enabled: true }],
  displayName: "OpenAI", enabled: true, id: "conn-1", models: [], userAssignments: []
} as unknown as AdminProviderConnection];

const findings: HealthFinding[] = [
  { code: "provider_runtime_key_rejected", connectionId: "conn-1", failures: 1, lastFailureAt: new Date("2026-10-07T11:50:00.000Z") },
  { code: "logs_dropped", lines: 3 },
  { code: "server_errors_rising", errors: 11 }
];

describe("createAdminAttentionSummaryService", () => {
  it("counts bad and warning items of the cheap sources", async () => {
    const service = createAdminAttentionSummaryService({
      now: () => new Date("2026-10-07T12:00:00.000Z"),
      sources: { health: vi.fn().mockResolvedValue(findings), providers: vi.fn().mockResolvedValue(connections) }
    });
    await expect(service.read()).resolves.toEqual({
      bad: 1, checkedAt: "2026-10-07T12:00:00.000Z", unavailable: [], warn: 2
    });
  });

  it("serves one cached value for the TTL, shares a read in flight, then reads again", async () => {
    let time = Date.parse("2026-10-07T12:00:00.000Z");
    const health = vi.fn().mockResolvedValue(findings);
    const providers = vi.fn().mockResolvedValue(connections);
    const service = createAdminAttentionSummaryService({ now: () => new Date(time), sources: { health, providers }, ttlMs: 60_000 });
    const [first, second] = await Promise.all([service.read(), service.read()]);
    expect(second).toBe(first);
    time += 59_000;
    await service.read();
    expect(health).toHaveBeenCalledTimes(1);
    health.mockResolvedValue([]);
    time += 2_000;
    await expect(service.read()).resolves.toMatchObject({ bad: 0, warn: 0 });
    expect(health).toHaveBeenCalledTimes(2);
  });

  it("counts what loaded when one source fails, and does not cache a read where both failed", async () => {
    const health = vi.fn().mockRejectedValue(new Error("telemetry down"));
    const providers = vi.fn().mockRejectedValue(new Error("db down"));
    const service = createAdminAttentionSummaryService({ sources: { health, providers } });
    await expect(service.read()).rejects.toThrow();
    providers.mockResolvedValue(connections);
    await expect(service.read()).resolves.toMatchObject({ bad: 0, unavailable: ["health"], warn: 0 });
    expect(providers).toHaveBeenCalledTimes(2);
  });
});
