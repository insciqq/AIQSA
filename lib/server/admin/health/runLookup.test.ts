// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ADMIN_HEALTH_RUN_LOOKUP_LIMIT } from "@/lib/contracts/adminHealthRunLookup";
import { normalizeRunReference, runReferenceLabel, runReferenceRange } from "@/lib/contracts/runReference";
import { captureRunObservation } from "@/tests/support/runObservation";
import {
  createAdminHealthRunLookup,
  createAdminHealthRunLookupHandler,
  type AdminHealthRunLookup,
  type AdminHealthRunRow
} from "./runLookup";
import { adminHealthRunLookupStatement, createPrismaAdminHealthRunRepository } from "./runLookupRepository";

const RUN = "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f809a1b";

function row(overrides: Partial<AdminHealthRunRow> = {}): AdminHealthRunRow {
  return {
    id: RUN, status: "error", createdAt: new Date("2026-10-07T14:03:00.000Z"), updatedAt: new Date("2026-10-07T14:03:04.250Z"),
    failureCode: "provider_auth_rejected", connectionId: "connection-1", connectionName: "  OpenAI production ",
    providerModelId: "model-1", modelDisplayName: "GPT answer", modelProviderId: "gpt-answer", ...overrides
  };
}

function lookupWith(rows: readonly AdminHealthRunRow[], counts = new Map<string, number>()) {
  const findByReference = vi.fn(async () => rows);
  const countIncidentsByRun = vi.fn(async () => counts);
  return { findByReference, countIncidentsByRun, lookup: createAdminHealthRunLookup({ runs: { findByReference }, incidents: { countIncidentsByRun } }) };
}

