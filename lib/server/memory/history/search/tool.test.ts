import { describe, expect, it } from "vitest";
import { memoryHistorySearchTool } from "./tool";

describe("Memory history search tool schema", () => {
  it("uses an OpenAI strict-compatible nullable shape for optional filters", () => {
    expect(memoryHistorySearchTool.inputSchema).toEqual({
      additionalProperties: false,
      properties: {
        chat_ids: {
          items: { maxLength: 256, minLength: 1, type: "string" },
          maxItems: 20,
          type: ["array", "null"]
        },
        cursor: { maxLength: 4096, minLength: 1, type: ["string", "null"] },
        folder_id: { maxLength: 256, minLength: 1, type: ["string", "null"] },
        query: { maxLength: 500, minLength: 1, type: "string" },
        time_range: {
          additionalProperties: false,
          properties: {
            from: { format: "date-time", type: ["string", "null"] },
            to: { format: "date-time", type: ["string", "null"] }
          },
          required: ["from", "to"],
          type: ["object", "null"]
        }
      },
      required: ["chat_ids", "cursor", "folder_id", "query", "time_range"],
      type: "object"
    });
    expect(memoryHistorySearchTool.strict).toBe(true);
  });
});
