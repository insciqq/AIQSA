import { describe, expect, it } from "vitest";
import { adminAttentionItemSource, decodeAdminAttentionResponse } from "./adminAttention";

const item = {
  action: "Review users",
  code: "users_pending_approval",
  count: 3,
  detail: "pending@aiqsa.test and 2 more",
  id: "users_pending_approval",
  severity: "warn",
  target: { filter: "pending", section: "users" },
  title: "Users are waiting for approval"
};

describe("decodeAdminAttentionResponse", () => {
  it("accepts a well-formed list and normalizes optional target fields", () => {
    const decoded = decodeAdminAttentionResponse({
      attention: {
        checkedAt: "2026-09-07T12:00:00.000Z",
        items: [item, { ...item, count: null, id: "email", target: { section: "email" } }],
        unavailable: ["memory", "memory"]
      }
    });
    expect(decoded?.attention.items).toHaveLength(2);
    expect(decoded?.attention.items[1]?.target).toEqual({ section: "email" });
    expect(decoded?.attention.unavailable).toEqual(["memory"]);
  });

  it("accepts pending Assistant listing requests as an Assistants item", () => {
    const assistants = { ...item, code: "assistants_listing_pending", id: "assistants_listing_pending",
      target: { filter: "requests", section: "assistants" } };
    const decoded = decodeAdminAttentionResponse({
      attention: { checkedAt: "2026-09-07T12:00:00.000Z", items: [assistants], unavailable: ["assistants"] }
    });
    expect(decoded?.attention.items[0]?.target).toEqual({ filter: "requests", section: "assistants" });
    expect(adminAttentionItemSource(decoded!.attention.items[0]!)).toBe("assistants");
    expect(decoded?.attention.unavailable).toEqual(["assistants"]);
  });

  it("rejects unknown codes, sections, sources, control characters and duplicate ids", () => {
    const base = { checkedAt: "2026-09-07T12:00:00.000Z", items: [item], unavailable: [] };
    expect(decodeAdminAttentionResponse({ attention: { ...base, items: [{ ...item, code: "mystery" }] } })).toBeNull();
    expect(decodeAdminAttentionResponse({ attention: { ...base, items: [{ ...item, target: { section: "usage" } }] } })).toBeNull();
    expect(decodeAdminAttentionResponse({ attention: { ...base, unavailable: ["release"] } })).toBeNull();
    expect(decodeAdminAttentionResponse({ attention: { ...base, items: [{ ...item, detail: "bad" }] } })).toBeNull();
    expect(decodeAdminAttentionResponse({ attention: { ...base, items: [item, item] } })).toBeNull();
    expect(decodeAdminAttentionResponse({ attention: { ...base, items: [{ ...item, count: -1 }] } })).toBeNull();
    expect(decodeAdminAttentionResponse({ attention: { ...base, checkedAt: "yesterday" } })).toBeNull();
    expect(decodeAdminAttentionResponse({ items: [] })).toBeNull();
  });
});
