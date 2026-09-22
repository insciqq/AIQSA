import { describe, expect, it } from "vitest";
import { chatExportMarkdown } from "./chatExport";
import { buildPublicShareSnapshot } from "./shareSnapshot";

describe("readable follow-up history", () => {
  it("exports visible clarifications in order and omits private receipt metadata from shares", () => {
    const entry = { id: "followup", ordinal: 1, text: "A clarification", author: "Author", createdAt: "2026-09-22T00:00:00.000Z",
      delivery: "delivered", precedingText: "Earlier partial answer" } as const;
    const messages = [{ id: "q", parentMessageId: null, role: "user" as const, content: { blocks: [{ type: "text", text: "Original" }] } },
      { id: "a", parentMessageId: "q", role: "assistant" as const, content: { blocks: [{ type: "text", text: "Revised answer" }] },
        followups: { available: false, entries: [entry] } }];
    const exported = chatExportMarkdown("Conversation", messages);
    expect(exported.indexOf("Original")).toBeLessThan(exported.indexOf("Earlier partial answer"));
    expect(exported.indexOf("A clarification")).toBeLessThan(exported.indexOf("Revised answer"));
    const share = buildPublicShareSnapshot({ activeLeafMessageId: "a", messages, title: "Conversation" });
    expect(share.messages.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(share)).not.toMatch(/createdAt|delivery|author|ordinal|followups/);
    expect(JSON.stringify(share)).toContain("A clarification");
  });
});
