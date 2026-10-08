import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { describe, expect, it } from "vitest";
import { APPROX_TOKEN_WEIGHT_CLASSES, applyContextBudget, calculateContextBudgetLimits, estimateApproxTokens, estimateApproxTokensFromProjectedParts, type ContextBudgetMessage } from "./contextBudget";
import {
  TOKEN_ESTIMATE_LIMITS,
  TOKEN_ESTIMATE_MULTIPLIERS,
  createContextTokenEstimate,
  estimateContextTokens,
  measureReferenceTokens,
  tokenContentClasses,
  tokenEstimateProfileFor,
  type TokenContentClass
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
  it("never trims history: a branch over the budget is refused whole", () => {
    const messages = [message("original", "user", "x".repeat(200)),
      { ...message("partial", "assistant", "p".repeat(200)), contextTurnId: "original" },
      { ...message("clarification", "user", "c".repeat(200)), contextTurnId: "original" },
      message("answer", "assistant", "a".repeat(200)), message("current", "user", "next")];
    expect(applyContextBudget({ messages, contextWindow: 130, maxOutputTokens: 20 })).toMatchObject({ ok: false, code: "context_too_large" });
    const fitting = applyContextBudget({ messages, contextWindow: 1_000, maxOutputTokens: 20 });
    expect(fitting.ok && fitting.messages).toBe(messages);
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

  it("estimates exactly, whatever order the characters are counted in", () => {
    // 24 × 0.25 + 5 × 0.8 is exactly 10; summed one character at a time in
    // floating point it came out above 10 and rounded up to 11.
    const text = `${"a".repeat(24)}αβγδε`;
    expect(estimateApproxTokens(text)).toBe(10);
    expect(estimateApproxTokensFromProjectedParts([{ counts: [
      { codePoint: "α".codePointAt(0)!, occurrences: 5 }, { codePoint: "a".codePointAt(0)!, occurrences: 24 }
    ], kind: "code_points" }])).toBe(10);
  });

  it("weighs every character of a fixed-weight class with that class's weight", () => {
    const seen = new Set<number>();
    for (const { ranges, weight } of APPROX_TOKEN_WEIGHT_CLASSES) {
      for (const [first, last] of ranges) {
        for (let codePoint = first; codePoint <= last; codePoint += 1) {
          expect(seen.has(codePoint)).toBe(false);
          seen.add(codePoint);
          // Twenty occurrences tell the weights 0.25, 0.5, 0.8, 1 and 2 apart.
          expect(estimateApproxTokensFromProjectedParts([
            { counts: [{ codePoint, occurrences: 20 }], kind: "code_points" }
          ])).toBe(Math.ceil(weight * 20));
        }
      }
    }
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
   * Measured 2026-09-26T21:20:44Z with scripts/calibrate-token-estimate.ts:
   * Anthropic count_tokens (claude-sonnet-5, claude-opus-5), Gemini
   * countTokens (gemini-3.6-flash) and DeepSeek usage.prompt_tokens
   * (deepseek-flash); reference o200k_base from gpt-tokenizer 4.0.0. Counts
   * are net of a one-character baseline request (Anthropic 7, Gemini 2,
   * DeepSeek 31): net = raw - baseline + 1. Ratios are net / o200k.
   */
  const MODELS = {
    "claude-opus-5": "anthropic", "claude-sonnet-5": "anthropic", "deepseek-flash": "deepseek", "gemini-3.6-flash": "gemini"
  } as const;
  type Model = keyof typeof MODELS;
  const TABLE: Readonly<Record<string, Readonly<{ o200k: number; net: Readonly<Record<Model, number>> }>>> = {
    english_prose: { o200k: 510, net: { "claude-sonnet-5": 762, "claude-opus-5": 762, "gemini-3.6-flash": 516, "deepseek-flash": 512 } },
    russian_prose: { o200k: 662, net: { "claude-sonnet-5": 1_022, "claude-opus-5": 1_022, "gemini-3.6-flash": 647, "deepseek-flash": 777 } },
    russian_technical: { o200k: 1_120, net: { "claude-sonnet-5": 1_581, "claude-opus-5": 1_580, "gemini-3.6-flash": 1_180, "deepseek-flash": 1_261 } },
    typescript_code: { o200k: 658, net: { "claude-sonnet-5": 1_060, "claude-opus-5": 1_060, "gemini-3.6-flash": 823, "deepseek-flash": 696 } },
    mcp_json: { o200k: 3_036, net: { "claude-sonnet-5": 4_814, "claude-opus-5": 4_814, "gemini-3.6-flash": 3_530, "deepseek-flash": 3_388 } },
    base64: { o200k: 2_172, net: { "claude-sonnet-5": 3_010, "claude-opus-5": 3_010, "gemini-3.6-flash": 2_242, "deepseek-flash": 2_199 } },
    greek_prose: { o200k: 641, net: { "claude-sonnet-5": 1_281, "claude-opus-5": 1_280, "gemini-3.6-flash": 681, "deepseek-flash": 861 } },
    hebrew_prose: { o200k: 623, net: { "claude-sonnet-5": 1_201, "claude-opus-5": 1_200, "gemini-3.6-flash": 782, "deepseek-flash": 743 } },
    arabic_prose: { o200k: 521, net: { "claude-sonnet-5": 1_221, "claude-opus-5": 1_220, "gemini-3.6-flash": 601, "deepseek-flash": 661 } },
    japanese_prose: { o200k: 820, net: { "claude-sonnet-5": 980, "claude-opus-5": 980, "gemini-3.6-flash": 620, "deepseek-flash": 740 } },
    chinese_prose: { o200k: 540, net: { "claude-sonnet-5": 880, "claude-opus-5": 880, "gemini-3.6-flash": 520, "deepseek-flash": 480 } }
  };
  /** Largest estimate / measured count per class for Anthropic, Gemini and
   * DeepSeek (targets: at most 1.5); the OpenAI family stays within 1.05 of
   * o200k (target: at most 1.3). CJK is widest: Japanese on the Chinese-driven
   * Anthropic multiplier and o200k's floor on Gemini. */
  const BOUND: Readonly<Record<TokenContentClass, number>> = {
    base64: 1.1, cjk: 1.45, code: 1.05, cyrillic_prose: 1.15, json: 1.05, latin_prose: 1.1, other_script: 1.3
  };
  const OPENAI_BOUND = 1.05;
  const fixtureClass = (name: string) => TOKEN_ESTIMATE_FIXTURES.find((entry) => entry.name === name)!.contentClass;

  it("records the o200k reference count of every fixture", () => {
    expect(Object.keys(TABLE).sort()).toEqual(TOKEN_ESTIMATE_FIXTURES.map(({ name }) => name).sort());
    for (const entry of TOKEN_ESTIMATE_FIXTURES) expect(o200k(entry.text), entry.name).toBe(TABLE[entry.name]!.o200k);
  });

  it("sets each multiplier just above the largest measured ratio of its class", () => {
    for (const family of ["anthropic", "deepseek", "gemini"] as const) {
      for (const contentClass of Object.keys(BOUND) as TokenContentClass[]) {
        const ratios = Object.entries(TABLE).filter(([name]) => fixtureClass(name) === contentClass)
          .flatMap(([, row]) => (Object.keys(MODELS) as Model[]).filter((model) => MODELS[model] === family)
            .map((model) => row.net[model] / row.o200k));
        const floor = Math.max(1, ...ratios);
        const multiplier = TOKEN_ESTIMATE_MULTIPLIERS[family][contentClass];
        expect(multiplier, `${family} ${contentClass}`).toBeGreaterThanOrEqual(floor);
        expect(multiplier, `${family} ${contentClass}`).toBeLessThanOrEqual(Math.max(1, floor * 1.02) + 0.05);
      }
    }
  });

  it("never estimates below a measured count and stays within the recorded class bound", () => {
    for (const bound of Object.values(BOUND)) expect(bound).toBeLessThanOrEqual(1.5);
    expect(OPENAI_BOUND).toBeLessThanOrEqual(1.3);
    for (const entry of TOKEN_ESTIMATE_FIXTURES) {
      const row = TABLE[entry.name]!;
      const openai = estimateContextTokens(entry.text, { family: "openai" });
      expect(openai, `${entry.name} openai`).toBeGreaterThanOrEqual(row.o200k);
      expect(openai / row.o200k, `${entry.name} openai bound`).toBeLessThanOrEqual(OPENAI_BOUND);
      const unknown = estimateContextTokens(entry.text, { family: "unknown" });
      for (const model of Object.keys(MODELS) as Model[]) {
        const family = MODELS[model];
        const estimate = estimateContextTokens(entry.text, { family });
        const measured = row.net[model];
        expect(estimate, `${entry.name} ${model}`).toBeGreaterThanOrEqual(measured);
        expect(estimate / measured, `${entry.name} ${model} bound`).toBeLessThanOrEqual(BOUND[entry.contentClass]);
        expect(unknown, `${entry.name} unknown covers ${family}`).toBeGreaterThanOrEqual(estimate);
      }
    }
  });
});
