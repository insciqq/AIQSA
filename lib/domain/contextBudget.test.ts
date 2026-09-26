import { describe, expect, it } from "vitest";
import { applyContextBudget, calculateContextBudgetLimits, estimateApproxTokens, estimateApproxTokensFromProjectedParts, type ContextBudgetMessage } from "./contextBudget";

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
  it("trims an old question and its clarifications as one turn", () => {
    const messages = [message("original", "user", "x".repeat(200)),
      { ...message("partial", "assistant", "p".repeat(200)), contextTurnId: "original" },
      { ...message("clarification", "user", "c".repeat(200)), contextTurnId: "original" },
      message("answer", "assistant", "a".repeat(200)), message("current", "user", "next")];
    const result = applyContextBudget({ messages, contextWindow: 130, maxOutputTokens: 20 });
    expect(result.ok && result.messages.map(item => item.id)).toEqual(["current"]);
  });

  it("cannot keep a current clarification by discarding its original question", () => {
    const result = applyContextBudget({ contextWindow: 130, maxOutputTokens: 20, messages: [
      message("original", "user", "x".repeat(800)),
      { ...message("clarification", "user", "short clarification"), contextTurnId: "original" }
    ] });
    expect(result).toMatchObject({ ok: false, code: "context_too_large" });
  });

  it("estimates multilingual and emoji input more conservatively than ASCII", () => {
    expect(estimateApproxTokens("a".repeat(8))).toBe(2);
    expect(estimateApproxTokens("я".repeat(8))).toBe(4);
    expect(estimateApproxTokens("α".repeat(10))).toBe(8);
    expect(estimateApproxTokens("日".repeat(8))).toBe(8);
    expect(estimateApproxTokens("界".repeat(8))).toBe(8);
    expect(estimateApproxTokens("😀".repeat(8))).toBe(16);
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

describe("token estimate calibration", () => {
  // Recorded on 2026-09-26 with the Anthropic count_tokens endpoint (claude-sonnet-4-5),
  // the least efficient measured tokenizer, in tokens per non-ASCII character.
  const anthropicPerCharacter = { cyrillicProse: 0.441, cyrillicTechnical: 0.513, greek: 0.792, hebrew: 0.792, arabic: 0.701, japanese: 0.979, chinese: 1.028 };
  const samples = {
    cyrillicProse: "Пользователь просит подготовить отчёт о продажах за третий квартал, учесть возвраты и не включать тестовые заказы. ".repeat(20),
    cyrillicTechnical: "Ошибка воспроизводится при запуске миграции: колонка получает значение v1, но старые записи без policy остаются на legacy-пути; проверьте логи контейнера app-1 за 26.09.2026 14:35 UTC. ".repeat(20),
    greek: "Ο χρήστης ζητά μια αναφορά πωλήσεων για το τρίτο τρίμηνο, λαμβάνοντας υπόψη τις επιστροφές. ".repeat(20),
    hebrew: "המשתמש מבקש להכין דוח מכירות לרבעון השלישי, לקחת בחשבון החזרות ולא לכלול הזמנות בדיקה. ".repeat(20),
    arabic: "يطلب المستخدم إعداد تقرير عن مبيعات الربع الثالث مع مراعاة المرتجعات واستبعاد الطلبات التجريبية. ".repeat(20),
    japanese: "ユーザーは第3四半期の売上レポートの作成を依頼し、返品を考慮し、テスト注文を除外するよう求めています。".repeat(20),
    chinese: "用户要求准备第三季度的销售报告，考虑退货并排除测试订单。经理明确了期限、预算和负责人。".repeat(20)
  } as const;

  it("never estimates below the least efficient measured tokenizer and stays within 3x of o200k", async () => {
    const { encode } = await import("gpt-tokenizer/encoding/o200k_base");
    for (const [name, text] of Object.entries(samples) as [keyof typeof samples, string][]) {
      const estimate = estimateApproxTokens(text);
      const characters = [...text].length;
      const nonAscii = [...text].filter((character) => (character.codePointAt(0) ?? 0) > 0x7f).length;
      const recorded = (characters - nonAscii) * 0.25 + nonAscii * anthropicPerCharacter[name];
      expect(estimate, `${name} vs recorded Anthropic count`).toBeGreaterThanOrEqual(Math.floor(recorded * 0.97));
      const o200k = encode(text).length;
      expect(estimate, `${name} vs o200k`).toBeGreaterThanOrEqual(o200k);
      expect(estimate / o200k, `${name} overestimate against o200k`).toBeLessThanOrEqual(3);
    }
  });
});
