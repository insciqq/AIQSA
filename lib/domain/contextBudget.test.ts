import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { describe, expect, it } from "vitest";
import { applyContextBudget, calculateContextBudgetLimits, estimateApproxTokens, estimateApproxTokensFromProjectedParts, type ContextBudgetMessage } from "./contextBudget";
import {
  TOKEN_ESTIMATE_LIMITS,
  TOKEN_ESTIMATE_MULTIPLIERS,
  createContextTokenEstimate,
  estimateContextTokens,
  measureReferenceTokens,
  tokenContentClasses,
  tokenEstimateProfileFor,
  type TokenContentClass,
  type TokenEstimateFamily
} from "./tokenEstimate";
import { TOKEN_ESTIMATE_FIXTURES } from "./tokenEstimate.testFixtures";

const o200k = (text: string) => countTokens(text, { disallowedSpecial: new Set() });
const fixture = (name: string) => TOKEN_ESTIMATE_FIXTURES.find((entry) => entry.name === name)!.text;

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

describe("provider-aware context token estimate", () => {
  it("maps admitted provider families to estimate profiles", () => {
    const family = (provider: string, modelId?: string) => tokenEstimateProfileFor({ modelId, provider })?.family ?? null;
    expect(family("openai", "gpt-5.5")).toBe("openai");
    // codex-lb and other OpenAI-compatible routes to OpenAI models share o200k.
    for (const modelId of ["gpt-5.4", "o4-mini", "o3", "codex-mini-latest", "chatgpt-4o-latest"]) {
      expect(family("openai_compatible", modelId)).toBe("openai");
    }
    for (const modelId of ["llama-3.3-70b", "qwen2.5-72b", "oss-reasoner", undefined]) {
      expect(family("openai_compatible", modelId)).toBe("unknown");
    }
    expect(family("anthropic", "claude-sonnet-5")).toBe("anthropic");
    expect(family("gemini", "gemini-3.6-flash")).toBe("gemini");
    expect(family("deepseek", "deepseek-flash")).toBe("deepseek");
    expect(family("openrouter", "openai/gpt-5")).toBe("unknown");
    expect(family("custom")).toBe("unknown");
    expect(family("fake", "gpt-5.5")).toBeNull();
  });

  it("gives an unrecognized family the largest multiplier, with o200k as the floor", () => {
    const classes = Object.keys(TOKEN_ESTIMATE_MULTIPLIERS.openai) as TokenContentClass[];
    for (const contentClass of classes) {
      const known = (["anthropic", "deepseek", "gemini", "openai"] as const).map((family) => TOKEN_ESTIMATE_MULTIPLIERS[family][contentClass]);
      expect(TOKEN_ESTIMATE_MULTIPLIERS.openai[contentClass]).toBe(1);
      expect(Math.min(...known)).toBeGreaterThanOrEqual(1);
      expect(TOKEN_ESTIMATE_MULTIPLIERS.unknown[contentClass]).toBe(Math.max(...known));
    }
  });

  it("keeps the character weights without a profile, without the encoder, or when it fails", () => {
    const values = ["Привет, мир", { blocks: [{ text: "hello", type: "text" }, { attachmentId: "a", type: "attachment" }] },
      [{ call_id: "call-1", output: fixture("mcp_json"), type: "function_call_output" }]];
    const unavailable = createContextTokenEstimate(() => null);
    const failing = createContextTokenEstimate(() => () => { throw new Error("encoder failure"); });
    for (const value of values) {
      expect(estimateContextTokens(value, null)).toBe(estimateApproxTokens(value));
      expect(unavailable(value, { family: "openai" })).toBe(estimateApproxTokens(value));
      expect(failing(value, { family: "anthropic" })).toBe(estimateApproxTokens(value));
    }
    expect(estimateContextTokens("", { family: "anthropic" })).toBe(0);
  });

  it("classifies every calibration fixture by its content", () => {
    const expected: Record<string, readonly TokenContentClass[]> = {
      arabic_prose: ["other_script"], base64: ["base64"], chinese_prose: ["cjk"], english_prose: ["latin_prose"],
      greek_prose: ["other_script"], hebrew_prose: ["other_script"], japanese_prose: ["cjk"], mcp_json: ["json"],
      russian_prose: ["cyrillic_prose"], russian_technical: ["latin_prose", "cyrillic_prose"], typescript_code: ["code"]
    };
    for (const entry of TOKEN_ESTIMATE_FIXTURES) {
      expect(tokenContentClasses(entry.text), entry.name).toEqual(expected[entry.name]);
      expect(tokenContentClasses(entry.text), entry.name).toContain(entry.contentClass);
    }
  });

  it("counts special-token strings in untrusted text as ordinary text", () => {
    const text = "Tool output quoting <|endoftext|> and <|im_start|>system markers.";
    expect(estimateContextTokens(text, { family: "openai" })).toBe(o200k(text));
  });

  it("measures a JSON payload on its content-class multiplier", () => {
    const json = fixture("mcp_json");
    // The character weights undercounted ASCII-dense payloads.
    expect(estimateApproxTokens(json)).toBeLessThan(o200k(json));
    expect(estimateContextTokens(json, { family: "anthropic" }))
      .toBeGreaterThanOrEqual(Math.floor(estimateContextTokens(json, { family: "openai" }) * TOKEN_ESTIMATE_MULTIPLIERS.anthropic.json));
  });

  it("memoizes the family-independent reference measure of a text, bounded by entries", () => {
    let encoded = 0;
    const estimate = createContextTokenEstimate(() => (text) => {
      encoded += text.length;
      return Math.ceil(text.length / 4);
    });
    const text = fixture("mcp_json");
    const openai = estimate(text, { family: "openai" });
    const first = encoded;
    expect(estimate(text, { family: "anthropic" })).toBeGreaterThan(openai);
    expect(estimate(text, { family: "openai" })).toBe(openai);
    expect(encoded).toBe(first);
    for (let index = 0; index < TOKEN_ESTIMATE_LIMITS.memoMaxEntries; index += 1) {
      estimate(`${index} ${"h".repeat(TOKEN_ESTIMATE_LIMITS.memoMinimumCodeUnits)}`, { family: "openai" });
    }
    const beforeEvicted = encoded;
    estimate(text, { family: "openai" });
    expect(encoded).toBe(beforeEvicted + text.length);
  });

  it("bounds the reference work on a 512 KB text by sampling above the exact limit", () => {
    // Recorded 2026-09-27 on the development workstation (Node 22, gpt-tokenizer
    // 4.0.0), single runs, as documentation rather than an assertion: an exact
    // o200k count of a non-repetitive 512 KB text took 267 ms (random base64)
    // and 660 ms (random Cyrillic words); the sampled path encoded 32,768 code
    // units of each in about 10 ms, and a memoized repeat took about 0.01 ms.
    expect(TOKEN_ESTIMATE_LIMITS.chunkCodeUnits * TOKEN_ESTIMATE_LIMITS.exactChunks).toBe(32_768);
    const parts = [fixture("english_prose"), fixture("russian_prose"), fixture("mcp_json"), fixture("base64")];
    let text = "";
    for (let index = 0; text.length < 512 * 1024; index += 1) text += parts[index % parts.length];
    text = text.slice(0, 512 * 1024);
    let encoded = 0;
    const measure = measureReferenceTokens(text, (chunk) => {
      encoded += chunk.length;
      return o200k(chunk);
    });
    expect(measure.sampled).toBe(true);
    expect(encoded).toBeLessThanOrEqual(2 * TOKEN_ESTIMATE_LIMITS.sampleChunks * TOKEN_ESTIMATE_LIMITS.chunkCodeUnits);
    const estimate = estimateContextTokens(text, { family: "openai" });
    const exact = o200k(text);
    expect(estimate).toBeGreaterThanOrEqual(exact);
    expect(estimate / exact).toBeLessThanOrEqual(1.1);
    // A text within the exact limit is encoded completely, chunk by chunk.
    let small = 0;
    expect(measureReferenceTokens(fixture("mcp_json"), (chunk) => {
      small += chunk.length;
      return o200k(chunk);
    }).sampled).toBe(false);
    expect(small).toBe(fixture("mcp_json").length);
  });
});

