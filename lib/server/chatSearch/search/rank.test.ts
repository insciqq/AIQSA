import { describe, expect, it } from "vitest";
import { capPastChatHits, fusePastChatLanes, pastChatExcerpt, rerankedPastChatOrder, type PastChatWordHit } from "./rank";

const at = (day: number) => new Date(Date.UTC(2026, 10, day));
const hit = (id: string, chatId = `chat-${id}`, userMessageId = `turn-${id}`, day = 1) => ({ chatId, id, turnAt: at(day), userMessageId });
const word = (id: string, options: Partial<PastChatWordHit> = {}): PastChatWordHit => ({ ...hit(id), pinned: false, terms: [], ...options });

describe("past-chat fusion", () => {
  it("adds both lanes' reciprocal ranks, so agreement outranks one lane's first place", () => {
    const fused = fusePastChatLanes([word("a"), word("b"), word("c")], [hit("c"), hit("d"), hit("a")]);
    // a: 1/61 + 1/63, c: 1/63 + 1/61, so the tie goes to the id; b and d each have one lane.
    expect(fused.map((entry) => entry.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0]!.fused).toBeCloseTo(1 / 61 + 1 / 63);
  });

  it("puts pinned identifier matches first, even below a stronger fused score", () => {
    const fused = fusePastChatLanes([word("semantic"), word("ticket", { pinned: true })], [hit("semantic"), hit("other")]);
    expect(fused.map((entry) => entry.id)).toEqual(["ticket", "semantic", "other"]);
  });

  it("breaks a tie by the newer turn and keeps each turn once, by its best window", () => {
    const fused = fusePastChatLanes([word("old", { turnAt: at(1) }), word("w1", { chatId: "c", userMessageId: "t" })],
      [hit("new", "chat-new", "turn-new", 9), hit("w2", "c", "t")]);
    expect(fused.map((entry) => entry.id)).toEqual(["new", "old", "w1"]);
  });

  it("caps one chat's results and keeps the order", () => {
    const hits = ["a", "b", "c", "d", "e", "f"].map((id, index) => hit(id, index < 4 ? "long" : `chat-${id}`));
    expect(capPastChatHits(hits, 8, 3).map((entry) => entry.id)).toEqual(["a", "b", "c", "e", "f"]);
    expect(capPastChatHits(hits, 2, 3).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("reorders what the reranker scored, then the rest in fused order, pinned turns first", () => {
    const fused = [{ id: "a", pinned: true }, { id: "b", pinned: false }, { id: "c", pinned: false }, { id: "d", pinned: false }];
    const order = rerankedPastChatOrder(fused, new Map([["a", 0.1], ["b", 0.2], ["c", 0.9]]));
    expect(order.map((entry) => entry.id)).toEqual(["a", "c", "b", "d"]);
  });
});

describe("past-chat excerpts", () => {
  it("returns a short passage whole and centers a long one on its first matched term", () => {
    expect(pastChatExcerpt("  short text  ", ["text"], 100)).toBe("short text");
    const text = `${"filler words ".repeat(200)}the ABC-1234 rollout plan ${"tail words ".repeat(200)}`;
    const excerpt = pastChatExcerpt(text, ["abc-1234"], 300);
    expect(excerpt.length).toBeLessThanOrEqual(300);
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).toContain("ABC-1234 rollout");
  });

  it("finds a phrase joined differently in the passage and starts at the beginning without a match", () => {
    const text = `${"x ".repeat(400)}campaign 42 results ${"y ".repeat(400)}`;
    expect(pastChatExcerpt(text, ["campaign_42"], 200)).toContain("campaign 42");
    const plain = pastChatExcerpt(text, [], 200);
    expect(plain.startsWith("x x")).toBe(true);
    expect(plain.length).toBeLessThanOrEqual(200);
  });

  it("matches case-insensitively in any script and never starts inside a surrogate pair", () => {
    const text = `${"😀".repeat(300)}Отчёт по кампании${"z".repeat(600)}`;
    const excerpt = pastChatExcerpt(text, ["отчёт"], 120);
    expect(excerpt).toContain("Отчёт");
    expect(/^[\uDC00-\uDFFF]/u.test(excerpt.replace(/^…/u, ""))).toBe(false);
  });
});
