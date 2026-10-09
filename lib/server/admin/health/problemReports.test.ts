// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAdminHealthProblemReportsResponse } from "@/lib/contracts/adminHealthProblemReports";
import { createTestAuth } from "@/tests/support/auth";
import type { AnswerProblemReportListRow } from "../../answerProblemReports/repository";
import { createAdminHealthProblemReportsHandler } from "./problemReports";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const RUN_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const admin = createTestAuth({ user: { id: "admin-1", role: "admin" } });
const member = createTestAuth({ token: "member-token", user: { id: "user-1", role: "user" } });
const resolveAuth = async (request: Request) => await admin.resolveAuth(request) ?? member.resolveAuth(request);

function row(overrides: Partial<AnswerProblemReportListRow> = {}): AnswerProblemReportListRow {
  return {
    comment: "It cited a paper that does not exist.",
    connectionName: "OpenRouter",
    createdAt: new Date("2026-10-09T10:00:00.000Z"),
    id: "report-1",
    modelName: "Claude",
    reason: "wrong_or_made_up",
    runId: RUN_ID,
    updatedAt: new Date("2026-10-09T11:00:00.000Z"),
    user: { displayName: "Dana", email: "dana@example.com", id: "user-1" },
    ...overrides
  };
}

function get(query: string, cookie = admin.cookie): Request {
  return new Request(`http://app.local/api/admin/health/problem-reports${query}`, {
    headers: { cookie: cookie.split(";")[0]! }, method: "GET"
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin health problem reports", () => {
  it("lists the range's reports newest first with the user, model, run and comment, never the chat", async () => {
    const read = vi.fn().mockResolvedValue({ rows: [row(), row({ comment: null, connectionName: null, id: "report-2",
      modelName: null, runId: null })], total: 2 });
    const handler = createAdminHealthProblemReportsHandler({ now: () => NOW, read, resolveAuth });
    const response = await handler(get("?range=7d"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(read).toHaveBeenCalledWith({ from: new Date("2026-10-02T12:00:00.000Z"), limit: 100 });
    const body: unknown = await response.json();
    expect(decodeAdminHealthProblemReportsResponse(body)).toEqual(body);
    expect(body).toEqual({ problemReports: {
      from: "2026-10-02T12:00:00.000Z", generatedAt: NOW.toISOString(), range: "7d", total: 2, truncated: false,
      reports: [
        { comment: "It cited a paper that does not exist.", connectionName: "OpenRouter", id: "report-1", modelName: "Claude",
          reason: "wrong_or_made_up", reportedAt: "2026-10-09T11:00:00.000Z", runId: RUN_ID,
          user: { displayName: "Dana", email: "dana@example.com", id: "user-1" } },
        { comment: null, connectionName: null, id: "report-2", modelName: null, reason: "wrong_or_made_up",
          reportedAt: "2026-10-09T11:00:00.000Z", runId: null, user: { displayName: "Dana", email: "dana@example.com", id: "user-1" } }
      ]
    } });
    expect(JSON.stringify(body)).not.toMatch(/chatId|messageId/u);
  });

  it("flags a truncated list with the range's total", async () => {
    const read = vi.fn().mockResolvedValue({ rows: [row()], total: 140 });
    const response = await createAdminHealthProblemReportsHandler({ now: () => NOW, read, resolveAuth })(get(""));
    expect(read).toHaveBeenCalledWith({ from: new Date("2026-10-08T12:00:00.000Z"), limit: 100 });
    expect(await response.json()).toMatchObject({ problemReports: { range: "24h", total: 140, truncated: true } });
  });

  it("drops a run id that is not a well-formed run id", async () => {
    const read = vi.fn().mockResolvedValue({ rows: [row({ runId: "imported-run" })], total: 1 });
    const response = await createAdminHealthProblemReportsHandler({ now: () => NOW, read, resolveAuth })(get("?range=30d"));
    expect(await response.json()).toMatchObject({ problemReports: { reports: [{ runId: null }] } });
  });

  it("is for active administrators only and refuses an unknown range", async () => {
    const read = vi.fn();
    const handler = createAdminHealthProblemReportsHandler({ now: () => NOW, read, resolveAuth });
    expect((await handler(new Request("http://app.local/api/admin/health/problem-reports"))).status).toBe(401);
    expect((await handler(get("", member.cookie))).status).toBe(403);
    const invalid = await handler(get("?range=1y"));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "admin_health_query_invalid" });
    expect((await handler(get("?range=24h&range=7d"))).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("answers a failed read with a stable code", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const read = vi.fn().mockRejectedValue(new Error("database down"));
    const response = await createAdminHealthProblemReportsHandler({ now: () => NOW, read, resolveAuth })(get(""));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "admin_health_failed" });
  });
});
