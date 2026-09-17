import { describe, expect, it, vi } from "vitest";
import { VISIBLE_ANSWER_CONTRACT } from "../../domain/promptTemplates";
import { createInstructionPreviewHandlers } from "./previewHandlers";

function fixture() {
  const resolveAuth = vi.fn().mockResolvedValue({ userId: "owner", user: { id: "owner", status: "active" } });
  const handlers = createInstructionPreviewHandlers({
    now: () => new Date("2026-06-07T12:34:00.000Z"),
    resolveAuth
  });
  return { handlers, resolveAuth };
}

describe("platform instruction preview API", () => {
  it("returns only the server-rendered platform projection for an active user", async () => {
    const f = fixture();
    const response = await f.handlers.GET(new Request("http://localhost/api/me/instructions/preview?timeZone=Europe%2FBerlin"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ preview: {
      baseline: {
        renderedSystemPrompt: "You are a helpful AI assistant. Today is June 7, 2026, local time is 02:34 PM GMT+2.",
        timeZone: "Europe/Berlin",
        timeZoneSource: "client"
      },
      generatedAt: "2026-06-07T12:34:00.000Z",
      visibleAnswerContract: VISIBLE_ANSWER_CONTRACT
    } });
  });

  it.each(["", "?timeZone=not-a-zone", "?timeZone=", "?timeZone=%3Cscript%3E"])("uses UTC for absent or invalid client context: %s", async query => {
    const f = fixture();
    const response = await f.handlers.GET(new Request(`http://localhost/api/me/instructions/preview${query}`));
    expect((await response.json()).preview.baseline).toEqual({
      renderedSystemPrompt: "You are a helpful AI assistant. Today is June 7, 2026, local time is 12:34 PM UTC.",
      timeZone: "UTC",
      timeZoneSource: "utc_fallback"
    });
  });

  it("authenticates before disclosing the platform projection", async () => {
    const f = fixture();
    f.resolveAuth.mockResolvedValueOnce(null);
    const response = await f.handlers.GET(new Request("http://localhost/api/me/instructions/preview"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it.each(["pending", "disabled"])("denies an inactive account: %s", async status => {
    const f = fixture();
    f.resolveAuth.mockResolvedValueOnce({ userId: "owner", user: { id: "owner", status } });
    const response = await f.handlers.GET(new Request("http://localhost/api/me/instructions/preview"));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("sanitizes rendering failures", async () => {
    const f = fixture();
    const handlers = createInstructionPreviewHandlers({ resolveAuth: f.resolveAuth, now: () => { throw new Error("private detail"); } });
    const response = await handlers.GET(new Request("http://localhost/api/me/instructions/preview"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "instruction_preview_unavailable" });
  });
});
