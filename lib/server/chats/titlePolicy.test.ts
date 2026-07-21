import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultChatTitle, titleFromMessageContent } from "./titlePolicy";

describe("local chat title policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("normalizes and bounds first-message text deterministically", () => {
    expect(
      titleFromMessageContent({
        blocks: [
          { text: "  Explain\n\ttransaction   isolation  ", type: "text" },
          { text: "with a practical example", type: "text" }
        ]
      })
    ).toBe("Explain transaction isolation with a practical example");

    const longTitle = titleFromMessageContent({
      blocks: [{ text: "x".repeat(100), type: "text" }]
    });
    expect(longTitle).toBe(`${"x".repeat(53)}...`);
    expect(longTitle).toHaveLength(56);
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