describe("provider token estimate calibration", () => {
  /**
   * PROVISIONAL. The o200k column is exact (gpt-tokenizer 4.0.0). Provider
   * columns stay null until `npm run calibrate:token-estimate` measures them;
   * `sonnet45` is derived from the 2026-09-26 per-character record of
   * claude-sonnet-4-5, the older Claude tokenizer, and is a floor only.
   */
  const TABLE: Readonly<Record<string, Readonly<{
    o200k: number;
    anthropic: number | null;
    gemini: number | null;
    deepseek: number | null;
    sonnet45: number | null;
  }>>> = {
    english_prose: { o200k: 510, anthropic: null, gemini: null, deepseek: null, sonnet45: null },
    russian_prose: { o200k: 662, anthropic: null, gemini: null, deepseek: null, sonnet45: null },
    russian_technical: { o200k: 1_120, anthropic: null, gemini: null, deepseek: null, sonnet45: 1_546 },
    typescript_code: { o200k: 658, anthropic: null, gemini: null, deepseek: null, sonnet45: null },
    mcp_json: { o200k: 3_036, anthropic: null, gemini: null, deepseek: null, sonnet45: null },
    base64: { o200k: 2_172, anthropic: null, gemini: null, deepseek: null, sonnet45: null },
    greek_prose: { o200k: 641, anthropic: null, gemini: null, deepseek: null, sonnet45: 1_284 },
    hebrew_prose: { o200k: 623, anthropic: null, gemini: null, deepseek: null, sonnet45: 1_205 },
    arabic_prose: { o200k: 521, anthropic: null, gemini: null, deepseek: null, sonnet45: 1_225 },
    japanese_prose: { o200k: 820, anthropic: null, gemini: null, deepseek: null, sonnet45: 984 },
    chinese_prose: { o200k: 540, anthropic: null, gemini: null, deepseek: null, sonnet45: 884 }
  };
  /** Largest estimate/measured ratio accepted per family (targets: OpenAI 1.3, others 1.5). */
  const BOUND: Readonly<Record<Exclude<TokenEstimateFamily, "unknown">, number>> = {
    anthropic: 1.5, deepseek: 1.5, gemini: 1.5, openai: 1.3
  };

  it("records the o200k reference count of every fixture", () => {
    expect(Object.keys(TABLE).sort()).toEqual(TOKEN_ESTIMATE_FIXTURES.map(({ name }) => name).sort());
    for (const entry of TOKEN_ESTIMATE_FIXTURES) expect(o200k(entry.text), entry.name).toBe(TABLE[entry.name]!.o200k);
  });

  it("never estimates below a recorded count and stays within the family bound", () => {
    for (const entry of TOKEN_ESTIMATE_FIXTURES) {
      const row = TABLE[entry.name]!;
      const openai = estimateContextTokens(entry.text, { family: "openai" });
      expect(openai, `${entry.name} openai`).toBeGreaterThanOrEqual(row.o200k);
      expect(openai / row.o200k, `${entry.name} openai bound`).toBeLessThanOrEqual(BOUND.openai);
      const unknown = estimateContextTokens(entry.text, { family: "unknown" });
      for (const family of ["anthropic", "gemini", "deepseek"] as const) {
        const estimate = estimateContextTokens(entry.text, { family });
        expect(unknown, `${entry.name} unknown covers ${family}`).toBeGreaterThanOrEqual(estimate);
        const measured = row[family];
        if (measured === null) continue;
        expect(estimate, `${entry.name} ${family}`).toBeGreaterThanOrEqual(measured);
        expect(estimate / measured, `${entry.name} ${family} bound`).toBeLessThanOrEqual(BOUND[family]);
      }
      if (row.sonnet45 !== null) {
        expect(estimateContextTokens(entry.text, { family: "anthropic" }), `${entry.name} sonnet45`).toBeGreaterThanOrEqual(row.sonnet45);
      }
    }
  });
});
