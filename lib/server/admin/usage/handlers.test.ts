import { describe, expect, it, vi } from "vitest";
import { emptyUsageAmounts, serializeAdminUsageAnalytics } from "./analytics";
import { createAdminUsageHandlers } from "./handlers";
import { rawUsageModelKey } from "./models";
import { UsageTimeZoneUnsupportedError, type UsageExport } from "./repository";
import { planUsageWindow } from "./window";

const NOW = new Date("2026-10-06T22:30:00.000Z");
const plan = planUsageWindow({ earliestUsageAt: null, now: NOW, period: "30d", timeZone: "Europe/Moscow" });
const analytics = serializeAdminUsageAnalytics({ groups: [], models: new Map(), plan, previous: null, rows: [], userCount: 0, users: [] });
const exported: UsageExport = {
  models: new Map(),
  plan,
  rows: [{ amounts: { ...emptyUsageAmounts(), recordCount: 1 }, bucket: "2026-10-07", category: "system",
    model: rawUsageModelKey("p", "m"), purpose: "chat_title", userId: "u1" }],
  users: new Map([["u1", { displayName: "Иван", email: "ivan@example.com", groups: [], id: "u1" }]])
};

function fixture() {
  const resolveAuth = vi.fn().mockResolvedValue({ userId: "admin", user: { role: "admin", status: "active" } });
  const repository = { readAnalytics: vi.fn().mockResolvedValue(analytics), readExport: vi.fn().mockResolvedValue(exported) };
  return { repository, resolveAuth, ...createAdminUsageHandlers({ now: () => NOW, repository, resolveAuth }) };
}

const url = (path: string, query: string) => new Request(`http://local.test/api/admin/usage${path}?${query}`);

describe("admin usage handlers", () => {
  it("require an active administrator", async () => {
    const f = fixture();
    for (const auth of [null, { userId: "u", user: { role: "user", status: "active" } }, { userId: "u", user: { role: "admin", status: "disabled" } }]) {
      f.resolveAuth.mockResolvedValue(auth);
      for (const handler of [f.GET, f.EXPORT]) {
        const response = await handler(url("", "period=7d&tz=UTC"));
        expect(response.status).toBe(auth ? 403 : 401);
        expect(await response.json()).toEqual({ error: auth ? "forbidden" : "unauthorized" });
      }
    }
    expect(f.repository.readAnalytics).not.toHaveBeenCalled();
    expect(f.repository.readExport).not.toHaveBeenCalled();
  });

  it("validate the period and the zone before reading", async () => {
    const f = fixture();
    for (const [query, code] of [
      ["period=1y&tz=UTC", "usage_period_invalid"], ["period=&tz=UTC", "usage_period_invalid"],
      ["period=7d", "usage_time_zone_invalid"], ["period=7d&tz=%2B03%3A00", "usage_time_zone_invalid"],
      ["period=7d&tz=Mars%2FPhobos", "usage_time_zone_invalid"], [`period=7d&tz=${"A".repeat(65)}`, "usage_time_zone_invalid"]
    ] as const) {
      for (const handler of [f.GET, f.EXPORT]) {
        const response = await handler(url("", query));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: code });
      }
    }
    expect(f.repository.readAnalytics).not.toHaveBeenCalled();
  });

  it("returns the analytics without caching and defaults the period", async () => {
    const f = fixture();
    const response = await f.GET(url("", "tz=Europe%2FMoscow"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ usage: analytics });
    expect(f.repository.readAnalytics).toHaveBeenCalledWith({ now: NOW, period: "30d", timeZone: "Europe/Moscow" });
  });

  it("maps failures to stable codes without logging content", async () => {
    const f = fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.repository.readAnalytics.mockRejectedValueOnce(new Error("secret detail"));
    const failed = await f.GET(url("", "period=7d&tz=UTC"));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "usage_analytics_failed" });
    expect(log).toHaveBeenCalledWith("usage_analytics_failed");
    f.repository.readAnalytics.mockRejectedValueOnce(new UsageTimeZoneUnsupportedError());
    expect((await f.GET(url("", "period=7d&tz=UTC"))).status).toBe(400);
    log.mockRestore();
  });

  it("streams a UTF-8 CSV attachment named after the local date", async () => {
    const f = fixture();
    const response = await f.EXPORT(url("/export", "period=30d&tz=Europe%2FMoscow"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=\"aiqsa-usage-30d-2026-10-07.csv\"");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = new TextDecoder().decode(bytes.slice(3));
    expect(body.split("\r\n")).toEqual([
      expect.stringMatching(/^period_start,user_email,/u),
      "2026-10-07,ivan@example.com,Иван,,system,chat_title,p,m,0,1,,,,,,,,0",
      ""
    ]);
  });

  it("refuses an export over the row bound", async () => {
    const f = fixture();
    f.repository.readExport.mockResolvedValueOnce(null);
    const response = await f.EXPORT(url("/export", "period=all&tz=UTC"));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "usage_export_too_large" });
  });
});
