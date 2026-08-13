import { describe, expect, it } from "vitest";
import { memoryHistorySearchTool } from "./tool";

describe("Memory history search tool schema", () => {
  it("uses an OpenAI strict-compatible nullable shape for optional filters", () => {
    expect(memoryHistorySearchTool.inputSchema).toEqual({
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        scope: {
          additionalProperties: false,
          properties: {
            target_id: { type: ["string", "null"] },
            type: {
              enum: ["GLOBAL_USER", "FOLDER", "ASSISTANT", "CHAT"],
              type: "string"
            }
          },
          required: ["target_id", "type"],
          type: ["object", "null"]
        },
        source_kinds: {
          items: { enum: ["FACT", "EVENT", "HISTORY"], type: "string" },
          type: ["array", "null"]
        },
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
      required: ["query", "scope", "source_kinds", "time_range"],
      type: "object"
    });
    expect(memoryHistorySearchTool.strict).toBe(true);
  });
});