describe("run references", () => {
  it("normalizes pasted references to UUID prefixes of at least eight characters", () => {
    expect(runReferenceLabel(RUN)).toBe("3f2a9c1e");
    expect(normalizeRunReference("  3F2A9C1E ")).toBe("3f2a9c1e");
    expect(normalizeRunReference("Reference: 3f2a9c1e")).toBe("3f2a9c1e");
    expect(normalizeRunReference("3f2a9c1e-7b")).toBe("3f2a9c1e-7b");
    expect(normalizeRunReference(RUN.toUpperCase())).toBe(RUN);
    for (const value of ["3f2a9c1", "3f2a9c1g", "3f2a9c1e7b", "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f809a1b0", "a".repeat(32), "run-1", ""]) {
      expect(normalizeRunReference(value)).toBeNull();
    }
  });

  it("bounds every UUID with the prefix inside the index range and every other one outside it", () => {
    const { lower, upper } = runReferenceRange("3f2a9c1e");
    const inRange = (id: string) => id >= lower && id < upper;
    expect(inRange(RUN)).toBe(true);
    expect(inRange("3f2a9c1e-0000-4000-8000-000000000000")).toBe(true);
    expect(inRange("3f2a9c1e-ffff-4fff-bfff-ffffffffffff")).toBe(true);
    expect(inRange("3f2a9c1d-ffff-4fff-bfff-ffffffffffff")).toBe(false);
    expect(inRange("3f2a9c1f-0000-4000-8000-000000000000")).toBe(false);
    expect(runReferenceRange(RUN)).toEqual({ lower: RUN, upper: `${RUN}g` });
  });

  it("builds one bounded, exact, id-ordered statement and refuses anything else before the database", async () => {
    const statement = adminHealthRunLookupStatement("3f2a9c1e", 6);
    expect(statement.text).toMatch(/run\."id" >= \$1 AND run\."id" < \$2 AND starts_with\(run\."id", \$3\)/u);
    expect(statement.text).toMatch(/ORDER BY run\."id"\s+LIMIT \$4/u);
    expect(statement.sql).not.toMatch(/"errorPayload" ->> 'message'|"title"|"content"|"email"/u);
    expect(statement.values).toEqual(["3f2a9c1e", "3f2a9c1eg", "3f2a9c1e", 6]);
    for (const [reference, limit] of [["3f2a9c1", 6], ["3F2A9C1E", 6], ["3f2a9c1e%", 6], ["3f2a9c1e", 0], ["3f2a9c1e", 17]] as const) {
      expect(() => adminHealthRunLookupStatement(reference, limit)).toThrow(RangeError);
    }
    const db = { $queryRaw: vi.fn() };
    const repository = createPrismaAdminHealthRunRepository(db as never);
    await expect(repository.findByReference("3f2a9c1", 6)).rejects.toThrow(RangeError);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("admin health run lookup", () => {
  it("projects a content-free summary with provider names, duration and linked incidents", async () => {
    const { lookup, findByReference, countIncidentsByRun } = lookupWith([row()], new Map([[RUN, 3]]));
    await expect(lookup.lookup("Reference: 3F2A9C1E")).resolves.toEqual({
      runs: [{
        runId: RUN, status: "error", startedAt: "2026-10-07T14:03:00.000Z", updatedAt: "2026-10-07T14:03:04.250Z",
        durationMs: 4_250, failureCode: "provider_auth_rejected", connectionName: "OpenAI production", modelName: "GPT answer",
        incidentCount: 3
      }],
      truncated: false
    });
    expect(findByReference).toHaveBeenCalledWith("3f2a9c1e", ADMIN_HEALTH_RUN_LOOKUP_LIMIT + 1);
    expect(countIncidentsByRun).toHaveBeenCalledWith([RUN]);
  });

  it("names deleted and missing providers, leaves active runs without duration and drops unsafe values", async () => {
    const other = "3f2a9c1e-0000-4000-8000-000000000001";
    const third = "3f2a9c1e-0000-4000-8000-000000000002";
    const { lookup } = lookupWith([
      row({ connectionName: null, modelDisplayName: null, modelProviderId: null }),
      row({ id: other, status: "streaming", failureCode: "has spaces", connectionId: null, connectionName: null,
        providerModelId: null, modelDisplayName: null, modelProviderId: null }),
      row({ id: third, connectionName: " ", modelDisplayName: " ", modelProviderId: "gpt-answer" }),
      row({ id: "3f2a9c1e-not-a-uuid" }),
      row({ id: "3f2a9c1e-0000-4000-8000-000000000003", status: "unknown" })
    ]);
    const result = await lookup.lookup("3f2a9c1e");
    expect(result.runs.map((run) => [run.runId, run.connectionName, run.modelName, run.durationMs, run.failureCode])).toEqual([
      [RUN, "Deleted connection", "Deleted model", 4_250, "provider_auth_rejected"],
      [other, null, null, null, null],
      [third, "Unnamed connection", "gpt-answer", 4_250, "provider_auth_rejected"]
    ]);
    expect(result.runs.map((run) => run.incidentCount)).toEqual([0, 0, 0]);
  });

  it("returns at most the limit, reports more matches and skips incident counting without matches", async () => {
    const ids = Array.from({ length: ADMIN_HEALTH_RUN_LOOKUP_LIMIT + 1 }, (_, index) => `3f2a9c1e-0000-4000-8000-00000000000${index}`);
    const many = lookupWith(ids.map((id) => row({ id })));
    const result = await many.lookup.lookup("3f2a9c1e");
    expect(result.runs).toHaveLength(ADMIN_HEALTH_RUN_LOOKUP_LIMIT);
    expect(result.truncated).toBe(true);
    expect(many.countIncidentsByRun).toHaveBeenCalledWith(ids.slice(0, ADMIN_HEALTH_RUN_LOOKUP_LIMIT));

    const none = lookupWith([]);
    await expect(none.lookup.lookup("3f2a9c1e")).resolves.toEqual({ runs: [], truncated: false });
    expect(none.countIncidentsByRun).not.toHaveBeenCalled();
  });
});

describe("admin health run lookup handler", () => {
  const request = (query: string) => new Request(`http://local.test/api/admin/health/runs${query}`);
  const auth = (role: "admin" | "user" = "admin", status = "active") =>
    vi.fn().mockResolvedValue({ user: { role, status }, userId: "admin-1" });
  const lookup = (): AdminHealthRunLookup & { lookup: ReturnType<typeof vi.fn> } =>
    ({ lookup: vi.fn().mockResolvedValue({ runs: [], truncated: false }) });

  it("serves an active administrator without caching", async () => {
    const service = lookup();
    const response = await createAdminHealthRunLookupHandler({ resolveAuth: auth(), lookup: service })(request("?q=3F2A9C1E"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ runs: [], truncated: false });
    expect(service.lookup).toHaveBeenCalledWith("3f2a9c1e");
  });

  it("rejects anonymous, non-admin and inactive callers before any read", async () => {
    const service = lookup();
    for (const [resolveAuth, status] of [
      [vi.fn().mockResolvedValue(null), 401], [auth("user"), 403], [auth("admin", "disabled"), 403]
    ] as const) {
      expect((await createAdminHealthRunLookupHandler({ resolveAuth, lookup: service })(request("?q=3f2a9c1e"))).status).toBe(status);
    }
    expect(service.lookup).not.toHaveBeenCalled();
  });

  it("rejects short, malformed and repeated references", async () => {
    const service = lookup();
    const GET = createAdminHealthRunLookupHandler({ resolveAuth: auth(), lookup: service });
    for (const query of ["", "?q=", "?q=3f2a9c1", "?q=3f2a9c1e%25", `?q=${"a".repeat(32)}`, "?q=3f2a9c1e&q=3f2a9c1f"]) {
      const response = await GET(request(query));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "admin_health_query_invalid" });
    }
    expect(service.lookup).not.toHaveBeenCalled();
  });

  it("reports a failed read with a stable code and a content-free log record", async () => {
    const observed = await captureRunObservation();
    const GET = createAdminHealthRunLookupHandler({
      resolveAuth: auth(), lookup: { lookup: vi.fn().mockRejectedValue(new Error("private detail")) }
    });
    const response = await GET(request("?q=3f2a9c1e"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "admin_health_failed" });
    expect(observed.records()).toContainEqual(expect.objectContaining({ event: "service_operation", code: "admin_health_failed" }));
    expect(JSON.stringify(observed.records())).not.toContain("private detail");
  });
});
