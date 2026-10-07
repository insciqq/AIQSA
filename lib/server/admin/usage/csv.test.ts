import { describe, expect, it } from "vitest";
import { emptyUsageAmounts } from "./analytics";
import { formatUsageUsd, usageCsvLines, usageCsvTextCell, usageExportFilename } from "./csv";
import { rawUsageModelKey } from "./models";

describe("usage CSV", () => {
  it("neutralises formula prefixes and quotes per RFC 4180", () => {
    expect(usageCsvTextCell("Alice")).toBe("Alice");
    for (const value of ["=SUM(A1)", "+1", "-1", "@cmd", "\tx", "\rx"]) {
      expect(usageCsvTextCell(value).replace(/^"/u, "").startsWith("'")).toBe(true);
    }
    expect(usageCsvTextCell("=HYPERLINK(\"x\",\"y\")")).toBe("\"'=HYPERLINK(\"\"x\"\",\"\"y\"\")\"");
    expect(usageCsvTextCell("a,b")).toBe("\"a,b\"");
    expect(usageCsvTextCell("line\nbreak")).toBe("\"line\nbreak\"");
    expect(usageCsvTextCell("say \"hi\"")).toBe("\"say \"\"hi\"\"\"");
  });

  it("writes exact decimal dollars", () => {
    expect(formatUsageUsd(null)).toBe("");
    expect(formatUsageUsd(0)).toBe("0.000000");
    expect(formatUsageUsd(1)).toBe("0.000001");
    expect(formatUsageUsd(12_345_678)).toBe("12.345678");
    expect(formatUsageUsd(Number.MAX_SAFE_INTEGER)).toBe("9007199254.740991");
  });

  it("names the file after the period and local date", () => {
    expect(usageExportFilename("30d", "2026-10-07")).toBe("aiqsa-usage-30d-2026-10-07.csv");
  });

  it("writes one ordered line per bucket, user, model, category and purpose", () => {
    const model = rawUsageModelKey("openrouter", "=evil");
    const lines = [...usageCsvLines({
      models: new Map(),
      rows: [
        { amounts: { ...emptyUsageAmounts(), recordCount: 1, runCount: 1, totalTokens: 7, inputTokens: 5,
          estimatedCostMicros: 1_500, knownCostRecordCount: 1 }, bucket: "2026-10", category: "chat", model, purpose: "chat_answer",
        userId: "u1" },
        { amounts: { ...emptyUsageAmounts(), recordCount: 1, totalTokens: 3 }, bucket: "2026-09", category: "system", model,
          purpose: "memory_retrieval", userId: "u1" },
        { amounts: { ...emptyUsageAmounts(), recordCount: 2 }, bucket: "2026-09", category: "system", model, purpose: "knowledge_indexing",
          userId: "u1" }
      ],
      users: new Map([["u1", { displayName: "-Mallory", email: "m@example.com", id: "u1",
        groups: [{ groupId: "g1", role: "member", group: { name: "Team, A" } }, { groupId: "g2", role: "member", group: { name: "B" } }] }]])
    })];
    expect(lines[0]).toBe("period_start,user_email,user_name,groups,category,purpose,provider,model,runs,records,input_tokens," +
      "cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_tokens,total_tokens,estimated_cost_usd,cost_known_records\r\n");
    expect(lines.slice(1)).toEqual([
      "2026-09-01,m@example.com,'-Mallory,\"Team, A; B\",system,knowledge_indexing,openrouter,'=evil,0,2,,,,,,,,0\r\n",
      "2026-09-01,m@example.com,'-Mallory,\"Team, A; B\",system,memory_retrieval,openrouter,'=evil,0,1,,,,,,3,,0\r\n",
      "2026-10-01,m@example.com,'-Mallory,\"Team, A; B\",chat,chat_answer,openrouter,'=evil,1,1,5,,,,,7,0.001500,1\r\n"
    ]);
  });
});
