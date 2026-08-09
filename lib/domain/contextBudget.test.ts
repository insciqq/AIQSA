import { describe, expect, it } from "vitest";
import {
  applyContextBudget,
  calculateContextBudgetLimits,
  estimateApproxTokens,
  estimateApproxTokensFromCodePointCounts,
  estimateApproxTokensFromProjectedParts,
  type ContextBudgetMessage
} from "./contextBudget";

function message(id: string, role: "assistant" | "user", text: string): ContextBudgetMessage {
  return {
    content: {
      blocks: [{ text, type: "text" }]
    },
    id,
    role
  };
}

describe("context budget", () => {
  it("estimates multilingual and emoji input more conservatively than ASCII", () => {
    expect(estimateApproxTokens("a".repeat(8))).toBe(2);
    expect(estimateApproxTokens("я".repeat(8))).toBe(8);
    expect(estimateApproxTokens("界".repeat(8))).toBe(8);
    expect(estimateApproxTokens("😀".repeat(8))).toBe(16);
  });

  it("applies the same estimator to database-projected code-point counts", () => {
    const text = "ASCII\nПривет 😀😀";
    const occurrences = new Map<number, number>();
    for (const character of text) {
      const codePoint = character.codePointAt(0)!;
      occurrences.set(codePoint, (occurrences.get(codePoint) ?? 0) + 1);
    }

    expect(estimateApproxTokensFromCodePointCounts(
      [...occurrences].map(([codePoint, count]) => ({
        codePoint,
        occurrences: count
      }))
    )).toBe(estimateApproxTokens(text));
  });

  it("preserves text, non-text block, separator, Cyrillic, and emoji semantics in projections", () => {
    const text = "ASCII Привет 😀😀";
    const attachment = { attachmentId: "attachment-1", type: "attachment" };
    const occurrences = new Map<number, number>();
    for (const character of text) {
      const codePoint = character.codePointAt(0)!;
      occurrences.set(codePoint, (occurrences.get(codePoint) ?? 0) + 1);
    }

    expect(estimateApproxTokensFromProjectedParts([
      {
        counts: [...occurrences].map(([codePoint, count]) => ({
          codePoint,
          occurrences: count
        })),
        kind: "code_points"
      },
      { kind: "value", value: attachment }
    ])).toBe(estimateApproxTokens({
      blocks: [{ text, type: "text" }, attachment]
    }));
  });

  it("calculates the safe input budget after output reserve and margin", () => {
    expect(
      calculateContextBudgetLimits({
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000
      })
    ).toEqual({
      budgetTokens: 817_000,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      safetyMarginTokens: 105_000
    });

    expect(
      calculateContextBudgetLimits({
        contextWindow: 8192,
        maxOutputTokens: 8192,
        provider: "fake"
      }).budgetTokens
    ).toBe(7373);
  });

  it("keeps messages byte-identical when the branch fits", () => {
    const messages = [
      message("u1", "user", "hello"),
      message("a1", "assistant", "hi"),
      message("u2", "user", "next")
    ];
    const result = applyContextBudget({
      contextWindow: 1000,
      maxOutputTokens: 100,
      messages,
      prompt: {
        developer: "developer",
        system: "system"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.messages : []).toBe(messages);
    expect(result.ok ? result.truncation : null).toBeNull();
  });

  it("drops oldest prior turns whole while keeping newer adjacency", () => {
    const oldUser = message("u-old", "user", "u".repeat(200));
    const oldAssistant = message("a-old", "assistant", "a".repeat(200));
    const recentUser = message("u-recent", "user", "recent question");
    const recentAssistant = message("a-recent", "assistant", "recent answer");
    const current = message("u-current", "user", "current");
    const result = applyContextBudget({
      contextWindow: 130,
      maxOutputTokens: 20,
      messages: [oldUser, oldAssistant, recentUser, recentAssistant, current],
      prompt: {
        developer: "",
        system: ""
      }
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.messages.map((item) => item.id) : []).toEqual([
      "u-recent",
      "a-recent",
      "u-current"
    ]);
    expect(result.ok ? result.truncation : null).toMatchObject({
      approxDroppedTokens: estimateApproxTokens(oldUser.content) + estimateApproxTokens(oldAssistant.content),
      droppedMessages: 2,
      keptMessages: 3
    });
  });

  it("fails when the prompt and current user message exceed the budget", () => {
    const result = applyContextBudget({
      contextWindow: 100,
      maxOutputTokens: 20,
      messages: [message("u-current", "user", "x".repeat(400))]
    });

    expect(result).toMatchObject({
      code: "context_too_large",
      ok: false
    });
  });

  it("counts per-message extra tokens without mutating returned messages", () => {
    const current = message("u-current", "user", "short");
    const result = applyContextBudget({
      contextWindow: 100,
      maxOutputTokens: 20,
      messageExtraTokens: {
        "u-current": 90
      },
      messages: [current]
    });

    expect(result).toMatchObject({
      code: "context_too_large",
      ok: false
    });

    const fits = applyContextBudget({
      contextWindow: 200,
      maxOutputTokens: 20,
      messageExtraTokens: {
        "u-current": 40
      },
      messages: [current]
    });

    expect(fits.ok).toBe(true);
    expect(fits.ok ? fits.messages[0] : null).toBe(current);
    expect(JSON.stringify(fits.ok ? fits.messages[0]?.content : null)).not.toContain("extra");
  });
});
