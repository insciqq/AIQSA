import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import type { SkillSuggestionService } from "./suggestionService";
import { createSkillSuggestionHandler } from "./suggestionHandler";

const session: AuthenticatedSession = { id: "session", userId: "user", expiresAt: new Date("2099-01-01"),
  user: { id: "user", displayName: "User", email: null, role: "user", status: "active" } };
const input = { requestId: "00000000-0000-4000-8000-000000000001", draft: "Help", chatId: null,
  projectId: null, expectedActiveLeafMessageId: null, excludedIds: [] };
const request = (value: unknown) => new Request("http://localhost/api/me/skills/suggestions", { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
describe("Skill suggestion request boundary", () => {
  it("requires authentication before reading input or starting paid work", async () => {
    const suggest = vi.fn<SkillSuggestionService>();
    const response = await createSkillSuggestionHandler({ resolveAuth: async () => null, suggest })(request(input));
    expect(response.status).toBe(401); expect(suggest).not.toHaveBeenCalled();
  });
  it.each([{ ...input, catalog: [{ id: "forged" }] }, { ...input, requestId: "replay" },
    { ...input, expectedActiveLeafMessageId: "foreign" }, { ...input, excludedIds: ["same", "same"] }])("rejects malformed or authority-bearing browser input", async value => {
    const suggest = vi.fn<SkillSuggestionService>();
    const response = await createSkillSuggestionHandler({ resolveAuth: async () => session, suggest })(request(value));
    expect(response.status).toBe(400); expect(suggest).not.toHaveBeenCalled();
  });
  it("binds work to the current session and prevents response caching", async () => {
    const resolveAuth = vi.fn(async (): Promise<AuthenticatedSession | null> => session);
    const suggest = vi.fn<SkillSuggestionService>(async (_user, _input, options) => {
      await options.authorizeSession(); return { status: "ready", skills: [] };
    });
    const response = await createSkillSuggestionHandler({ resolveAuth, suggest })(request(input));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(resolveAuth).toHaveBeenCalledTimes(2);
    resolveAuth.mockResolvedValueOnce(session).mockResolvedValueOnce(null);
    await expect(createSkillSuggestionHandler({ resolveAuth, suggest })(request(input))).rejects.toThrow("session_unavailable");
  });
});
