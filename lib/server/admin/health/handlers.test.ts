import { describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import { TelemetryQueryError } from "../../telemetry/store";
import { createAdminHealthHandler, createAdminHealthIncidentsHandler } from "./handlers";
import type { AdminHealthService } from "./service";

function auth(role: "admin" | "user" = "admin", status = "active") {
  return vi.fn().mockResolvedValue({ user: { role, status }, userId: "admin-1" });
}

function service(overrides: Partial<AdminHealthService> = {}): AdminHealthService {
  return {
    read: vi.fn().mockResolvedValue({ range: "24h" }),
    incidents: vi.fn().mockResolvedValue({ incidents: [], nextCursor: null }),
    ...overrides
  } as AdminHealthService;
}

const request = (path: string) => new Request(`http://local.test${path}`);

describe("admin health handlers", () => {
  it("serves the health view to an active administrator without caching, defaulting to 24 hours", async () => {
    const health = service();
    const GET = createAdminHealthHandler({ resolveAuth: auth(), service: health });
    const response = await GET(request("/api/admin/health"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ health: { range: "24h" } });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(health.read).toHaveBeenCalledWith("24h");
    await GET(request("/api/admin/health?range=30d"));
    expect(health.read).toHaveBeenLastCalledWith("30d");
  });

  it("rejects anonymous, non-admin and inactive callers before reading telemetry", async () => {
    const health = service();
    for (const [resolveAuth, status] of [
      [vi.fn().mockResolvedValue(null), 401], [auth("user"), 403], [auth("admin", "disabled"), 403]
    ] as const) {
      expect((await createAdminHealthHandler({ resolveAuth, service: health })(request("/api/admin/health"))).status).toBe(status);
      expect((await createAdminHealthIncidentsHandler({ resolveAuth, service: health })(request("/api/admin/health/incidents"))).status).toBe(status);
    }
    expect(health.read).not.toHaveBeenCalled();
    expect(health.incidents).not.toHaveBeenCalled();
  });

  it("rejects an unknown or repeated range", async () => {
    const health = service();
    const GET = createAdminHealthHandler({ resolveAuth: auth(), service: health });
    for (const query of ["?range=1y", "?range=24h&range=7d", "?range="]) {
      const response = await GET(request(`/api/admin/health${query}`));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "admin_health_query_invalid" });
    }
    expect(health.read).not.toHaveBeenCalled();
  });

  it("reports a database failure as a stable unavailable code without its message", async () => {
    const observation = await captureRunObservation();
    const GET = createAdminHealthHandler({
      resolveAuth: auth(),
      service: service({ read: vi.fn().mockRejectedValue(new Error("PRIVATE connection string")) })
    });
    const response = await GET(request("/api/admin/health"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "admin_health_failed" });
    expect(observation.records()).toContainEqual(expect.objectContaining({ event: "service_operation", subsystem: "admin",
      stage: "read", outcome: "failed", code: "admin_health_failed" }));
    expect(JSON.stringify(observation.records())).not.toContain("PRIVATE");
  });

  it("parses incident filters strictly and maps a rejected cursor to a query error", async () => {
    const health = service();
    const GET = createAdminHealthIncidentsHandler({ resolveAuth: auth(), service: health });
    const ok = await GET(request(`/api/admin/health/incidents?range=7d&category=providers&code=provider_auth_rejected&level=error&q=${"a".repeat(32)}`));
    expect(ok.status).toBe(200);
    expect(health.incidents).toHaveBeenCalledWith({ range: "7d", category: "providers", code: "provider_auth_rejected",
      level: "error", q: "a".repeat(32), cursor: null, event: null });

    for (const query of ["?level=warn", "?category=other", "?q=has%20space", "?event=Bad-Event", "?cursor=***", "?code=a&code=b"]) {
      expect((await GET(request(`/api/admin/health/incidents${query}`))).status).toBe(400);
    }

    const rejecting = createAdminHealthIncidentsHandler({ resolveAuth: auth(),
      service: service({ incidents: vi.fn().mockRejectedValue(new TelemetryQueryError()) }) });
    const response = await rejecting(request("/api/admin/health/incidents?cursor=abc"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "admin_health_query_invalid" });
  });
});
