import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultChatTitle, titleFromMessageContent } from "./titlePolicy";

describe("local chat title policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keeps short first-message text exact after whitespace normalization", () => {
    expect(
      titleFromMessageContent({
        blocks: [
          { text: "  Explain\n\ttransaction   isolation  ", type: "text" },
          { text: "with a practical example", type: "text" }
        ]
      })
    ).toBe("Explain transaction isolation with a practical example");
  });

  it("cuts a long title at the last whole-word boundary without persisting an ellipsis", () => {
    const title = titleFromMessageContent({
      blocks: [
        {
          text: "Give a short but complete explanation of transaction isolation and practical locking examples",
          type: "text"
        }
      ]
    });

    expect(title).toBe("Give a short but complete explanation of transaction");
    expect(title).not.toMatch(/\.\.\.$/);
    expect(Array.from(title).length).toBeLessThanOrEqual(56);
  });

  it("uses a bounded code-point fallback for a single long word", () => {
    const title = titleFromMessageContent({
      blocks: [{ text: "x".repeat(100), type: "text" }]
    });

    expect(title).toBe("x".repeat(56));
    expect(title).not.toContain("...");
  });

  it("keeps unicode code points intact while cutting at a whole-word boundary", () => {
    const title = titleFromMessageContent({
      blocks: [
        {
          text: "🧭 Объясни, как многоязычный поиск сохраняет контекст документов для распределённых команд",
          type: "text"
        }
      ]
    });

    expect(title).toBe("🧭 Объясни, как многоязычный поиск сохраняет контекст");
    expect(title).not.toContain("�");
    expect(Array.from(title).length).toBeLessThanOrEqual(56);
  });

  it("uses the local placeholder for blank, malformed, and attachment-only content", () => {
    expect(titleFromMessageContent(null)).toBe(defaultChatTitle);
    expect(titleFromMessageContent({ blocks: [{ text: "   ", type: "text" }] })).toBe(defaultChatTitle);
    expect(titleFromMessageContent({ blocks: [{ attachmentId: "attachment-1", type: "attachment" }] })).toBe(
      defaultChatTitle
    );
  });

  it("never calls a provider even when provider keys are present", () => {
    vi.stubEnv("OPENAI_API_KEY", "unused-openai-key");
    vi.stubEnv("OPENROUTER_API_KEY", "unused-openrouter-key");
    const fetchSpy = vi.fn(() => {
      throw new Error("title policy must remain local");
    });
    vi.stubGlobal("fetch", fetchSpy);

    expect(
      titleFromMessageContent({
        blocks: [{ text: "Private first message", type: "text" }]
      })
    ).toBe("Private first message");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
