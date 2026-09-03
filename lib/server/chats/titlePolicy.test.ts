import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultChatTitle, titleFromMessageContent } from "./titlePolicy";

describe("local chat title policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keeps plain first-line text exact after whitespace normalization", () => {
    expect(
      titleFromMessageContent({
        blocks: [
          { text: "  Explain   transaction   isolation with an example  ", type: "text" }
        ]
      })
    ).toBe("Explain transaction isolation with an example");
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

    expect(title).toBe("Give a short but complete explanation of");
    expect(title).not.toMatch(/\.\.\.$/);
    expect(Array.from(title).length).toBeLessThanOrEqual(48);
  });

  it("uses a bounded code-point fallback for a single long word", () => {
    const title = titleFromMessageContent({
      blocks: [{ text: "x".repeat(100), type: "text" }]
    });

    expect(title).toBe("x".repeat(48));
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

    expect(title).toBe("🧭 Объясни, как многоязычный поиск сохраняет");
    expect(title).not.toContain("�");
    expect(Array.from(title).length).toBeLessThanOrEqual(48);
  });

  it("uses the first sentence from the first non-empty line and removes block markdown", () => {
    expect(titleFromMessageContent({
      blocks: [{
        text: "\n# Audit probe: release checklist review\n\nPlease review the remaining sections.",
        type: "text"
      }]
    })).toBe("Audit probe: release checklist review");
    expect(titleFromMessageContent({
      blocks: [{ text: "> - **Quoted decision.** Ignore this sentence.", type: "text" }]
    })).toBe("Quoted decision.");
    expect(titleFromMessageContent({
      blocks: [{ text: "1. First item? Second item.", type: "text" }]
    })).toBe("First item?");
  });

  it("removes inline markdown while retaining its readable label and code", () => {
    expect(titleFromMessageContent({
      blocks: [{
        text: "Review **release** [checklist](https://example.test/list) with `qa_runner`",
        type: "text"
      }]
    })).toBe("Review release checklist with qa_runner");
    expect(titleFromMessageContent({
      blocks: [{ text: "Keep snake_case_again unchanged", type: "text" }]
    })).toBe("Keep snake_case_again unchanged");
    expect(titleFromMessageContent({
      blocks: [{ text: "Explain `__init__` and `a*b*` safely", type: "text" }]
    })).toBe("Explain __init__ and a*b* safely");
    expect(titleFromMessageContent({
      blocks: [{ text: "Keep snake__case__again unchanged", type: "text" }]
    })).toBe("Keep snake__case__again unchanged");
    expect(titleFromMessageContent({
      blocks: [{ text: "Read [Docs](https://example.test/a_(b)) next", type: "text" }]
    })).toBe("Read Docs next");
    expect(titleFromMessageContent({
      blocks: [{ text: "第一句。 第二句。", type: "text" }]
    })).toBe("第一句。");
    expect(titleFromMessageContent({
      blocks: [{ text: "第一句。第二句。", type: "text" }]
    })).toBe("第一句。");
  });

  it("drops fenced code before choosing the first readable line", () => {
    expect(titleFromMessageContent({
      blocks: [{
        text: "```ts\nconst secret = true;\n```\n## Explain the public result",
        type: "text"
      }]
    })).toBe("Explain the public result");
    expect(titleFromMessageContent({
      blocks: [{ text: "~~~\nprivate output\n~~~", type: "text" }]
    })).toBe(defaultChatTitle);
    expect(titleFromMessageContent({
      blocks: [{ text: "> ```ts\n> const secret = true;\n> ```\nReadable result", type: "text" }]
    })).toBe("Readable result");
    expect(titleFromMessageContent({
      blocks: [
        { text: "```ts\nconst secret = true;\n```", type: "text" },
        { text: "Readable second block", type: "text" }
      ]
    })).toBe("Readable second block");
    expect(titleFromMessageContent({
      blocks: [{
        text: "````ts\nprivate\n```not-a-close\nleaked\n````\nPublic result",
        type: "text"
      }]
    })).toBe("Public result");
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
