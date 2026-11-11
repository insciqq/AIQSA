import { describe, expect, it } from "vitest";
import { contextTokenEstimator } from "../../domain/tokenEstimate";
import { compactableFixedTokens } from "../engine/compaction/policy";
import { providerAttachmentBudgetTokens } from "../providers/attachmentPayload";
import type { ProviderAttachment, ProviderRunRequest } from "../providers/types";
import { applyProviderRequestContextBudget } from "./requestContextBudget";

/** gpt-6-astra on psaux: window 700 000, output 65 536, so usable 634 464 and the background threshold at 456 814. */
const PRODUCTION = { contextWindow: 700_000, defaultMaxOutputTokens: 65_536 };
const MARKER = "\n[truncated for model context]";
const SHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** The fake route's estimate: character weights, a quarter token per ASCII character. */
const estimate = contextTokenEstimator({ modelId: "fake-qsa", provider: "fake" });

function sheet(index: number, characters: number): ProviderAttachment {
  return { byteSize: characters, extractedText: `sheet ${index}\n${"s".repeat(characters)}`, fileName: `sheet-${index}.xlsx`,
    id: `sheet-${index}`, kind: "document", metadata: {}, mimeType: SHEET_TYPE, status: "ready" };
}

function request(attachments: ProviderAttachment[], system = "Be brief.",
  window: Readonly<{ contextWindow: number; defaultMaxOutputTokens: number }> = PRODUCTION): ProviderRunRequest {
  return {
    attachmentIds: attachments.map((attachment) => attachment.id), attachments, chatId: "chat",
    content: { blocks: [{ text: "Build the summary workbook from the attached spreadsheets.", type: "text" }] },
    modelCapabilities: { ...window, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true,
      vision: false },
    modelId: "fake-qsa", params: {}, prompt: { developer: null, system }, provider: "fake",
    searchPlan: { mode: "all_selected", options: [] }, toolChoice: "auto", toolMode: "auto", tools: []
  };
}

const textTokens = (attachments: ProviderAttachment[]) => providerAttachmentBudgetTokens({ attachments, estimateTokens: estimate,
  modelCapabilities: request([]).modelCapabilities });

describe("attachment text at admission", () => {
  const cap = compactableFixedTokens({ contextWindow: 700_000, maxOutputTokens: 65_536 });

  it("stays below the background threshold less the working margin, each cut text marked, short ones whole (2026-11-11)", () => {
    // Four spreadsheets of about 150 000 tokens each and a short one: 600 000 tokens, which the window's budget alone
    // (700 000 less the output and a 10% margin, 564 464) would have let fill almost the whole of it.
    const large = [1, 2, 3, 4].map((index) => sheet(index, 600_000));
    const short = sheet(5, 2_000);
    const result = applyProviderRequestContextBudget({ request: request([...large, short]) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attachments = result.request.attachments;
    expect(cap).toBe(361_644);
    expect(textTokens(attachments)).toBeLessThanOrEqual(cap);
    expect(textTokens(attachments)).toBeGreaterThan(cap - 1_000);
    for (const [index, attachment] of attachments.entries()) {
      if (index < 4) {
        expect(attachment.extractedText!.endsWith(MARKER)).toBe(true);
        expect(attachment.extractedText!.startsWith(`sheet ${index + 1}\n`)).toBe(true);
      } else {
        expect(attachment.extractedText).toBe(short.extractedText);
      }
    }
    // The cut texts share the room evenly.
    const lengths = attachments.slice(0, 4).map((attachment) => attachment.extractedText!.length);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(16);
  });

  it("leaves text within the cap untouched", () => {
    const attachments = [sheet(1, 400_000), sheet(2, 400_000)];
    const result = applyProviderRequestContextBudget({ request: request(attachments) });
    expect(result.ok && result.request.attachments.map((attachment) => attachment.extractedText))
      .toEqual(attachments.map((attachment) => attachment.extractedText));
  });

  it("keeps the budget's room where the rest of the fixed part alone reaches the cap, and refuses only past the budget", () => {
    // The instructions alone measure 400 000, past the cap: cutting the text to nothing would free no room a compaction
    // could use, so the two texts share what the budget leaves (564 464 less the instructions), as before the cap.
    const result = applyProviderRequestContextBudget({ request: request([sheet(1, 600_000), sheet(2, 600_000)], "i".repeat(1_600_000)) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(textTokens(result.request.attachments)).toBeGreaterThan(164_000);
    expect(textTokens(result.request.attachments)).toBeLessThanOrEqual(164_464);
    for (const attachment of result.request.attachments) expect(attachment.extractedText!.endsWith(MARKER)).toBe(true);
    // Past the budget the request is refused as before.
    expect(applyProviderRequestContextBudget({ request: request([sheet(1, 600_000)], "i".repeat(2_400_000)) }))
      .toMatchObject({ error: { code: "context_too_large" }, ok: false, status: 400 });
  });

  it("on a 128k window, caps the text beside a small fixed part and keeps the old allowance beside a large one", () => {
    // Window 128 000, output 16 384: budget 98 816 (with the 10% margin), usable 111 616, cap 80 363 - 16 743 = 63 620.
    const window = { contextWindow: 128_000, defaultMaxOutputTokens: 16_384 };
    expect(compactableFixedTokens({ contextWindow: 128_000, maxOutputTokens: 16_384 })).toBe(63_620);
    const small = applyProviderRequestContextBudget({ request: request([sheet(1, 400_000)], "Be brief.", window) });
    expect(small.ok).toBe(true);
    if (!small.ok) return;
    expect(textTokens(small.request.attachments)).toBeLessThanOrEqual(63_620);
    expect(textTokens(small.request.attachments)).toBeGreaterThan(63_000);
    expect(small.request.attachments[0]!.extractedText!.endsWith(MARKER)).toBe(true);
    // Instructions, tools and a loaded MCP catalog of 70 000 already pass the cap: the text keeps the 28 816 or so the
    // budget leaves, instead of its first character.
    const large = applyProviderRequestContextBudget({ request: request([sheet(1, 200_000)], "i".repeat(280_000), window) });
    expect(large.ok).toBe(true);
    if (!large.ok) return;
    expect(textTokens(large.request.attachments)).toBeGreaterThan(28_000);
    expect(textTokens(large.request.attachments)).toBeLessThanOrEqual(98_816 - 70_000);
    expect(large.request.attachments[0]!.extractedText!.endsWith(MARKER)).toBe(true);
  });
});
